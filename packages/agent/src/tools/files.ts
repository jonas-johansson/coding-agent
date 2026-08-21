import { mkdir, readFile, stat, writeFile } from "fs/promises";
import { dirname, extname } from "path";
import { z } from "zod";
import { defineTool, throwIfAborted, type ToolOutput } from "./core";
import { formatReplacementDiff, wrapDiffFence } from "./diff";
import { checkFileState, recordFileState } from "./file-state";
import { expandHomePath, normalizePath } from "./path";

/** Maximum raw image file size accepted by the read tool (matches Anthropic's per-image limit). */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Supported image extensions and their MIME types. */
const IMAGE_MEDIA_TYPES: Record<string, "image/jpeg" | "image/png" | "image/gif" | "image/webp"> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/** Maximum number of lines returned per read call when no explicit limit is provided. */
const DEFAULT_READ_LIMIT = 2000;
/** Individual lines longer than this are truncated to keep output manageable. */
const MAX_LINE_LENGTH = 2000;
const MAX_LINE_SUFFIX = `… (truncated to ${MAX_LINE_LENGTH} chars)`;
/** Hard cap on total output size in bytes. Stops collecting lines early if
 *  the accumulated output would exceed this, regardless of the line limit. */
const MAX_READ_BYTES = 50 * 1024;
const MAX_READ_BYTES_LABEL = `${MAX_READ_BYTES / 1024}KB`;

export const readTool = defineTool({
  name: "read",
  description: "Read content from a file at a specified path. Contents are returned with each line prefixed by its line number. This tool can read image files and return them as file attachments.",
  concurrency: "safe",
  inputSchema: z.object({
    path: z.string().describe("Absolute or relative file path."),
    offset: z.number().int().min(1).optional().describe("Line number to start reading from (1-indexed). Defaults to 1."),
    limit: z.number().int().positive().optional().describe("Maximum number of lines to read. Defaults to 2000."),
  }),
  titleFormatter: (input) => {
    const pathPart = input.path ? normalizePath(input.path) : "";
    if (input.offset != null || input.limit != null) {
      const offsetStr = input.offset != null ? `offset=${input.offset}` : "";
      const limitStr = input.limit != null ? `limit=${input.limit}` : "";
      const suffix = [offsetStr, limitStr].filter(Boolean).join(", ");
      return `read: ${pathPart} (${suffix})`;
    }
    return `read: ${pathPart}`;
  },
  showContent: false,
  truncateOutput: false,
  execute: async (input, signal): Promise<ToolOutput> => {
    throwIfAborted(signal);
    const filePath = expandHomePath(input.path);

    // Detect image files and return them as image blocks for vision-capable models.
    const imageMediaType = IMAGE_MEDIA_TYPES[extname(filePath).toLowerCase()];
    if (imageMediaType) {
      const fileStat = await stat(filePath);
      if (fileStat.size > MAX_IMAGE_BYTES) {
        return {
          content: [{ type: "text", text: `Image file too large to read (${(fileStat.size / (1024 * 1024)).toFixed(1)} MB). Maximum size is ${MAX_IMAGE_BYTES / (1024 * 1024)} MB.` }],
          is_error: true,
        };
      }
      const data = await readFile(filePath);
      recordFileState(filePath, data);
      return {
        content: [{ type: "image", mediaType: imageMediaType, data: data.toString("base64") }],
      };
    }

    const fileBytes = await readFile(filePath);
    recordFileState(filePath, fileBytes);
    const fullText = fileBytes.toString("utf8");
    const allLines = fullText.split("\n");
    const totalLines = allLines.length;

    const offset = input.offset ?? 1;
    const limit = input.limit ?? DEFAULT_READ_LIMIT;
    const start = offset - 1; // convert 1-indexed to 0-indexed

    if (start >= totalLines && totalLines > 0) {
      return {
        content: [{ type: "text", text: `Offset ${offset} is beyond end of file (${totalLines} lines).` }],
        is_error: true,
      };
    }

    const candidateLines = allLines.slice(start, start + limit);
    const numbered: string[] = [];
    let bytes = 0;
    let truncatedByBytes = false;

    for (let i = 0; i < candidateLines.length; i++) {
      const lineNum = start + i + 1;
      const truncatedLine = candidateLines[i].length > MAX_LINE_LENGTH
        ? candidateLines[i].substring(0, MAX_LINE_LENGTH) + MAX_LINE_SUFFIX
        : candidateLines[i];
      const formatted = `${lineNum}: ${truncatedLine}`;
      const lineBytes = Buffer.byteLength(formatted, "utf8") + (numbered.length > 0 ? 1 : 0); // +1 for newline separator
      if (bytes + lineBytes > MAX_READ_BYTES) {
        truncatedByBytes = true;
        break;
      }
      bytes += lineBytes;
      numbered.push(formatted);
    }

    let text = numbered.join("\n");

    const endLine = start + numbered.length;
    const hasMore = endLine < totalLines;

    if (truncatedByBytes) {
      text += `\n\n(Output capped at ${MAX_READ_BYTES_LABEL}. Showing lines ${offset}-${endLine} of ${totalLines}. Use offset=${endLine + 1} to continue.)`;
    } else if (hasMore) {
      text += `\n\n(Showing lines ${offset}-${endLine} of ${totalLines}. Use offset=${endLine + 1} to continue.)`;
    } else {
      text += `\n\n(${totalLines} lines)`;
    }

    return {
      content: [{ type: "text", text }]
    };
  }
});

