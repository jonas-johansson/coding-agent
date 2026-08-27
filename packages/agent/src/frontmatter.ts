/**
 * Minimal YAML frontmatter parsing, shared by skills and agents.
 *
 * Supports the YAML subset that appears in real-world SKILL.md and agent
 * definition files:
 *
 *   - flat `key: value` pairs (plain, quoted, or boolean)
 *   - block scalars (`>` folded and `|` literal), including chomping (`-`/`+`)
 *     and explicit indentation indicators
 *   - multi-line plain and quoted scalars, folded per YAML rules
 *   - comments and list items, which are skipped
 *
 * Values are returned trimmed. Returns null if no valid frontmatter
 * delimiters are found.
 */

export type Frontmatter = Record<string, string | boolean>;

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Split text into lines, tolerating a BOM and CRLF line endings. */
function splitLines(text: string): string[] {
  return text.replace(/^\uFEFF/, "").split(/\r?\n/);
}

/** Number of leading whitespace characters on a line. */
function indentOf(line: string): number {
  const match = /^[ \t]*/.exec(line);
  return match ? match[0].length : 0;
}

/**
 * Fold scalar content lines per YAML rules: a line break between lines of
 * equal indentation becomes a space, blank lines become newlines, and line
 * breaks next to more-indented lines are preserved.
 */
function foldLines(content: string[]): string {
  let out = "";
  let pendingBreaks = 0;
  let prevMoreIndented = false;
  let started = false;

  for (const line of content) {
    if (line === "") {
      pendingBreaks += 1;
      continue;
    }
    const moreIndented = line[0] === " " || line[0] === "\t";
    const text = line.trimEnd();
    if (!started) {
      out = text;
      started = true;
    } else if (pendingBreaks > 0) {
      out += "\n".repeat(pendingBreaks) + text;
    } else if (moreIndented || prevMoreIndented) {
      out += "\n" + text;
    } else {
      out += " " + text;
    }
    pendingBreaks = 0;
    prevMoreIndented = moreIndented;
  }

  return out;
}

/** Resolve double-quoted escape sequences. */
function unescapeDoubleQuoted(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== "\\" || i === text.length - 1) {
      out += ch;
      continue;
    }
    const next = text[++i];
    switch (next) {
      case "n": out += "\n"; break;
      case "t": out += "\t"; break;
      case "r": out += "\r"; break;
      case "0": out += "\0"; break;
      case '"': out += '"'; break;
      case "\\": out += "\\"; break;
      case "/": out += "/"; break;
      default: out += "\\" + next; // unknown escape: keep as written
    }
  }
  return out;
}

/** Index of the closing quote of a quoted scalar, or -1. */
function findClosingQuote(text: string, quote: '"' | "'"): number {
  for (let i = 1; i < text.length; i++) {
    const ch = text[i];
    if (quote === '"' && ch === "\\") {
      i += 1; // skip escaped character
      continue;
    }
    if (ch === quote) {
      if (quote === "'" && text[i + 1] === "'") {
        i += 1; // escaped quote ('')
        continue;
      }
      return i;
    }
  }
  return -1;
}

/**
 * Index of the colon separating key from value: the first colon followed by
 * whitespace or end-of-line, since YAML keys may themselves contain colons
 * (e.g. `a:b: c`). Falls back to the first colon so malformed `key:value`
 * lines without a space still parse.
 */
function findKeyColon(line: string): number {
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== ":") continue;
    const next = line[i + 1];
    if (next === undefined || next === " " || next === "\t") return i;
  }
  return line.indexOf(":");
}

/**
 * Strip a trailing comment from a plain (unquoted) scalar: a `#` at the
 * start of the value or preceded by whitespace starts a comment.
 */
function stripTrailingComment(value: string): string {
  if (value.startsWith("#")) return "";
  for (let i = 1; i < value.length; i++) {
    if (value[i] === "#" && (value[i - 1] === " " || value[i - 1] === "\t")) {
      return value.slice(0, i).trim();
    }
  }
  return value;
}

