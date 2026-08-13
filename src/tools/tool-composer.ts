import { spawn } from "child_process";
import { mkdir, readFile, stat, writeFile } from "fs/promises";
import { dirname } from "path";
import { z } from "zod";
import {
  defineTool,
  formatToolResultBody,
  isAbortError,
  throwIfAborted,
  tools,
  type ToolOutput,
} from "./core";
import { withoutToolOutputTruncation } from "./output";
import { expandHomePath } from "./path";

// ─── Script Runner ─────────────────────────────────────────────────────────

const SCRIPT_DEFAULT_TIMEOUT = 60_000;
const SCRIPT_MAX_TIMEOUT = 300_000;
const SCRIPT_DEFAULT_MAX_TOOL_CALLS = 100;
const SCRIPT_MAX_TOOL_CALLS = 500;
const SCRIPT_MAX_LOG_BYTES = 64 * 1024;
const SCRIPT_MAX_LOG_MESSAGE_LENGTH = 50;
const SCRIPT_MAX_STDERR_BYTES = 64 * 1024;
const SCRIPT_MAX_RESULT_BYTES = 128 * 1024;
const SCRIPT_MAX_FILE_BYTES = 50 * 1024 * 1024;
const REQUIRED_MAIN_SIGNATURE = "async function main({ ctx, tools, args, log })";
const REQUIRED_MAIN_FUNCTION_PATTERN = /(^|\s)async function main\(\{ ctx, tools, args, log \}\)\s*\{/;

export const toolComposerTool = defineTool({
  name: "tool_composer",
  description:
    "Run a JavaScript script that can call Pace tools internally without adding intermediate results to the conversation. " +
    "Use this for complex multi-step tasks, base64 binary file handling, repeated tool calls, or workflows where only a concise final result should be returned to the model. " +
    "The code must define exactly `async function main({ ctx, tools, args, log }) { ... }`; do not provide only the function body or any other signature. Use `return` inside `main` for the final result. " +
    "Available APIs: `await tools.<toolName>(input)` returns text and throws on tool errors; `await ctx.callToolRaw(name, input)` returns `{ content, text, isError }`; " +
    "`ctx.readFileText(path)`, `ctx.readFileBase64(path)`, `ctx.writeFileText(path, content)`, and `ctx.writeFileBase64(path, base64Content)` handle local files. " +
    "Use `log(...)` only for short local progress logs. Each log message is truncated to 50 characters and total logs are capped at 64 KB. " +
    "Logs are shown in the UI but are not returned to the model unless your final return value includes them.",
  concurrency: "exclusive",
  inputSchema: z.object({
    language: z.enum(["javascript"]).default("javascript").describe("Script language. Currently only javascript is supported."),
    code: z.string().describe("Complete JavaScript code that defines exactly `async function main({ ctx, tools, args, log }) { ... }`. Do not provide only the function body or any other signature. Use return inside main for the final result."),
    args: z.record(z.string(), z.unknown()).optional().describe("Optional JSON-serializable arguments available to the script as `args`."),
    allowedTools: z.array(z.string()).optional().describe("Optional allowlist of Pace tool names the script may call. If omitted, all tools except `tool_composer` and `agent` are available."),
    timeoutSeconds: z.number().int().positive().max(300).optional().describe("Maximum runtime in seconds. Defaults to 60, max 300."),
    maxToolCalls: z.number().int().positive().max(SCRIPT_MAX_TOOL_CALLS).optional().describe("Maximum number of internal Pace tool calls. Defaults to 100, max 500."),
  }),
  titleFormatter: (input) => {
    const lines = typeof input.code === "string" ? input.code.split(/\r?\n/).length : 0;
    return `tool_composer: ${input.language ?? "javascript"}${lines > 0 ? `, ${lines} line${lines === 1 ? "" : "s"}` : ""}`;
  },
  execute: async (input, signal): Promise<ToolOutput> => {
    throwIfAborted(signal);
    return runJavascriptScript({
      code: input.code,
      args: input.args ?? {},
      allowedTools: input.allowedTools,
      timeoutMs: Math.min((input.timeoutSeconds ?? SCRIPT_DEFAULT_TIMEOUT / 1000) * 1000, SCRIPT_MAX_TIMEOUT),
      maxToolCalls: Math.min(input.maxToolCalls ?? SCRIPT_DEFAULT_MAX_TOOL_CALLS, SCRIPT_MAX_TOOL_CALLS),
      signal,
    });
  },
});

type ScriptRunOptions = {
  code: string;
  args: Record<string, unknown>;
  allowedTools?: string[];
  timeoutMs: number;
  maxToolCalls: number;
  signal?: AbortSignal;
};

type ScriptChildMessage =
  | { type: "ready" }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "helper_call"; id: string; name: string; input: unknown }
  | { type: "log"; text: string }
  | { type: "final"; result: string }
  | { type: "error"; message: string; stack?: string };

