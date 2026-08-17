/** Context lines shown above and below each replacement hunk. */
const CONTEXT_LINES = 3;
/** Soft cap on emitted hunk lines so a huge replaceAll does not flood the TUI. */
const MAX_DIFF_LINES = 80;

export type ReplacementDiffInput = {
  fileText: string;
  oldText: string;
  newText: string;
};

export type ReplacementDiff = {
  text: string;
  replacements: number;
};

type LineMap = {
  text: string;
  lines: string[];
  /** Byte offset of the first character of each line. */
  starts: number[];
};

/**
 * Build a compact unified-style hunk from an exact replaceAll edit.
 *
 * The edit tool already knows oldText and newText. We locate each match
 * and emit a small hunk with context. No Myers walk. No extra dependency.
 */
export function formatReplacementDiff(input: ReplacementDiffInput): ReplacementDiff {
  if (input.oldText === input.newText) {
    return { text: "No changes (oldText equals newText)", replacements: 0 };
  }

  const matches = findMatchOffsets(input.fileText, input.oldText);
  if (matches.length === 0) {
    return { text: "No changes (oldText not found)", replacements: 0 };
  }

  const hunks: string[][] = [];
  let emittedLines = 0;
  let omittedHunks = 0;
  let remaining = input.fileText;
  let cursor = 0;

  for (let i = 0; i < matches.length; i++) {
    const matchOffset = remaining.indexOf(input.oldText, cursor);
    if (matchOffset === -1) {
      break;
    }

    const before = remaining.slice(0, matchOffset);
    const after = remaining.slice(matchOffset + input.oldText.length);
    const oldSnapshot = remaining;
    const newSnapshot = before + input.newText + after;
    const hunk = buildMatchHunk(
      buildLineMap(oldSnapshot),
      buildLineMap(newSnapshot),
      matchOffset,
      matchOffset,
      input.oldText,
      input.newText,
    );

    remaining = newSnapshot;
    cursor = matchOffset + input.newText.length;

    if (emittedLines >= MAX_DIFF_LINES) {
      omittedHunks += matches.length - i;
      break;
    }
    if (emittedLines + hunk.length > MAX_DIFF_LINES) {
      const room = Math.max(1, MAX_DIFF_LINES - emittedLines);
      hunks.push([...hunk.slice(0, room), "… truncated"]);
      omittedHunks += matches.length - i - 1;
      break;
    }
    hunks.push(hunk);
    emittedLines += hunk.length;
  }

  let text = hunks.map((hunk) => hunk.join("\n")).join("\n");
  if (omittedHunks > 0) {
    text += `\n… ${omittedHunks} more`;
  }
  return { text, replacements: matches.length };
}

export function wrapDiffFence(diff: string): string {
  if (!diff.startsWith("@@") && !diff.startsWith("…")) {
    return diff;
  }
  return "```diff\n" + diff + "\n```";
}

function findMatchOffsets(haystack: string, needle: string): number[] {
  if (needle.length === 0) {
    return [];
  }

  const offsets: number[] = [];
  let from = 0;
  while (from <= haystack.length - needle.length) {
    const index = haystack.indexOf(needle, from);
    if (index === -1) {
      break;
    }
    offsets.push(index);
    from = index + needle.length;
  }
  return offsets;
}

function buildLineMap(text: string): LineMap {
  const lines = splitFileLines(text);
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1;
  }
  return { text, lines, starts };
}

