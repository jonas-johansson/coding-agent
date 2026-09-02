import type { RenderBlock } from "./view-model";
import { formatCost, formatTokenCount } from "./view-model";
import { DEFAULT_COST_DISPLAY_CONFIG, type CostDisplayConfig } from "./config";
import {
  getActivePath,
  type AssistantEntry,
  type CompactionEntry,
  type Session,
  type SessionEntry,
  type ToolResultEntry,
  type ToolResultPart,
  type UserEntry,
} from "@pace/agent";
import { tools, visualizeToolTitle } from "@pace/agent";
import { reasoningDisplayContent, reasoningDisplayTitle } from "./reasoning";
import type { TextBlock, ToolUseBlock } from "@pace/llm";

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
      case "compaction":
        blocks.push(compactionEntryToRenderBlock(entry));
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
  /** Input tokens of the final assistant call, i.e. the context size at the end of the turn. */
  tokensIn: number;
  /** Sum of input tokens across all assistant calls in the turn. Used for the cache ratio. */
  totalTokensIn: number;
  tokensOut: number;
  cacheReadTokens: number;
  /** Average output tokens per second across streaming time only. */
  tps?: number;
};

/**
 * Compute the usage summary for the turn that ends with the last entry of the
 * given list. Returns undefined when the list does not end with an assistant
 * entry (aborted or mid-turn path). `tokensIn` is the input token count of the
 * final assistant call, i.e. the context size at the end of the turn. Output,
 * cache, and cost totals span all assistant calls in the turn. Duration is
 * derived from the user entry and final assistant entry timestamps, so it
 * includes tool execution time.
 */
export function getTurnSummary(entries: readonly SessionEntry[]): TurnSummary | undefined {
  const lastEntry = entries[entries.length - 1];
  if (!lastEntry || lastEntry.type !== "assistant") {
    return undefined;
  }

  let turnStartIndex = 0;
  for (let i = entries.length - 2; i >= 0; i -= 1) {
    const entry = entries[i];
    // Steering messages are injected mid-turn, so the turn starts at the
    // last non-steering user entry.
    if (entry.type === "user" && !entry.steering) {
      turnStartIndex = i;
      break;
    }
  }

  let totalTokensIn = 0;
  let tokensOut = 0;
  let cacheReadTokens = 0;
  let cost = 0;
  let streamDurationMs = 0;
  let modelId = "";
  let modelVariant: string | undefined;
  let tokensIn = 0;

  for (let i = turnStartIndex; i < entries.length; i += 1) {
    const entry = entries[i];
    if (entry.type !== "assistant") {
      continue;
    }
    totalTokensIn += entry.tokensIn;
    tokensOut += entry.tokensOut;
    cacheReadTokens += entry.cacheReadTokens ?? 0;
    cost += entry.cost;
    streamDurationMs += entry.streamDurationMs ?? 0;
    modelId = entry.modelId;
    modelVariant = entry.modelVariant;
    // The final assistant call re-sends the whole context, so its input
    // token count is the context size at the end of the turn.
    tokensIn = entry.tokensIn;
  }

  const turnStart = entries[turnStartIndex];
  const durationMs = turnStart && turnStart.type === "user"
    ? Math.max(0, Date.parse(lastEntry.timestamp) - Date.parse(turnStart.timestamp))
    : 0;

  const tps = streamDurationMs > 0 ? tokensOut / (streamDurationMs / 1000) : undefined;

  return { modelId, modelVariant, cost, durationMs, tokensIn, totalTokensIn, tokensOut, cacheReadTokens, tps };
}

export function formatTurnSummary(summary: TurnSummary, costConfig: CostDisplayConfig): string {
  const parts: string[] = [];

  parts.push(summary.modelVariant ? `${summary.modelId}:${summary.modelVariant}` : summary.modelId);

  if (summary.cost > 0) {
    parts.push(formatCost(summary.cost, costConfig));
  }

  parts.push(formatDuration(summary.durationMs));

  if (summary.tps !== undefined) {
    parts.push(formatTps(summary.tps));
  }

  parts.push(`${formatTokenCount(summary.tokensIn)} in`);
  parts.push(`${formatTokenCount(summary.tokensOut)} out`);

  if (summary.totalTokensIn > 0) {
    const cachePercent = Math.round((summary.cacheReadTokens / summary.totalTokensIn) * 100);
    parts.push(`cache ${cachePercent}%`);
  }

  return parts.join(" · ");
}

