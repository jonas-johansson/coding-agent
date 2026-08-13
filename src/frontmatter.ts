/**
 * Minimal YAML frontmatter parsing, shared by skills and agents.
 *
 * Handles only flat `key: value` pairs and simple quoted strings.
 * Returns null if no valid frontmatter delimiters are found.
 */

export type Frontmatter = Record<string, string | boolean>;

export function parseFrontmatter(text: string): Frontmatter | null {
  // Frontmatter must start with --- on the first line
  if (!text.startsWith("---")) return null;

  const endIndex = text.indexOf("\n---", 3);
  if (endIndex === -1) return null;

  const block = text.slice(text.indexOf("\n", 0) + 1, endIndex);
  const result: Record<string, string | boolean> = {};

  for (const line of block.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;

    const key = trimmed.slice(0, colonIdx).trim();
    let value: string | boolean = trimmed.slice(colonIdx + 1).trim();

    // Strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    // Parse booleans
    if (value === "true") value = true;
    else if (value === "false") value = false;

    result[key] = value;
  }

  return result;
}

/**
 * Return the markdown body after the frontmatter block.
 * Returns the full text when there is no frontmatter.
 */
export function stripFrontmatter(text: string): string {
  if (!text.startsWith("---")) return text;

  const endIndex = text.indexOf("\n---", 3);
  if (endIndex === -1) return text;

  return text.slice(endIndex + 4).trimStart();
}
