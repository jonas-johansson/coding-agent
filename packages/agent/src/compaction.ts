/**
 * Context compaction: token estimation, cut-point planning, and the one-shot
 * summarizer call.
 *
 * A compaction is a new `compaction` entry in the session tree. Request
 * assembly (session.ts) applies the most recent compaction on the active
 * path: everything before `firstKeptEntryId` is replaced by the summary,
 * the kept tail and later entries stay verbatim.
 */

import type {
  Provider,
  ProviderMessage,
  ProviderResponse,
  ToolDefinition,
  UsageInfo,
} from "@pace/llm";
import {
  getModelVisibleEntries,
  type SessionEntry,
} from "./session";
import { entriesToProviderMessages } from "./session";

// ── Token estimation ─────────────────────────────────────────────────────────

/** Rough char-per-token ratio used for all estimates. */
const CHARS_PER_TOKEN = 4;
/** Fixed estimate for image blocks (they dominate the char heuristic). */
const IMAGE_TOKEN_ESTIMATE = 1_600;

/** Structural block type accepted by the estimator. */
type EstimatableBlock =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: string; data: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "thinking"; thinking: string };

/**
 * Estimate the model-context size of a single entry, in tokens. Thinking
 * blocks are excluded because they are never sent back to the provider.
 */
export function estimateEntryTokens(entry: SessionEntry): number {
  const count = (blocks: readonly EstimatableBlock[]): number =>
    blocks.reduce((sum, block) => {
      if (block.type === "text") {
        return sum + block.text.length;
      }
      if (block.type === "image") {
        return sum + IMAGE_TOKEN_ESTIMATE * CHARS_PER_TOKEN;
      }
      if (block.type === "tool_use") {
        return sum + JSON.stringify(block.input ?? null).length;
      }
      return sum; // thinking blocks are never sent
    }, 0);

  switch (entry.type) {
    case "user":
      return Math.ceil(count(entry.content) / CHARS_PER_TOKEN);
    case "assistant":
      return Math.ceil(count(entry.content) / CHARS_PER_TOKEN);
    case "tool_result":
      return Math.ceil(
        entry.content.reduce(
          (sum, part) => sum + (part.type === "text" ? part.text.length : IMAGE_TOKEN_ESTIMATE * CHARS_PER_TOKEN),
          0,
        ) / CHARS_PER_TOKEN,
      );
    case "compaction":
      return Math.ceil(entry.summary.length / CHARS_PER_TOKEN);
  }
}

// ── Touched files ────────────────────────────────────────────────────────────

const FILE_TOOLS = new Set(["read", "write", "edit"]);

/**
 * Extract the file paths touched by read/write/edit tool calls in the given
 * range, de-duplicated in first-seen order. Appended to the summary as a
 * cheap rehydration hint — no LLM needed.
 */
export function extractTouchedFiles(entries: readonly SessionEntry[]): string[] {
  const files: string[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    if (entry.type !== "assistant") {
      continue;
    }
    for (const block of entry.content) {
      if (block.type !== "tool_use" || !FILE_TOOLS.has(block.name)) {
        continue;
      }
      const input = block.input as { path?: unknown } | null | undefined;
      const path = typeof input?.path === "string" ? input.path : undefined;
      if (path !== undefined && path !== "" && !seen.has(path)) {
        seen.add(path);
        files.push(path);
      }
    }
  }

  return files;
}

// ── Cut-point planning ───────────────────────────────────────────────────────

export const DEFAULT_KEEP_RECENT_TOKENS = 20_000;

export type CompactionPlan = {
  /** Earliest entry that stays in the model context verbatim. */
  firstKeptEntryId: string;
  /** Provider messages covering the summarized range (compaction-aware). */
  messagesToSummarize: ProviderMessage[];
  /** Estimated context size before the cut, in tokens. */
  tokensBeforeEstimate: number;
  /** Estimated size of the kept tail, in tokens. */
  tokensKeptEstimate: number;
  /** Files touched in the summarized range (from read/write/edit calls). */
  touchedFiles: string[];
};

function isValidCutPoint(entry: SessionEntry): boolean {
  // Never cut between a tool call and its results: only user and assistant
  // entries are valid cut points.
  return entry.type === "user" || entry.type === "assistant";
}

/**
 * Choose the cut point for a compaction: walk backward from the end until the
 * kept tail reaches `keepRecentTokens`, cutting at the most recent valid cut
 * point (user or assistant entry). Prefers a non-steering user entry (turn
 * boundary) when one exists within 2× the budget; otherwise splits the
 * oversized turn at an assistant entry. Returns null when there is nothing
 * before the cut (the whole visible context fits in the keep budget).
 */
