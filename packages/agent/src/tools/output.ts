import { createWriteStream, type WriteStream } from "fs";
import { mkdir, writeFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { getSessionId } from "../session";
import { formatToolResultBody, type ToolOutput } from "./core";

export const TOOL_OUTPUT_TRUNCATION_BYTES = 5 * 1024;
export const TOOL_OUTPUT_TRUNCATION_HEAD_BYTES = TOOL_OUTPUT_TRUNCATION_BYTES;
let toolOutputTruncationSuppressionDepth = 0;

export function shouldPersistLargeToolOutput() {
  return toolOutputTruncationSuppressionDepth === 0;
}

export async function withoutToolOutputTruncation<T>(fn: () => Promise<T>): Promise<T> {
  toolOutputTruncationSuppressionDepth += 1;
  try {
    return await fn();
  } finally {
    toolOutputTruncationSuppressionDepth -= 1;
  }
}

export async function truncateToolOutputIfNeeded(
  output: ToolOutput,
  toolName: string,
  toolUseId?: string,
): Promise<ToolOutput> {
  // Non-text blocks (e.g. images) are intentionally large — never truncate them.
  if (output.content.some((p) => p.type !== "text")) {
    return output;
  }

  const fullText = formatToolResultBody(output);
  const fullBytes = Buffer.byteLength(fullText, "utf8");

  if (fullBytes <= TOOL_OUTPUT_TRUNCATION_BYTES) {
    return output;
  }

  const outputPath = await createToolOutputPath(toolName, toolUseId);
  await writeFile(outputPath, fullText, "utf8");

  const truncatedText = buildTruncatedToolOutputText(fullText, fullBytes, outputPath);

  return {
    content: [{ type: "text", text: truncatedText }],
    ...(output.is_error && { is_error: true }),
    ...(output.cost !== undefined && { cost: output.cost }),
    ...(output.display !== undefined && { display: output.display }),
  };
}

export async function createToolOutputPath(toolName: string, toolUseId?: string): Promise<string> {
  const outputDir = getToolOutputDir();
  await mkdir(outputDir, { recursive: true });
  return join(outputDir, makeToolOutputFilename(toolName, toolUseId));
}

function getToolOutputDir(): string {
  return join(homedir(), ".pace", "tool-outputs", getSessionId());
}

function makeToolOutputFilename(toolName: string, toolUseId?: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safeToolName = toolName.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80) || "tool";
  const safeToolUseId = toolUseId?.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
  const suffix = safeToolUseId ? `-${safeToolUseId}` : `-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  return `${timestamp}-${safeToolName}${suffix}.txt`;
}

function buildTruncatedToolOutputText(fullText: string, fullBytes: number, outputPath: string): string {
  return buildTruncatedToolOutputFromHead(fullText, fullBytes, outputPath);
}

export function buildTruncatedToolOutputFromHead(
  headText: string,
  fullBytes: number,
  outputPath: string,
): string {
  const headBytes = chooseTruncatedHeadBytes(fullBytes, outputPath);
  const omittedBytes = Math.max(0, fullBytes - headBytes);
  const marker = buildToolOutputTruncationMarker(omittedBytes, outputPath);
  return `${truncateUtf8Prefix(headText, headBytes)}${marker}`;
}

function chooseTruncatedHeadBytes(fullBytes: number, outputPath: string): number {
  let headBytes = TOOL_OUTPUT_TRUNCATION_HEAD_BYTES;

  for (let i = 0; i < 3; i++) {
    const omittedBytes = Math.max(0, fullBytes - headBytes);
    const markerBytes = Buffer.byteLength(buildToolOutputTruncationMarker(omittedBytes, outputPath), "utf8");
    const availableBytes = Math.max(0, TOOL_OUTPUT_TRUNCATION_BYTES - markerBytes);
    const nextHeadBytes = Math.min(TOOL_OUTPUT_TRUNCATION_HEAD_BYTES, availableBytes);
    if (nextHeadBytes === headBytes) break;
    headBytes = nextHeadBytes;
  }

  return headBytes;
}

function buildToolOutputTruncationMarker(omittedBytes: number, outputPath: string): string {
  return (
    `\n\n[Tool output truncated. Full output saved to ${outputPath}. ` +
    `Omitted ${formatByteCount(omittedBytes)}. ` +
    `Use the 'read' tool to read the full untruncated output.]\n`
  );
}

function formatByteCount(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib.toFixed(1)} KiB`;
  return `${(kib / 1024).toFixed(1)} MiB`;
}

export function truncateUtf8Prefix(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;

  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, mid), "utf8") <= maxBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  return trimDanglingHighSurrogate(text.slice(0, low));
}

function trimDanglingHighSurrogate(text: string): string {
  if (text.length === 0) return text;
  const code = text.charCodeAt(text.length - 1);
  return code >= 0xd800 && code <= 0xdbff ? text.slice(0, -1) : text;
}

export function finishWriteStream(stream: WriteStream): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.once("error", reject);
    stream.end(() => resolve());
  });
}
