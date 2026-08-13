import type { RenderBlock } from "./tui";
import { formatCost, formatTokenCount } from "./tui";
import { DEFAULT_COST_DISPLAY_CONFIG, type CostDisplayConfig } from "./config";
import {
  getActivePath,
  type AssistantEntry,
  type Session,
  type SessionEntry,
  type ToolResultEntry,
  type ToolResultPart,
  type UserEntry,
} from "./session";
import { tools, visualizeToolTitle } from "./tool";
import { reasoningDisplayContent, reasoningDisplayTitle } from "./reasoning";
import type { TextBlock, ToolUseBlock } from "./provider";

export type SessionRenderBlock = Omit<RenderBlock, "id">;

export function sessionToRenderBlocks(
  session: Session,
  options?: { costConfig?: CostDisplayConfig },
): SessionRenderBlock[] {
  return entriesToRenderBlocks(getActivePath(session), options);
}

export function entriesToRenderBlocks(
  entries: readonly SessionEntry[],
  options?: { costConfig?: CostDisplayConfig },
): SessionRenderBlock[] {
  const blocks: SessionRenderBlock[] = [];
  const toolResultsByUseId = collectToolResults(entries);
  const renderedToolResultEntryIds = new Set<string>();

  for (const entry of entries) {
    switch (entry.type) {
      case "user":
        blocks.push(userEntryToRenderBlock(entry));
        break;
      case "assistant":
        blocks.push(...assistantEntryToRenderBlocks(entry, toolResultsByUseId, renderedToolResultEntryIds));
        break;
      case "tool_result":
        if (!renderedToolResultEntryIds.has(entry.id)) {
          blocks.push(toolResultEntryToRenderBlock(entry));
        }
        break;
    }
  }

  // Turn usage summary: shown once after the final assistant message of the
  // active path. Only rendered when the path ends with an assistant entry,
  // i.e. the turn completed (not aborted mid-turn or navigated mid-turn).
  const lastEntry = entries[entries.length - 1];
  if (lastEntry?.type === "assistant") {
    const summary = getTurnSummary(entries);
    if (summary) {
      blocks.push({
        key: `turn-summary:${lastEntry.id}`,
        role: "meta",
        content: formatTurnSummary(summary, options?.costConfig ?? DEFAULT_COST_DISPLAY_CONFIG),
      });
    }
  }

  return blocks;
}

export type TurnSummary = {
  modelId: string;
  modelVariant?: string;
  cost: number;
  durationMs: number;
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens: number;
};

/**
 * Compute the usage summary for the turn that ends with the last entry of the
 * given list. Returns undefined when the list does not end with an assistant
 * entry (aborted or mid-turn path). Totals span all assistant calls in the
 * turn; duration is derived from the user entry and final assistant entry
 * timestamps, so it includes tool execution time.
 */
export function getTurnSummary(entries: readonly SessionEntry[]): TurnSummary | undefined {
  const lastEntry = entries[entries.length - 1];
  if (!lastEntry || lastEntry.type !== "assistant") {
    return undefined;
  }

  let turnStartIndex = 0;
  for (let i = entries.length - 2; i >= 0; i -= 1) {
    if (entries[i].type === "user") {
      turnStartIndex = i;
      break;
    }
  }

  let tokensIn = 0;
  let tokensOut = 0;
  let cacheReadTokens = 0;
  let cost = 0;
  let modelId = "";
  let modelVariant: string | undefined;

  for (let i = turnStartIndex; i < entries.length; i += 1) {
    const entry = entries[i];
    if (entry.type !== "assistant") {
      continue;
    }
    tokensIn += entry.tokensIn;
    tokensOut += entry.tokensOut;
    cacheReadTokens += entry.cacheReadTokens ?? 0;
    cost += entry.cost;
    modelId = entry.modelId;
    modelVariant = entry.modelVariant;
  }

  const turnStart = entries[turnStartIndex];
  const durationMs = turnStart && turnStart.type === "user"
    ? Math.max(0, Date.parse(lastEntry.timestamp) - Date.parse(turnStart.timestamp))
    : 0;

  return { modelId, modelVariant, cost, durationMs, tokensIn, tokensOut, cacheReadTokens };
}

