import { createHash } from "crypto";
import { resolve } from "path";
import { expandHomePath } from "./path";

/**
 * Tracks the last content snapshot this process has seen for each file touched
 * by the read, write, and edit tools. Used to detect external modifications so
 * the write and edit tools never silently clobber changes made outside the
 * agent (e.g. via the bash tool, an editor, or git).
 *
 * Content hashes are used instead of mtimes: the tools already hold the file
 * content in memory, and hashing is exact — immune to mtime granularity and
 * metadata-only changes. Hashes always cover the raw bytes on disk; a string
 * is hashed as its UTF-8 encoding, matching what writeFile persists.
 */
const fileHashes = new Map<string, string>();

export type FileFreshness = "fresh" | "stale" | "unread";

function canonicalPath(path: string): string {
  return resolve(expandHomePath(path));
}

function hashContent(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Record the content snapshot for a file after a successful read, write, or edit. */
export function recordFileState(path: string, content: string | Buffer): void {
  fileHashes.set(canonicalPath(path), hashContent(content));
}

/**
 * Compare a file's current content against the last recorded snapshot.
 * Returns "unread" if the file was never read, written, or edited in this
 * process, "stale" if the content changed since then, and "fresh" otherwise.
 */
export function checkFileState(path: string, currentContent: string | Buffer): FileFreshness {
  const recorded = fileHashes.get(canonicalPath(path));
  if (recorded === undefined) return "unread";
  return hashContent(currentContent) === recorded ? "fresh" : "stale";
}
