/**
 * MCP transport layer.
 *
 * Handles JSON-RPC 2.0 over stdio and HTTP.
 */

import { spawn, type ChildProcess } from "child_process";
import { fetchWithRetry } from "@pace/llm";

// ── Types ────────────────────────────────────────────────────────────────────

export interface McpTransport {
  request(method: string, params?: unknown, signal?: AbortSignal): Promise<unknown>;
  notify(method: string, params?: unknown): void;
  close(): void | Promise<void>;
}

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

let nextId = 1;
export function makeJsonRpcRequest(method: string, params?: unknown): JsonRpcRequest {
  return { jsonrpc: "2.0", id: nextId++, method, params };
}

export function makeJsonRpcNotification(method: string, params?: unknown): { jsonrpc: "2.0"; method: string; params?: unknown } {
  return { jsonrpc: "2.0", method, params };
}

export function parseJsonRpcResponse(text: string): JsonRpcResponse {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error("Empty JSON-RPC response");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error(`Invalid JSON in RPC response: ${trimmed.slice(0, 200)}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("JSON-RPC response is not an object");
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.jsonrpc !== "2.0") {
    throw new Error("JSON-RPC response missing jsonrpc field");
  }
  if (typeof obj.id !== "number" && typeof obj.id !== "string") {
    throw new Error("JSON-RPC response missing id field");
  }
  if ("error" in obj && obj.error) {
    const err = obj.error as { code?: number; message?: string; data?: unknown };
    throw new Error(`JSON-RPC error ${err.code ?? "?"}: ${err.message ?? "unknown"}`);
  }
  return obj as unknown as JsonRpcResponse;
}

// ── Stdio Transport ────────────────────────────────────────────────────────

export class McpStdioTransport implements McpTransport {
  private child: ChildProcess;
  private pending = new Map<
    number | string,
    { resolve: (value: unknown) => void; reject: (reason: Error) => void }
  >();
  private buffer = "";
  private closed = false;
  private onAbort?: () => void;

  constructor(command: string[], env?: Record<string, string>) {
    this.child = spawn(command[0], command.slice(1), {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child.stdout?.setEncoding("utf8");
    this.child.stdout?.on("data", (chunk: string) => {
      this.buffer += chunk;
      this.flushBuffer();
    });

    this.child.stderr?.on("data", (chunk: Buffer) => {
      // Suppress noisy stderr; only surface on request failure if needed.
      // Future enhancement: capture last N bytes of stderr for error diagnostics.
      void chunk;
    });

    this.child.on("error", (err: Error) => {
      this.rejectAllPending(err);
    });

    this.child.on("close", (code: number | null) => {
      if (code !== 0 && code !== null) {
        this.rejectAllPending(new Error(`MCP stdio process exited with code ${code}`));
      }
    });
  }

  private flushBuffer() {
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as JsonRpcResponse;
        const pending = this.pending.get(parsed.id);
        if (pending) {
          this.pending.delete(parsed.id);
          if (parsed.error) {
            pending.reject(new Error(`JSON-RPC error ${parsed.error.code}: ${parsed.error.message}`));
          } else {
            pending.resolve(parsed.result);
          }
        }
      } catch {
        // Ignore non-JSON lines
      }
    }
  }

  private rejectAllPending(reason: Error) {
    const copy = new Map(this.pending);
    this.pending.clear();
    for (const [, { reject }] of copy) {
      reject(reason);
    }
  }

  async request(method: string, params?: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.closed) {
      throw new Error("MCP transport is closed");
    }
    if (signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }

    const req = makeJsonRpcRequest(method, params);
    const line = JSON.stringify(req) + "\n";

    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(req.id, { resolve, reject });

      if (signal) {
        this.onAbort = () => {
          this.pending.delete(req.id);
          reject(new DOMException("Aborted", "AbortError"));
          this.close();
        };
        signal.addEventListener("abort", this.onAbort, { once: true });
      }

      this.child.stdin?.write(line, (err) => {
        if (err) {
          this.pending.delete(req.id);
          if (signal && this.onAbort) {
            signal.removeEventListener("abort", this.onAbort);
          }
          reject(err);
        }
      });
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    const line = JSON.stringify(makeJsonRpcNotification(method, params)) + "\n";
    this.child.stdin?.write(line);
  }

  close(): void {
    this.closed = true;
    if (this.child.pid) {
      try {
        process.kill(-this.child.pid, "SIGTERM");
      } catch {}
    }
    this.child.kill("SIGTERM");
    this.rejectAllPending(new Error("MCP transport closed"));
  }
}

// ── SSE helpers ──────────────────────────────────────────────────────────────

/**
 * Parse an SSE (Server-Sent Events) response body and extract the
 * JSON-RPC object whose `id` matches the request.
 */
function parseSsePayload(text: string, requestId: number | string): JsonRpcResponse {
  const lines = text.split(/\r?\n/);
  const dataLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("data: ")) {
      const payload = trimmed.slice(6).trim();
      if (payload && payload !== "[DONE]") {
        dataLines.push(payload);
      }
    }
  }

  // Try each data line — find the one matching our request id
  for (const data of dataLines) {
    try {
      const parsed = JSON.parse(data) as JsonRpcResponse;
      if (parsed.id === requestId) {
        return parsed;
      }
    } catch {
      // Not valid JSON-RPC, skip
    }
  }

  // Fallback: if only one data line, accept it regardless of id
  if (dataLines.length === 1) {
    return parseJsonRpcResponse(dataLines[0]);
  }

  throw new Error("No matching JSON-RPC response found in SSE stream");
}

// ── HTTP Transport ───────────────────────────────────────────────────────────

export class McpHttpTransport implements McpTransport {
  constructor(
    private url: string,
    private headers?: Record<string, string>,
  ) {}

  async request(method: string, params?: unknown, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }

    const req = makeJsonRpcRequest(method, params);

    const response = await fetchWithRetry(
      this.url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          ...this.headers,
        },
        body: JSON.stringify(req),
        signal,
      },
      signal,
    );

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`MCP HTTP request failed with status ${response.status}: ${text.slice(0, 500)}`);
    }

    const contentType = response.headers.get("content-type") ?? "";
    const isSse = contentType.includes("text/event-stream") || text.trimStart().startsWith("event:");

    let parsed: JsonRpcResponse;
    if (isSse) {
      parsed = parseSsePayload(text, req.id);
    } else {
      parsed = parseJsonRpcResponse(text);
    }

    if (parsed.error) {
      throw new Error(`JSON-RPC error ${parsed.error.code}: ${parsed.error.message}`);
    }
    return parsed.result;
  }

  notify(method: string, params?: unknown): void {
    // HTTP notifications are just fire-and-forget POSTs without awaiting.
    void (async () => {
      try {
        const req = makeJsonRpcNotification(method, params);
        await fetch(this.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            ...this.headers,
          },
          body: JSON.stringify(req),
        });
      } catch {
        // Best-effort — ignore notification failures.
      }
    })();
  }

  async close(): Promise<void> {
    // Stateless HTTP — nothing to close.
  }
}