/** True once a quoted scalar has a closing quote. */
function isClosedQuoted(text: string, quote: '"' | "'"): boolean {
  return (
    (text.length >= 2 && text.endsWith(quote)) ||
    findClosingQuote(text, quote) !== -1
  );
}

// ── Scalar parsing ───────────────────────────────────────────────────────────

// Matches block scalar headers: `>`, `|`, optionally followed by chomping
// and/or explicit indentation indicators (`>-`, `|+`, `>2`, `|2-`, ...) and
// an optional trailing comment.
const BLOCK_SCALAR_HEADER_RE = /^([>|])(\d+[+-]?|[+-]\d+|[+-])?\s*(?:#.*)?$/;

/**
 * Parse a block scalar whose header sits on the line before `start`.
 * Content is every following line indented past the key; the first non-blank
 * line fixes the block indentation unless an explicit indicator was given.
 * A column-0 line ends the scalar.
 */
function parseBlockScalar(
  lines: string[],
  start: number,
  style: ">" | "|",
  explicitIndent: number | null,
): { value: string; next: number } {
  let end = start;
  let contentIndent = explicitIndent;

  while (end < lines.length) {
    const line = lines[end];
    if (line.trim() === "") {
      end += 1;
      continue;
    }
    const indent = indentOf(line);
    if (indent === 0) break;
    if (contentIndent === null) contentIndent = indent;
    if (indent < contentIndent) break;
    end += 1;
  }

  const content: string[] = [];
  for (let i = start; i < end; i++) {
    const line = lines[i];
    content.push(line.trim() === "" ? "" : line.slice(contentIndent ?? 0));
  }
  // Leading and trailing blank lines only contribute newlines, which are
  // dropped because values are trimmed.
  while (content.length > 0 && content[0] === "") content.shift();
  while (content.length > 0 && content[content.length - 1] === "") content.pop();

  const value = style === "|" ? content.join("\n") : foldLines(content);
  return { value, next: end };
}

/**
 * Parse a quoted scalar starting on the key line at `keyIndex`, where
 * `firstValue` is the text after the colon (beginning with the quote
 * character). Continuation lines are folded in until the closing quote.
 */
function parseQuotedScalar(
  lines: string[],
  keyIndex: number,
  firstValue: string,
  quote: '"' | "'",
): { value: string; next: number } {
  let collected = firstValue;
  let j = keyIndex + 1;

  while (j < lines.length && !isClosedQuoted(collected, quote)) {
    const line = lines[j];
    const trimmed = line.trim();
    // A column-0 line before the closing quote ends the (malformed) scalar.
    if (trimmed !== "" && indentOf(line) === 0) break;
    collected += trimmed === "" ? "\n" : " " + trimmed;
    j += 1;
  }

  let inner: string;
  if (collected.length >= 2 && collected.endsWith(quote)) {
    // Prefer the trailing quote: handles values containing the quote
    // character itself (e.g. 'Don't').
    inner = collected.slice(1, -1);
  } else {
    const close = findClosingQuote(collected, quote);
    inner = close === -1 ? collected.slice(1) : collected.slice(1, close);
  }

  const value =
    quote === '"'
      ? unescapeDoubleQuoted(inner)
      : inner.replaceAll("''", "'");
  return { value: value.trim(), next: j };
}

/**
 * Parse a plain (unquoted) scalar whose key line is at `keyIndex`, with
 * `firstValue` being the text after the colon. Continuation lines indented
 * past the key are folded into the value; an empty value followed by list
 * items stays empty (sequences are not supported, only skipped).
 */
function parsePlainScalar(
  lines: string[],
  keyIndex: number,
  firstValue: string,
): { value: string; next: number } {
  const continuation: string[] = [];
  let j = keyIndex + 1;

  while (j < lines.length) {
    // Look past blank lines: the scalar continues only when a more-indented,
    // non-comment line follows.
    let k = j;
    while (k < lines.length && lines[k].trim() === "") k += 1;
    if (k >= lines.length) break;
    const line = lines[k];
    if (indentOf(line) === 0) break;
    if (line.trim().startsWith("#")) break;

    // `key:` followed by list items is a sequence; skip the items.
    if (
      firstValue === "" &&
      continuation.length === 0 &&
      line.trim().startsWith("- ")
    ) {
      let m = k;
      while (m < lines.length && lines[m].trim().startsWith("- ")) m += 1;
      return { value: "", next: m };
    }

    for (let b = j; b < k; b++) continuation.push("");
    continuation.push(line);
    j = k + 1;
  }

  if (continuation.length === 0) {
    return { value: firstValue, next: keyIndex + 1 };
  }

  const minIndent = Math.min(
    ...continuation.filter((l) => l !== "").map((l) => indentOf(l)),
  );
  const content = [
    firstValue,
    ...continuation.map((l) => (l === "" ? "" : l.slice(minIndent).trimEnd())),
  ];
  return { value: foldLines(content), next: j };
}

// ── Block parsing ────────────────────────────────────────────────────────────

/** Parse the lines between the frontmatter delimiters into a record. */
function parseBlock(lines: string[]): Frontmatter {
  const result: Frontmatter = {};
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Only a column-0 line can start a top-level key; anything else is
    // leftover content (nested mappings, stray lines) and is skipped.
    if (line.length > 0 && (line[0] === " " || line[0] === "\t")) {
      i += 1;
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("- ")) {
      i += 1;
      continue;
    }

    const colonIdx = findKeyColon(trimmed);
    if (colonIdx <= 0) {
      i += 1;
      continue;
    }

    const key = trimmed.slice(0, colonIdx).trim();
    const rest = trimmed.slice(colonIdx + 1).trim();

    // Block scalar (`>`, `|`, with optional indicators).
    const header = BLOCK_SCALAR_HEADER_RE.exec(rest);
    if (header) {
      const digit = header[2] ? /\d/.exec(header[2])?.[0] : undefined;
      const scalar = parseBlockScalar(
        lines,
        i + 1,
        header[1] as ">" | "|",
        digit ? Number(digit) : null,
      );
      result[key] = scalar.value;
      i = scalar.next;
      continue;
    }

    // Quoted scalar, possibly spanning multiple lines.
    if (rest.startsWith('"') || rest.startsWith("'")) {
      const parsed = parseQuotedScalar(lines, i, rest, rest[0] as '"' | "'");
      result[key] = parsed.value;
      i = parsed.next;
      continue;
    }

    // Plain scalar, possibly continued on following indented lines.
    const parsed = parsePlainScalar(lines, i, stripTrailingComment(rest));
    if (parsed.value === "true") result[key] = true;
    else if (parsed.value === "false") result[key] = false;
    else result[key] = parsed.value;
    i = parsed.next;
  }

  return result;
}

/** Index of the line closing the frontmatter block, or -1. */
function findFrontmatterEnd(lines: string[]): number {
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") return i;
  }
  return -1;
}

// ── Public API ───────────────────────────────────────────────────────────────

export function parseFrontmatter(text: string): Frontmatter | null {
  const lines = splitLines(text);
  if (lines.length === 0 || lines[0].trimEnd() !== "---") return null;

  const end = findFrontmatterEnd(lines);
  if (end === -1) return null;

  return parseBlock(lines.slice(1, end));
}

/**
 * Return the markdown body after the frontmatter block.
 * Returns the full text when there is no frontmatter.
 */
export function stripFrontmatter(text: string): string {
  const lines = splitLines(text);
  if (lines.length === 0 || lines[0].trimEnd() !== "---") return text;

  const end = findFrontmatterEnd(lines);
  if (end === -1) return text;

  // Drop the frontmatter and any leading blank lines, preserving the first
  // body line's own indentation.
  return lines
    .slice(end + 1)
    .join("\n")
    .replace(/^(?:[ \t]*\n)+/, "");
}
