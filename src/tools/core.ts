import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { parse } from "partial-json";

export function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export type ToolOutput = {
  content: Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam | Anthropic.SearchResultBlockParam | Anthropic.DocumentBlockParam | Anthropic.ToolReferenceBlockParam>;
  is_error?: boolean;
  /**
   * Optional cost incurred by this tool call (e.g. subagent model usage).
   * The caller adds it to the session total and persists it in the
   * tool_result session entry. Tools that invoke models or paid services
   * should report their cost here.
   */
  cost?: number;
  /**
   * Optional user-facing body for the TUI. When set, the live tool block
   * and session replay show this string instead of `content`. The model
   * still receives `content` only.
   */
  display?: string;
}

export type ToolDisplayBlock = {
  title?: string;
  content: string;
}

export type ToolExecutionContext = {
  /**
   * Called by tools that can produce incremental user-visible output while
   * they are still running. The final ToolOutput remains the source of truth
   * for what is sent back to the model.
   */
  onOutput?: (content: string) => void;
  /**
   * Like onOutput, but each call replaces the entire visible content instead
   * of appending. For tools that manage their own full text (e.g. subagent
   * progress lines). The final ToolOutput remains the source of truth.
   */
  onContent?: (content: string) => void;
}

type ZodObjectSchema = z.ZodObject<z.core.$ZodShape>;

export type ToolConcurrency = "safe" | "exclusive";

export type ToolDescriptor<T extends ZodObjectSchema = ZodObjectSchema> = {
  name: string;
  description: string;
  inputSchema: T;
  execute: (input: z.infer<T>, signal?: AbortSignal, context?: ToolExecutionContext) => Promise<ToolOutput>;
  concurrency?: ToolConcurrency;
  titleFormatter?: (input: Partial<z.infer<T>>) => string;
  /**
   * When false, the tool's result body is hidden in the TUI; the block shows
   * only its title and state glyph. The body is still sent to the model
   * verbatim. Errors are always shown regardless of this flag. Defaults to true.
   */
  showContent?: boolean;
  /**
   * When false, the generic tool-result truncation pass is skipped and the
   * tool's output is sent to the model verbatim. Defaults to true.
   */
  truncateOutput?: boolean;
}

export const tools: ToolDescriptor[] = [];

export function registerTool<T extends ZodObjectSchema>(definition: ToolDescriptor<T>) {
  if (tools.some(tool => tool.name === definition.name)) {
    throw new Error(`Duplicate tool name: "${definition.name}" is already registered`);
  }

  tools.push(definition as ToolDescriptor);
  return definition;
}

/** Remove a previously registered tool by name. Returns false if not found. */
export function unregisterTool(name: string): boolean {
  const index = tools.findIndex((tool) => tool.name === name);
  if (index === -1) {
    return false;
  }
  tools.splice(index, 1);
  return true;
}

export function defineTool<T extends ZodObjectSchema>(definition: ToolDescriptor<T>) {
  return definition;
}

export function visualizeToolTitle(toolName: string, input: unknown): string {
  const tool = tools.find((candidate) => candidate.name === toolName);
  if (tool?.titleFormatter && input && typeof input === "object") {
    try {
      return oneLine(tool.titleFormatter(input as never));
    } catch {
      // fall through to generic
    }
  }
  return oneLine(`${toolName}: ${defaultInputSummary(input)}`);
}

export function visualizeToolPartialTitle(toolName: string, jsonString: string): string {
  let parsed: unknown = {};
  try {
    parsed = parsePartialJson(jsonString);
  } catch {
    parsed = {};
  }
  return visualizeToolTitle(toolName, parsed);
}

export function formatToolResultBody(output: ToolOutput): string {
  return formatToolOutput(output).trimEnd();
}

function defaultInputSummary(input: unknown): string {
  if (input === null || input === undefined) return "";
  if (typeof input === "string") return input;
  if (typeof input !== "object") return String(input);
  const obj = input as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 0) return "";
  // Prefer common "path" or "command" keys
  for (const preferred of ["command", "path", "file", "name"]) {
    if (typeof obj[preferred] === "string") return obj[preferred] as string;
  }
  // Fall back to first string value
  for (const key of keys) {
    if (typeof obj[key] === "string") return obj[key] as string;
  }
  return JSON.stringify(input);
}

function oneLine(text: string): string {
  return String(text).replace(/\s+/g, " ").trim();
}

function parsePartialJson(jsonString: string): unknown {
  if (jsonString.length === 0) {
    return {};
  }

  return parse(jsonString);
}

function formatToolOutput(toolOutput: ToolOutput) {
  return toolOutput.content
    .map((part) => {
      if (part.type === "text") {
        return part.text;
      }

      return `[${part.type}] ${JSON.stringify(part, null, 2)}`;
    })
    .join("\n\n");
}