/** Split file text into lines. Drop the extra empty line from a trailing newline. */
function splitFileLines(text: string): string[] {
  if (text.length === 0) {
    return [];
  }
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

function lineAt(map: LineMap, offset: number): number {
  if (map.lines.length === 0) {
    return 0;
  }
  const clamped = Math.max(0, Math.min(offset, map.text.length));
  for (let i = map.starts.length - 1; i >= 0; i--) {
    if (clamped >= map.starts[i]) {
      return i;
    }
  }
  return 0;
}

/**
 * Inclusive line range rewritten by `[offset, offset + length)`.
 *
 * A trailing newline belongs to the last rewritten line. The next line is
 * not part of the rewrite.
 */
function rewrittenRange(map: LineMap, offset: number, length: number): { start: number; end: number } {
  if (map.lines.length === 0) {
    return { start: 0, end: -1 };
  }

  const startOffset = clamp(offset, 0, map.text.length);
  const endOffset = clamp(offset + Math.max(length, 0), 0, map.text.length);
  const start = lineAt(map, Math.min(startOffset, Math.max(0, map.text.length - 1)));

  if (endOffset <= startOffset) {
    return { start: 0, end: -1 };
  }

  let lastIncluded = endOffset - 1;
  if (map.text.charCodeAt(lastIncluded) === 10) {
    lastIncluded -= 1;
  }
  if (lastIncluded < startOffset) {
    return { start, end: start };
  }
  return { start, end: lineAt(map, lastIncluded) };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function buildMatchHunk(
  oldMap: LineMap,
  newMap: LineMap,
  oldOffset: number,
  newOffset: number,
  oldText: string,
  newText: string,
): string[] {
  const oldRange = rewrittenRange(oldMap, oldOffset, oldText.length);
  const oldCoreStart = oldRange.end < oldRange.start
    ? oldOffset
    : (oldMap.starts[oldRange.start] ?? oldOffset);
  const oldCoreEnd = oldRange.end < oldRange.start
    ? oldOffset + oldText.length
    : (oldRange.end + 1 < oldMap.starts.length ? oldMap.starts[oldRange.end + 1] : oldMap.text.length);
  const shift = newOffset - oldOffset;
  const newCoreStart = oldCoreStart + shift;
  const newCoreEnd = oldCoreEnd + shift + (newText.length - oldText.length);

  let newStartLine = 0;
  let newEndLine = -1;
  if (newCoreEnd > newCoreStart && newMap.lines.length > 0) {
    newStartLine = lineAt(newMap, newCoreStart);
    let lastIncluded = newCoreEnd - 1;
    if (newMap.text.charCodeAt(lastIncluded) === 10) {
      lastIncluded -= 1;
    }
    newEndLine = lastIncluded >= newCoreStart ? lineAt(newMap, lastIncluded) : newStartLine;
  }

  const oldCore = sliceLines(oldMap.lines, oldRange.start, oldRange.end);
  const newCore = sliceLines(newMap.lines, newStartLine, newEndLine);

  let peelPre = 0;
  while (peelPre < oldCore.length && peelPre < newCore.length && oldCore[peelPre] === newCore[peelPre]) {
    peelPre += 1;
  }

  let peelPost = 0;
  while (
    peelPost < oldCore.length - peelPre
    && peelPost < newCore.length - peelPre
    && oldCore[oldCore.length - 1 - peelPost] === newCore[newCore.length - 1 - peelPost]
  ) {
    peelPost += 1;
  }

  const removed = oldCore.slice(peelPre, oldCore.length - peelPost);
  const added = newCore.slice(peelPre, newCore.length - peelPost);

  const removedStartLine = Math.max(0, oldRange.start + peelPre);
  const afterStart = oldRange.end - peelPost + 1;
  const contextBeforeStart = Math.max(0, removedStartLine - CONTEXT_LINES);
  const contextAfterEnd = Math.min(oldMap.lines.length, Math.max(afterStart, 0) + CONTEXT_LINES);

  const oldCount = (removedStartLine - contextBeforeStart) + removed.length + Math.max(0, contextAfterEnd - afterStart);
  const newCount = (removedStartLine - contextBeforeStart) + added.length + Math.max(0, contextAfterEnd - afterStart);
  const headerStart = contextBeforeStart + 1;

  const rows: string[] = [
    newCount !== oldCount ? `@@ ${headerStart},${oldCount} → ${newCount}` : `@@ ${headerStart},${oldCount}`,
  ];

  for (let i = contextBeforeStart; i < removedStartLine; i++) {
    rows.push(` ${oldMap.lines[i]}`);
  }
  for (const line of removed) {
    rows.push(`-${line}`);
  }
  for (const line of added) {
    rows.push(`+${line}`);
  }
  for (let i = afterStart; i < contextAfterEnd; i++) {
    rows.push(` ${oldMap.lines[i]}`);
  }

  return rows;
}

function sliceLines(lines: string[], start: number, end: number): string[] {
  if (end < start || start < 0) {
    return [];
  }
  return lines.slice(start, end + 1);
}