export const writeTool = defineTool({
  name: "write",
  description: "Write content to a file.",
  concurrency: "exclusive",
  inputSchema: z.object({
    path: z.string(),
    content: z.string()
  }),
  titleFormatter: (input) => `write: ${input.path ? normalizePath(input.path) : ""}`,
  showContent: false,
  execute: async (input, signal): Promise<ToolOutput> => {
    throwIfAborted(signal);
    const filePath = expandHomePath(input.path);

    // Overwriting an existing file requires a fresh snapshot from a prior
    // read, write, or edit, so external changes are never silently clobbered.
    let existingBytes: Buffer | null = null;
    try {
      existingBytes = await readFile(filePath);
    } catch (error) {
      if ((error as { code?: string }).code !== "ENOENT") throw error;
    }
    if (existingBytes !== null) {
      const freshness = checkFileState(filePath, existingBytes);
      // Disabled: the unread check is intentionally skipped so the model can
      // write a file it already knows the content of without a prior read.
      // if (freshness === "unread") {
      //   return {
      //     content: [{ type: "text", text: `File has not been read yet in this session: ${input.path}. Read it before overwriting.` }],
      //     is_error: true,
      //   };
      // }
      if (freshness === "stale") {
        return {
          content: [{ type: "text", text: `File has been modified externally since it was last read, written, or edited: ${input.path}. Read it again before overwriting.` }],
          is_error: true,
        };
      }
    }

    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, input.content);
    recordFileState(filePath, input.content);
    return {
      content: [{ type: "text", text: `Wrote file` }]
    }
  }
});

export const editTool = defineTool({
  name: "edit",
  description: "Edit a file by replacing exact text.",
  concurrency: "exclusive",
  inputSchema: z.object({
    path: z.string(),
    oldText: z.string().describe("Old text to find and replace (must match exactly)"),
    newText: z.string().describe("New text to replace the old with")
  }),
  titleFormatter: (input) => `edit: ${input.path ? normalizePath(input.path) : ""}`,
  showContent: false,
  execute: async (input, signal): Promise<ToolOutput> => {
    throwIfAborted(signal);
    const filePath = expandHomePath(input.path);
    const fileBytes = await readFile(filePath);

    const freshness = checkFileState(filePath, fileBytes);
    // Disabled: the unread check is intentionally skipped so the model can
    // edit a file it already knows the content of without a prior read.
    // if (freshness === "unread") {
    //   return {
    //     content: [{ type: "text", text: `File has not been read yet in this session: ${input.path}. Read it before editing.` }],
    //     is_error: true,
    //   };
    // }
    if (freshness === "stale") {
      return {
        content: [{ type: "text", text: `File has been modified externally since it was last read, written, or edited: ${input.path}. Read it again before editing.` }],
        is_error: true,
      };
    }

    const oldFileData = fileBytes.toString("utf8");
    const diff = formatReplacementDiff({
      fileText: oldFileData,
      oldText: input.oldText,
      newText: input.newText,
    });
    const newFileData = oldFileData.replaceAll(input.oldText, input.newText);
    await writeFile(filePath, newFileData);
    recordFileState(filePath, newFileData);
    const replacementLabel = diff.replacements === 1 ? "1 replacement" : `${diff.replacements} replacements`;
    return {
      content: [{ type: "text", text: `Edited file (${replacementLabel})` }],
      display: wrapDiffFence(diff.text),
    }
  }
})