function makeScriptChildSource(): string {
  return String.raw`
const readline = require("readline");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const pending = new Map();
let initResolve;
const initPromise = new Promise((resolve) => { initResolve = resolve; });

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function stringify(value) {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function log(...parts) {
  send({ type: "log", text: parts.map(stringify).join(" ") });
}

console.log = (...parts) => log(...parts);
console.info = (...parts) => log(...parts);
console.warn = (...parts) => log(...parts);
console.error = (...parts) => log(...parts);

rl.on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.type === "init") {
    initResolve(message);
    return;
  }
  if (message.type === "response") {
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.ok) entry.resolve(message.result);
    else entry.reject(new Error(message.error || "Script host request failed"));
  }
});

let sequence = 0;
function request(type, payload) {
  const id = "req_" + (++sequence);
  send({ ...payload, type, id });
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
  });
}

function callToolRaw(name, input) {
  return request("tool_call", { name, input });
}

const tools = new Proxy({}, {
  get(_target, property) {
    if (property === "then" || typeof property !== "string") return undefined;
    return async (input = {}) => {
      const result = await callToolRaw(property, input);
      if (result.isError) {
        throw new Error(result.text || ("Tool " + property + " returned an error"));
      }
      return result.text;
    };
  },
});

const ctx = {
  callToolRaw,
  readFileText: (path) => request("helper_call", { name: "readFileText", input: { path } }),
  readFileBase64: (path) => request("helper_call", { name: "readFileBase64", input: { path } }),
  writeFileText: (path, content) => request("helper_call", { name: "writeFileText", input: { path, content } }),
  writeFileBase64: (path, base64Content) => request("helper_call", { name: "writeFileBase64", input: { path, base64Content } }),
};

(async () => {
  try {
    send({ type: "ready" });
    const init = await initPromise;
    const source = init.code + "\n;return await main({ ctx, tools, args, log });";
    const fn = new AsyncFunction("ctx", "tools", "args", "log", source);
    const value = await fn(ctx, tools, init.args || {}, log);
    send({ type: "final", result: value === undefined ? "" : stringify(value) });
  } catch (error) {
    send({
      type: "error",
      message: error && error.message ? String(error.message) : String(error),
      stack: error && error.stack ? String(error.stack) : undefined,
    });
  } finally {
    rl.close();
    process.stdout.write("", () => process.exit(0));
  }
})();
`;
}