export function planCompaction(
  entries: readonly SessionEntry[],
  options: { keepRecentTokens?: number } = {},
): CompactionPlan | null {
  const keepRecentTokens = options.keepRecentTokens ?? DEFAULT_KEEP_RECENT_TOKENS;
  const { entries: visible } = getModelVisibleEntries(entries);

  // suffix[i] = estimated tokens in visible[i..end].
  const suffix = new Array<number>(visible.length + 1);
  suffix[visible.length] = 0;
  for (let i = visible.length - 1; i >= 0; i -= 1) {
    suffix[i] = suffix[i + 1] + estimateEntryTokens(visible[i]);
  }

  // Most recent valid cut point at which the kept tail reaches the budget.
  // suffix[i] grows as i decreases, so keep walking back past entries whose
  // tail is still under budget or that are not valid cut points.
  let budgetCut = -1;
  for (let i = visible.length - 1; i >= 0; i -= 1) {
    if (suffix[i] < keepRecentTokens) {
      continue;
    }
    if (isValidCutPoint(visible[i])) {
      budgetCut = i;
      break;
    }
  }

  if (budgetCut <= 0) {
    return null;
  }

  const maxKeptTokens = keepRecentTokens * 2;
  let cutIndex = budgetCut;
  const budgetEntry = visible[budgetCut];

  if (!(budgetEntry.type === "user" && !budgetEntry.steering)) {
    // Prefer the nearest turn boundary (non-steering user entry) within 2×
    // the budget.
    for (let i = budgetCut - 1; i >= 0; i -= 1) {
      const entry = visible[i];
      if (entry.type === "user" && !entry.steering) {
        if (suffix[i] <= maxKeptTokens) {
          cutIndex = i;
        }
        break;
      }
    }
    if (cutIndex === budgetCut && budgetEntry.type === "user") {
      // Split the oversized turn at an assistant entry instead of cutting
      // before a steering message.
      for (let i = budgetCut - 1; i >= 0; i -= 1) {
        if (visible[i].type === "assistant") {
          cutIndex = i;
          break;
        }
      }
    }
  }

  if (cutIndex <= 0) {
    return null;
  }

  const summarizedEntries = visible.slice(0, cutIndex);

  return {
    firstKeptEntryId: visible[cutIndex].id,
    messagesToSummarize: entriesToProviderMessages(summarizedEntries),
    tokensBeforeEstimate: suffix[0],
    tokensKeptEstimate: suffix[cutIndex],
    touchedFiles: extractTouchedFiles(summarizedEntries),
  };
}

// ── Summarizer ───────────────────────────────────────────────────────────────

/**
 * Summarization instruction appended after the messages to summarize. The
 * messages are an exact prefix of what the main loop just sent (same system
 * prompt and tools), so on cache-capable providers the input is mostly a
 * cache read.
 */
export const COMPACTION_PROMPT = `Summarize the conversation above for a coding assistant that will continue the work with no other memory of it.

Respond with text only — do not call tools. Use exactly these headings:

## Goal
## User requests (verbatim, oldest → newest)
## Decisions and rationale
## Work completed (files, paths, what changed)
## Current state / in progress
## Errors encountered and fixes
## Next steps
## Key context (commands, config, gotchas)

Verbatim user requests are critical: quote each user request word for word, oldest to newest, so no requirement is lost.`;

export type SummarizeForCompactionParams = {
  provider: Provider;
  model: string;
  /** Same system prompt as the main loop, so the prefix stays cache-shared. */
  system: string;
  toolDefs: ToolDefinition[];
  providerOptions?: Record<string, unknown>;
  maxTokens: number;
  /** The messages to summarize (plan.messagesToSummarize). */
  messages: ProviderMessage[];
  /** User focus instructions passed to `/compact`. */
  focus?: string;
  signal?: AbortSignal;
};

function responseText(content: ProviderResponse["content"]): string {
  return content
    .filter((block) => block.type === "text")
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("")
    .trim();
}

/**
 * One-shot summarizer call: no agent loop, no tool execution. Sends the
 * messages to summarize followed by one user message with the summarization
 * instructions. If the model responds without text (tried to call a tool),
 * retries once with `tools: []`; throws if that also produces no text.
 */
export async function summarizeForCompaction(
  params: SummarizeForCompactionParams,
): Promise<{ summary: string; usage: UsageInfo }> {
  const instruction = params.focus !== undefined && params.focus !== ""
    ? `${COMPACTION_PROMPT}\n\nPay particular attention to: ${params.focus}`
    : COMPACTION_PROMPT;

  const messages: ProviderMessage[] = [
    ...params.messages,
    { role: "user", content: [{ type: "text", text: instruction }] },
  ];

  const run = async (tools: ToolDefinition[]): Promise<ProviderResponse> => {
    const stream = await params.provider.stream({
      model: params.model,
      system: params.system,
      messages,
      tools,
      maxTokens: params.maxTokens,
      providerOptions: params.providerOptions,
      signal: params.signal,
    });
    for await (const _event of stream) {
      // Consume the stream so finalMessage() can return the complete response.
    }
    return stream.finalMessage();
  };

  let response = await run(params.toolDefs);
  let text = responseText(response.content);
  if (text === "") {
    // The model tried to call a tool; retry once without tools.
    response = await run([]);
    text = responseText(response.content);
  }
  if (text === "") {
    throw new Error("Compaction summarizer returned no text");
  }

  return { summary: text, usage: response.usage };
}