function formatTps(tps: number): string {
  if (tps >= 10) {
    return `${Math.round(tps)} tok/s`;
  }
  return `${tps.toFixed(1)} tok/s`;
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
  const display = formatToolResultDisplay(results);
  const content = display
    || (shouldShowToolResultContent(toolName, isError) ? formatToolResultEntries(results) : "");

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

function compactionEntryToRenderBlock(entry: CompactionEntry): SessionRenderBlock {
  return {
    key: `entry:${entry.id}`,
    role: "assistant",
    title: `Context compacted · ${formatTokenCount(entry.tokensBefore)} → ~${formatTokenCount(entry.tokensAfter)} tokens`,
    content: entry.summary,
    collapsed: true,
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

function formatToolResultDisplay(entries: readonly ToolResultEntry[]): string {
  return entries.map((entry) => entry.display).filter(Boolean).join("\n\n");
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
  /**
   * Visual depth: increments only at branch points (a parent with several
   * alternatives) and under compaction summaries. A linear conversation
   * renders flat instead of as a staircase.
   */
  depth: number;
  role: "user" | "assistant" | "compaction";
  preview: string;
  isActive: boolean;
  isLeaf: boolean;
  hasChildren: boolean;
  timestamp: string;
  /** Row is hidden behind a compaction summary (rendered dimmed). */
  summarized?: boolean;
  /** Row is one of several children under its parent (connector glyph). */
  isForkChild?: boolean;
  isLastForkChild?: boolean;
};

function assistantEntryHasVisibleContent(entry: AssistantEntry): boolean {
  return entry.content.some((block) => block.type === "text" || block.type === "image");
}

export function sessionToTreeOverlayEntries(session: Session): TreeOverlayEntry[] {
  const activePath = getActivePath(session);
  const activePathIds = new Set(activePath.map((entry) => entry.id));
  const activePathOrder = new Map(activePath.map((entry, index) => [entry.id, index]));

  const entriesById = new Map(session.entries.map((entry) => [entry.id, entry]));

  type TreeEntry = UserEntry | AssistantEntry | CompactionEntry;
  const isVisibleEntry = (entry: SessionEntry): entry is TreeEntry =>
    entry.type === "user"
    || entry.type === "compaction"
    || (entry.type === "assistant" && assistantEntryHasVisibleContent(entry));
  const visibleEntries = session.entries.filter(isVisibleEntry);
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

  // ── Summarized ranges ────────────────────────────────────────────────────
  // Entries hidden behind a compaction summary are dimmed in place — the
  // compaction row itself renders at its chronological position (right after
  // its kept tail), so the tree reads as an honest timeline.
  const pathCompactions: Array<{ entry: CompactionEntry; order: number; firstKeptOrder?: number }> = activePath
    .map((entry, order) => ({ entry, order }))
    .filter((item): item is { entry: CompactionEntry; order: number } => item.entry.type === "compaction");
  const summarizedIds = new Set<string>();
  for (let i = 0; i < pathCompactions.length; i += 1) {
    // Entries summarized by this compaction: on the active path from the
    // previous compaction's kept-tail start through just before this
    // compaction's kept tail.
    const prevBound = i > 0
      ? pathCompactions[i - 1].firstKeptOrder ?? pathCompactions[i - 1].order
      : 0;
    const firstKeptOrder = pathCompactions[i].entry.firstKeptEntryId !== null
      ? activePathOrder.get(pathCompactions[i].entry.firstKeptEntryId ?? "")
      : undefined;
    pathCompactions[i].firstKeptOrder = firstKeptOrder;
    const summarizedEnd = firstKeptOrder ?? -1; // corrupt (no kept anchor): summarize nothing
    for (let order = prevBound; order < summarizedEnd; order += 1) {
      const entry = activePath[order];
      if (isVisibleEntry(entry)) {
        summarizedIds.add(entry.id);
      }
    }
  }

  const childrenByParent = new Map<string | null, TreeEntry[]>();
  for (const entry of visibleEntries) {
    const parentId = visibleParentId.get(entry.id) ?? null;
    const siblings = childrenByParent.get(parentId) ?? [];
    siblings.push(entry);
    childrenByParent.set(parentId, siblings);
  }

  function sortEntries(entries: TreeEntry[]): TreeEntry[] {
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

  function traverse(entry: TreeEntry, depth: number, summarized: boolean, forkChild: boolean, lastForkChild: boolean) {
    const children = sortEntries(childrenByParent.get(entry.id) ?? []);
    // Branch alternatives: children that are not compaction summaries. Every
    // alternative is visually nested beneath the fork, including the active
    // continuation, so sibling branches line up at the same depth.
    const alternatives = children.filter((child) => !summarizedIds.has(child.id));
    const fork = alternatives.length >= 2;
    const forkChildren = new Set(
      fork ? alternatives.map((child) => child.id) : [],
    );
    const inactiveForkChildren = new Set(
      fork
        ? alternatives.filter((child) => !activePathIds.has(child.id)).map((child) => child.id)
        : [],
    );
    // Inactive alternatives first, preserving the timeline convention that
    // the active continuation ends the fork's expanded range.
    const orderedChildren = fork
      ? [...children].sort(
        (a, b) => Number(inactiveForkChildren.has(b.id)) - Number(inactiveForkChildren.has(a.id)),
      )
      : children;
    const lastForkChildId = [...orderedChildren].reverse().find((child) => forkChildren.has(child.id))?.id;

    rows.push({
      id: entry.id,
      parentId: visibleParentId.get(entry.id) ?? null,
      depth,
      role: entry.type,
      preview: entry.type === "compaction"
        ? compactionTreePreview(entry)
        : formatTreePreview(entry),
      isActive: activePathIds.has(entry.id),
      isLeaf: session.activeEntryId === entry.id,
      hasChildren: fork,
      timestamp: entry.timestamp,
      summarized: summarized || undefined,
      isForkChild: forkChild || undefined,
      isLastForkChild: lastForkChild || undefined,
    });

    for (const child of orderedChildren) {
      const childSummarized = summarizedIds.has(child.id);
      const childDepth = forkChildren.has(child.id) ? depth + 1 : depth;
      traverse(
        child,
        childDepth,
        childSummarized,
        forkChildren.has(child.id),
        child.id === lastForkChildId,
      );
    }
  }

  const roots = sortEntries(childrenByParent.get(null) ?? []);
  for (const root of roots) {
    traverse(root, 0, summarizedIds.has(root.id), false, false);
  }

  return rows;
}

function compactionTreePreview(entry: CompactionEntry): string {
  const parts = [
    `Context compacted · ${formatTokenCount(entry.tokensBefore)} → ~${formatTokenCount(entry.tokensAfter)} tokens`,
    entry.trigger,
  ];
  if (entry.focus !== undefined) {
    parts.push(`focus: ${entry.focus}`);
  }
  return parts.join(" · ");
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