async function runJavascriptScript(options: ScriptRunOptions): Promise<ToolOutput> {
  const mainValidationError = validateScriptMainFunction(options.code);
  if (mainValidationError) {
    return {
      content: [{ type: "text", text: buildScriptOutput(options.code, [], mainValidationError) }],
      is_error: true,
    };
  }

  const child = spawn(process.execPath, ["-e", makeScriptChildSource()], {
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const allowedToolSet = options.allowedTools ? new Set(options.allowedTools) : undefined;
  const logs: string[] = [];
  let logBytes = 0;
  let stderr = "";
  let stderrBytes = 0;
  let toolCallCount = 0;
  let settled = false;
  let ready = false;
  let stdoutBuffer = "";

  const appendLog = (text: string) => {
    const line = truncateLogMessage(text.trimEnd());
    const bytes = Buffer.byteLength(line, "utf8") + 1;
    if (logBytes + bytes <= SCRIPT_MAX_LOG_BYTES) {
      logs.push(line);
      logBytes += bytes;
    } else if (logs.at(-1) !== "[logs truncated]") {
      logs.push("[logs truncated]");
    }
  };

  const killTree = () => {
    if (child.pid) {
      try { process.kill(-child.pid, "SIGTERM"); } catch {}
    }
    child.kill("SIGTERM");
  };

  const sendResponse = (id: string, response: { ok: boolean; result?: unknown; error?: string }) => {
    if (!child.stdin.destroyed) {
      child.stdin.write(JSON.stringify({ type: "response", id, ...response }) + "\n");
    }
  };

  const executeInternalTool = async (message: Extract<ScriptChildMessage, { type: "tool_call" }>) => {
    try {
      if (message.name === "tool_composer") {
        throw new Error("tool_composer may not call itself recursively");
      }
      // Enforce the depth-1 rule: subagents cannot spawn subagents, and
      // tool_composer must not be a backdoor around it.
      if (message.name === "agent") {
        throw new Error("The agent tool is not available inside tool_composer scripts");
      }
      const toolToExecute = tools.find((tool) => tool.name === message.name);
      if (!toolToExecute) {
        throw new Error(`Unknown tool: ${message.name}`);
      }
      if (allowedToolSet && !allowedToolSet.has(message.name)) {
        throw new Error(`Tool ${message.name} is not allowed by this script`);
      }
      toolCallCount += 1;
      if (toolCallCount > options.maxToolCalls) {
        throw new Error(`Script exceeded maxToolCalls (${options.maxToolCalls})`);
      }
      const parsed = toolToExecute.inputSchema.safeParse(message.input);
      if (!parsed.success) {
        throw new Error(`Input for ${message.name} did not match schema: ${JSON.stringify(parsed.error.issues)}`);
      }
      const output = await withoutToolOutputTruncation(() => toolToExecute.execute(parsed.data, options.signal));
      const text = formatToolResultBody(output);
      sendResponse(message.id, {
        ok: true,
        result: {
          content: output.content,
          text,
          isError: output.is_error === true,
        },
      });
    } catch (error) {
      if (isAbortError(error)) {
        sendResponse(message.id, { ok: false, error: "Script aborted" });
        return;
      }
      sendResponse(message.id, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  };

  const executeHelper = async (message: Extract<ScriptChildMessage, { type: "helper_call" }>) => {
    try {
      const input = message.input && typeof message.input === "object" ? message.input as Record<string, unknown> : {};
      const rawPath = input.path;
      if (typeof rawPath !== "string" || rawPath.length === 0) {
        throw new Error(`${message.name} requires a non-empty path`);
      }
      const filePath = expandHomePath(rawPath);

      switch (message.name) {
        case "readFileText": {
          const fileStat = await stat(filePath);
          if (fileStat.size > SCRIPT_MAX_FILE_BYTES) throw new Error(`File exceeds ${SCRIPT_MAX_FILE_BYTES} byte limit`);
          sendResponse(message.id, { ok: true, result: await readFile(filePath, "utf8") });
          return;
        }
        case "readFileBase64": {
          const fileStat = await stat(filePath);
          if (fileStat.size > SCRIPT_MAX_FILE_BYTES) throw new Error(`File exceeds ${SCRIPT_MAX_FILE_BYTES} byte limit`);
          const data = await readFile(filePath);
          sendResponse(message.id, { ok: true, result: data.toString("base64") });
          return;
        }
        case "writeFileText": {
          if (typeof input.content !== "string") throw new Error("writeFileText requires string content");
          await mkdir(dirname(filePath), { recursive: true });
          await writeFile(filePath, input.content, "utf8");
          sendResponse(message.id, { ok: true, result: "Wrote file" });
          return;
        }
        case "writeFileBase64": {
          if (typeof input.base64Content !== "string") throw new Error("writeFileBase64 requires string base64Content");
          const data = Buffer.from(input.base64Content, "base64");
          if (data.byteLength > SCRIPT_MAX_FILE_BYTES) throw new Error(`File exceeds ${SCRIPT_MAX_FILE_BYTES} byte limit`);
          await mkdir(dirname(filePath), { recursive: true });
          await writeFile(filePath, data);
          sendResponse(message.id, { ok: true, result: "Wrote file" });
          return;
        }
        default:
          throw new Error(`Unknown helper: ${message.name}`);
      }
    } catch (error) {
      sendResponse(message.id, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  };

  const handleMessage = (message: ScriptChildMessage) => {
    switch (message.type) {
      case "ready": {
        ready = true;
        child.stdin.write(JSON.stringify({ type: "init", code: options.code, args: options.args }) + "\n");
        break;
      }
      case "tool_call": {
        void executeInternalTool(message);
        break;
      }
      case "helper_call": {
        void executeHelper(message);
        break;
      }
      case "log": {
        appendLog(message.text);
        break;
      }
      case "final": {
        settled = true;
        killTimer();
        cleanupAbort();
        const finalText = truncateText(message.result, SCRIPT_MAX_RESULT_BYTES, "script result");
        resolveRun({ content: [{ type: "text", text: buildScriptOutput(options.code, logs, finalText) }] });
        break;
      }
      case "error": {
        settled = true;
        killTimer();
        cleanupAbort();
        const errorText = `Script failed: ${message.message}`;
        resolveRun({
          content: [{ type: "text", text: buildScriptOutput(options.code, logs, `${errorText}${message.stack ? `\n\n${truncateText(message.stack, 4096, "stack")}` : ""}`) }],
          is_error: true,
        });
        break;
      }
    }
  };

  let resolveRun!: (output: ToolOutput) => void;
  const runPromise = new Promise<ToolOutput>((resolve) => { resolveRun = resolve; });

  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    cleanupAbort();
    killTree();
    const message = `Script timed out after ${Math.floor(options.timeoutMs / 1000)} seconds`;
    resolveRun({
      content: [{ type: "text", text: buildScriptOutput(options.code, logs, message) }],
      is_error: true,
    });
  }, options.timeoutMs);

  const killTimer = () => clearTimeout(timer);

  const onAbort = () => {
    if (settled) return;
    settled = true;
    killTimer();
    cleanupAbort();
    killTree();
    resolveRun({ content: [{ type: "text", text: buildScriptOutput(options.code, logs, "Script aborted") }], is_error: true });
  };
  if (options.signal) options.signal.addEventListener("abort", onAbort, { once: true });
  const cleanupAbort = () => options.signal?.removeEventListener("abort", onAbort);

  child.stdout.on("data", (data: Buffer) => {
    stdoutBuffer += data.toString("utf8");
    let newlineIndex: number;
    while ((newlineIndex = stdoutBuffer.indexOf("\n")) >= 0) {
      const line = stdoutBuffer.slice(0, newlineIndex);
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      if (!line.trim()) continue;
      try {
        handleMessage(JSON.parse(line) as ScriptChildMessage);
      } catch {
        appendLog(line);
      }
    }
  });

  child.stderr.on("data", (data: Buffer) => {
    const chunk = data.toString("utf8");
    const bytes = Buffer.byteLength(chunk, "utf8");
    if (stderrBytes + bytes <= SCRIPT_MAX_STDERR_BYTES) {
      stderr += chunk;
      stderrBytes += bytes;
    }
  });

  child.on("error", (error) => {
    if (settled) return;
    settled = true;
    killTimer();
    cleanupAbort();
    resolveRun({ content: [{ type: "text", text: buildScriptOutput(options.code, logs, `Script process failed: ${error.message}`) }], is_error: true });
  });

  child.on("close", (code) => {
    if (settled) return;
    settled = true;
    killTimer();
    cleanupAbort();
    const detail = stderr.trim() ? `\n\nStderr:\n${stderr.trim()}` : "";
    const message = ready
      ? `Script process exited before returning a result${code === null ? "" : ` (code ${code})`}${detail}`
      : `Script process exited before it was ready${code === null ? "" : ` (code ${code})`}${detail}`;
    resolveRun({ content: [{ type: "text", text: buildScriptOutput(options.code, logs, message) }], is_error: true });
  });

  const output = await runPromise;
  return output;
}

function validateScriptMainFunction(code: string): string | undefined {
  if (REQUIRED_MAIN_FUNCTION_PATTERN.test(code)) return undefined;
  return `Script must define exactly \`${REQUIRED_MAIN_SIGNATURE} { ... }\`. Do not provide only a function body or a differently shaped main function.`;
}

function truncateText(text: string, maxBytes: number, label: string): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let truncated = text;
  while (Buffer.byteLength(truncated, "utf8") > maxBytes && truncated.length > 0) {
    truncated = truncated.slice(0, Math.floor(truncated.length * 0.9));
  }
  return `${truncated}\n[${label} truncated to ${maxBytes} bytes]`;
}

function truncateLogMessage(text: string): string {
  if (text.length <= SCRIPT_MAX_LOG_MESSAGE_LENGTH) return text;
  return `${text.slice(0, SCRIPT_MAX_LOG_MESSAGE_LENGTH)}…`;
}

function buildScriptOutput(code: string, logs: string[], result: string): string {
  const sections = [`Script:\n\`\`\`javascript\n${code}\n\`\`\``];
  const visibleLogs = logs.filter((line) => line.length > 0);
  if (visibleLogs.length > 0) {
    sections.push(`Logs:\n${visibleLogs.join("\n")}`);
  }
  sections.push(`Result:\n${result}`);
  return sections.join("\n\n");
}