export function formatTurnSummary(summary: TurnSummary, costConfig: CostDisplayConfig): string {
  const parts: string[] = [];

  parts.push(summary.modelVariant ? `${summary.modelId}:${summary.modelVariant}` : summary.modelId);

  if (summary.cost > 0) {
    parts.push(formatCost(summary.cost, costConfig));
  }

  parts.push(formatDuration(summary.durationMs));
  parts.push(`${formatTokenCount(summary.tokensIn)} in`);
  parts.push(`${formatTokenCount(summary.tokensOut)} out`);

  if (summary.tokensIn > 0) {
    const cachePercent = Math.round((summary.cacheReadTokens / summary.tokensIn) * 100);
    parts.push(`cache ${cachePercent}%`);
  }

  return parts.join(" · ");
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) {
    return `${durationMs}ms`;
  }
  if (durationMs < 60_000) {
    const seconds = durationMs / 1000;
    return `${seconds % 1 === 0 ? seconds.toFixed(0) : seconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

function collectToolResults(entries: readonly SessionEntry[]): Map<string, ToolResultEntry[]> {
  const results = new Map<string, ToolResultEntry[]>();

  for (const entry of entries) {
    if (entry.type !== "tool_result") {
      continue;
    }

    const existing = results.get(entry.toolUseId) ?? [];
    existing.push(entry);
    results.set(entry.toolUseId, existing);
  }

  return results;
}

function userEntryToRenderBlock(entry: UserEntry): SessionRenderBlock {
  return {
    key: `entry:${entry.id}`,
    role: "user",
    content: formatUserContent(entry.content),
  };
}

function assistantEntryToRenderBlocks(
  entry: AssistantEntry,
  toolResultsByUseId: Map<string, ToolResultEntry[]>,
  renderedToolResultEntryIds: Set<string>,
): SessionRenderBlock[] {
  const blocks: SessionRenderBlock[] = [];

  entry.content.forEach((contentBlock, index) => {
    const key = `entry:${entry.id}:block:${index}`;

    switch (contentBlock.type) {
      case "text":
        if (contentBlock.text) {
          blocks.push({ key, role: "assistant", content: contentBlock.text });
        }
        break;
      case "thinking":
        if (contentBlock.thinking) {
          blocks.push({
            key,
            role: "reasoning",
            title: reasoningDisplayTitle(contentBlock.thinking),
            content: reasoningDisplayContent(contentBlock.thinking),
          });
        }
        break;
      case "image":
        blocks.push({ key, role: "assistant", content: formatImageBlock(contentBlock) });
        break;
      case "tool_use": {
        const results = toolResultsByUseId.get(contentBlock.id) ?? [];
        for (const result of results) {
          renderedToolResultEntryIds.add(result.id);
        }
        blocks.push(toolUseToRenderBlock(contentBlock.id, contentBlock.name, contentBlock.input, results));
        break;
      }
    }
  });

  return blocks;
}

function toolUseToRenderBlock(
  toolUseId: string,
  toolName: string,
  input: unknown,
  results: readonly ToolResultEntry[],
): SessionRenderBlock {
  const isError = results.some((result) => result.isError);
  const content = shouldShowToolResultContent(toolName, isError)
    ? formatToolResultEntries(results)
    : "";

  return {
    key: `tool:${toolUseId}`,
    role: "tool",
    title: visualizeToolTitle(toolName, input),
    content,
    ...(results.length > 0 && { state: isError ? "error" : "done" }),
  };
}

function toolResultEntryToRenderBlock(entry: ToolResultEntry): SessionRenderBlock {
  return {
    key: `entry:${entry.id}`,
    role: "tool",
    title: `tool_result: ${entry.toolUseId}`,
    content: formatToolResultParts(entry.content),
    state: entry.isError ? "error" : "done",
  };
}

function shouldShowToolResultContent(toolName: string, isError: boolean): boolean {
  const tool = tools.find((candidate) => candidate.name === toolName);
  return tool?.showContent !== false || isError;
}

function formatUserContent(content: UserEntry["content"]): string {
  return content.map(formatUserContentBlock).filter(Boolean).join("\n\n");
}

function formatUserContentBlock(block: UserEntry["content"][number]): string {
  if (block.type === "text") {
    return block.text;
  }

  return formatImageBlock(block);
}

function formatToolResultEntries(entries: readonly ToolResultEntry[]): string {
  return entries.map((entry) => formatToolResultParts(entry.content)).filter(Boolean).join("\n\n");
}

function formatToolResultParts(parts: readonly ToolResultPart[]): string {
  return parts.map(formatToolResultPart).filter(Boolean).join("\n\n").trimEnd();
}

function formatToolResultPart(part: ToolResultPart): string {
  if (part.type === "text") {
    return part.text;
  }

  return formatImageBlock(part);
}

function formatImageBlock(block: { mediaType: string }): string {
  return `[Image: ${block.mediaType}]`;
}

export type TreeOverlayEntry = {
  id: string;
  parentId: string | null;
  depth: number;
  role: "user" | "assistant";
  preview: string;
  isActive: boolean;
  isLeaf: boolean;
  hasChildren: boolean;
  timestamp: string;
};

function assistantEntryHasVisibleContent(entry: AssistantEntry): boolean {
  return entry.content.some((block) => block.type === "text" || block.type === "image");
}

export function sessionToTreeOverlayEntries(session: Session): TreeOverlayEntry[] {
  const activePath = getActivePath(session);
  const activePathIds = new Set(activePath.map((entry) => entry.id));
  const activePathOrder = new Map(activePath.map((entry, index) => [entry.id, index]));

  const entriesById = new Map(session.entries.map((entry) => [entry.id, entry]));
  const visibleEntries = session.entries.filter(
    (entry): entry is UserEntry | AssistantEntry =>
      entry.type === "user" || (entry.type === "assistant" && assistantEntryHasVisibleContent(entry)),
  );
  const visibleEntryIds = new Set(visibleEntries.map((entry) => entry.id));

  const visibleParentId = new Map<string, string | null>();
  for (const entry of visibleEntries) {
    let parentId: string | null = entry.parentId;
    while (parentId !== null && !visibleEntryIds.has(parentId)) {
      const parent = entriesById.get(parentId);
      parentId = parent?.parentId ?? null;
    }
    visibleParentId.set(entry.id, parentId);
  }

  const childrenByParent = new Map<string | null, (UserEntry | AssistantEntry)[]>();
  for (const entry of visibleEntries) {
    const parentId = visibleParentId.get(entry.id) ?? null;
    const siblings = childrenByParent.get(parentId) ?? [];
    siblings.push(entry);
    childrenByParent.set(parentId, siblings);
  }

  const hasChildren = new Set<string>();
  for (const entry of visibleEntries) {
    const parentId = visibleParentId.get(entry.id) ?? null;
    if (parentId !== null) {
      hasChildren.add(parentId);
    }
  }

  function sortEntries(entries: (UserEntry | AssistantEntry)[]): (UserEntry | AssistantEntry)[] {
    return entries.slice().sort((a, b) => {
      const aActive = activePathOrder.has(a.id);
      const bActive = activePathOrder.has(b.id);
      if (aActive && !bActive) {
        return -1;
      }
      if (!aActive && bActive) {
        return 1;
      }
      return a.timestamp.localeCompare(b.timestamp);
    });
  }

  const rows: TreeOverlayEntry[] = [];

  function traverse(entry: UserEntry | AssistantEntry, depth: number) {
    rows.push({
      id: entry.id,
      parentId: visibleParentId.get(entry.id) ?? null,
      depth,
      role: entry.type,
      preview: formatTreePreview(entry),
      isActive: activePathIds.has(entry.id),
      isLeaf: session.activeEntryId === entry.id,
      hasChildren: hasChildren.has(entry.id),
      timestamp: entry.timestamp,
    });

    const children = sortEntries(childrenByParent.get(entry.id) ?? []);
    for (const child of children) {
      traverse(child, depth + 1);
    }
  }

  const roots = sortEntries(childrenByParent.get(null) ?? []);
  for (const root of roots) {
    traverse(root, 0);
  }

  return rows;
}

function formatTreePreview(entry: UserEntry | AssistantEntry): string {
  if (entry.type === "user") {
    const text = entry.content
      .filter((block): block is TextBlock => block.type === "text")
      .map((block) => block.text)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    return text || "[empty message]";
  }

  // Assistant: prefer text over reasoning/thinking, since thinking blocks
  // often appear before the visible response.
  for (const block of entry.content) {
    if (block.type === "text" && block.text.trim()) {
      return block.text.trim().replace(/\s+/g, " ");
    }
  }

  for (const block of entry.content) {
    if (block.type === "image") {
      return "[image]";
    }
  }

  return "[assistant]";
}
