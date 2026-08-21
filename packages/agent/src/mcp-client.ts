/**
 * MCP client wrapper.
 *
 * Handles JSON-RPC initialization, tool discovery, and tool invocation.
 */

import type { McpTransport } from "./mcp-transport";

// ── Types ────────────────────────────────────────────────────────────────────

export type McpTool = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

export type McpTextContent = { type: "text"; text: string };
export type McpImageContent = { type: "image"; data: string; mimeType?: string };
export type McpResourceContent = { type: "resource"; resource: { uri: string; mimeType?: string; text?: string; blob?: string } };
export type McpContent = McpTextContent | McpImageContent | McpResourceContent;

export type McpToolResult = {
  content: McpContent[];
  isError?: boolean;
};

export class McpClient {
  private transport: McpTransport;
  private initialized = false;
  private serverName: string;

  constructor(serverName: string, transport: McpTransport) {
    this.serverName = serverName;
    this.transport = transport;
  }

  get name() {
    return this.serverName;
  }

  async initialize(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }

    const initResult = await this.transport.request(
      "initialize",
      {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "pace-mcp", version: "1.0.0" },
      },
      signal,
    );

    // Send initialized notification (fire-and-forget)
    try {
      this.transport.notify("notifications/initialized", {});
    } catch {
      // Some servers don't handle notifications — that's fine.
    }

    this.initialized = true;
  }

  async listTools(signal?: AbortSignal): Promise<McpTool[]> {
    if (!this.initialized) {
      throw new Error("MCP client not initialized");
    }
    const result = (await this.transport.request("tools/list", undefined, signal)) as {
      tools?: Array<{
        name?: string;
        description?: string;
        inputSchema?: Record<string, unknown>;
      }>;
    };

    const rawTools = result?.tools ?? [];
    return rawTools
      .filter((t): t is typeof t & { name: string } => typeof t.name === "string")
      .map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpToolResult> {
    if (!this.initialized) {
      throw new Error("MCP client not initialized");
    }

    const result = (await this.transport.request("tools/call", { name, arguments: args }, signal)) as {
      content?: unknown[];
      isError?: boolean;
    };

    const content: McpContent[] = [];

    for (const item of result?.content ?? []) {
      if (typeof item !== "object" || item === null) continue;
      const obj = item as Record<string, unknown>;
      const type = obj.type;
      if (type === "text" && typeof obj.text === "string") {
        content.push({ type: "text", text: obj.text });
      } else if (type === "image" && typeof obj.data === "string") {
        content.push({ type: "image", data: obj.data, mimeType: typeof obj.mimeType === "string" ? obj.mimeType : undefined });
      } else if (type === "resource" && typeof obj.resource === "object" && obj.resource !== null) {
        const res = obj.resource as Record<string, unknown>;
        content.push({
          type: "resource",
          resource: {
            uri: typeof res.uri === "string" ? res.uri : "",
            mimeType: typeof res.mimeType === "string" ? res.mimeType : undefined,
            text: typeof res.text === "string" ? res.text : undefined,
            blob: typeof res.blob === "string" ? res.blob : undefined,
          },
        });
      }
    }

    return { content, isError: result?.isError === true };
  }

  async close(): Promise<void> {
    await this.transport.close();
    this.initialized = false;
  }
}
