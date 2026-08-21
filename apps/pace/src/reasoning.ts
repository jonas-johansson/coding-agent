const REASONING_TITLE_PATTERN = /^\*\*([^*\n]+)\*\*/;

export function reasoningTitle(text: string): string | null {
  const match = text.match(REASONING_TITLE_PATTERN);
  return match ? match[1].trim() : null;
}

export function reasoningDisplayTitle(text: string): string {
  const title = reasoningTitle(text);
  return title ? "Reasoning: " + title : "Reasoning";
}

export function reasoningDisplayContent(text: string): string {
  const match = text.match(REASONING_TITLE_PATTERN);
  if (!match) return text;
  return text.slice(match[0].length).trimStart();
}
