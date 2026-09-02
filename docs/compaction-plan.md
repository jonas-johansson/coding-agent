# Compaction — implementation plan

Companion to `compaction-research.md`. This is the concrete design for Pace.

## Requirements

- **Auto-compaction** kicks in when the context reaches **150k tokens** (configurable; clamped to the model's window).
- **Manual trigger** via `/compact [focus instructions]`.
- Fits the existing append-only session tree — nothing is ever deleted from disk. `/tree` still shows the full history.
- Works in both the TUI (`app.ts`) and headless mode (`headless.ts`).
- No startup-time cost (no new dependencies, no eager work).

## How it fits the current architecture

| Concern | Where it lives today | Compaction touch point |
|---|---|---|
| Conversation storage | `packages/agent/src/session.ts` — tree of `user` / `assistant` / `tool_result` entries, `activeEntryId`, `getActivePath()` | New `compaction` entry type |
| Request assembly | `entriesToProviderMessages()` in `session.ts`, called via `getMessages` on every loop iteration | Honors the last compaction entry on the path |
| Turn execution | `runAgentLoop()` in `packages/agent/src/loop.ts` — `takeSteeringMessages` → `getMessages` → stream → tools | New `compaction` param checked at the same boundary |
| Context size | `usage.inputTokens` from each response (includes cached tokens — `computeCost` subtracts cache tokens from it). TUI shows `lastInputTokens + lastOutputTokens` | Trigger measure |
| Side LLM calls | `maybeGenerateSessionTitleFromFirstMessage()` in `app.ts` does a one-shot `provider.stream()` | Summarizer follows the same pattern |
| Slash commands | `slashCommands` list + `handleCommand()` switch in `app.ts` | `/compact` |
| Rendering | `session-view.ts` maps entries → `RenderBlock`s; replay and live UI share this | Render compaction entries |
| Config | `apps/pace/src/config.ts` (zod schema, `~/.config/pace/config.json`) | `compaction` section |

## Design

### 1. Data model — `CompactionEntry`

A compaction is a **new entry in the session tree**, appended as the child of the current active entry (or into the turn draft when mid-turn). Pi's `CompactionEntry` adapted to Pace's tree:

```ts
export type CompactionEntry = BaseEntry & {
  type: "compaction";
  /** Model-facing summary of everything on the path before `firstKeptEntryId`. */
  summary: string;
  /**
   * Id of the earliest ancestor that stays in the model context verbatim.
   * Null when nothing is kept (the whole path before this entry is summarized).
   */
  firstKeptEntryId: string | null;
  /** Context size (last response's input+output tokens) right before compaction. */
  tokensBefore: number;
  /** Estimated context size after compaction (char/4 heuristic). */
  tokensAfter: number;
  trigger: "auto" | "manual";
  /** User focus instructions passed to `/compact`. */
  focus?: string;
  /** Summarizer usage/cost, rolled into session cost like assistant entries. */
  provider: string;
  modelId: string;
  tokensIn: number;
  tokensOut: number;
  cost: number;
};
```

Changes in `session.ts`:

- Add the type to `SessionEntry`, `createCompactionEntry()`, and the `isSessionEntry` validator (`case "compaction"`). Keep `SESSION_SCHEMA_VERSION = 1` — old sessions load unchanged; sessions containing a compaction are simply not loadable by older builds (the validator already rejects unknown types).
- Roll `cost` into `toSessionListItem()`; `app.ts` `refreshSessionStatsFromSession()` mirrors it.
- New pure helper, used by request assembly, the summarizer, and the token meter:

```ts
/** Apply the most recent compaction on a path. */
export function getModelVisibleEntries(entries: readonly SessionEntry[]): {
  summary: string | undefined;
  entries: SessionEntry[]; // kept tail + everything appended after the compaction
}
```

  Logic: find the **last** `compaction` entry in the path. Visible = `[entries from firstKeptEntryId up to the compaction) + (entries after the compaction)]`. If `firstKeptEntryId` is null or not found on the path, keep nothing before the compaction. With no compaction, return all entries. Entries after the compaction are always included, so repeated compactions chain naturally: the second summarizer call sees `[summary1, kept1…, new turns…]` as its input.

### 2. Request assembly

`entriesToProviderMessages(entries)` becomes:

```
const { summary, entries: visible } = getModelVisibleEntries(entries);
messages = [...(summary ? [summaryUserMessage(summary)] : []), ...convert(visible)];
```

The summary is a **standalone `user` message**:

```
<conversation_summary>
…summary…
</conversation_summary>

The conversation above this point was compacted. Continue from this state; do not re-ask for information already captured here.
```

It may be followed directly by another user message (the first kept entry). Consecutive user messages are already produced today by steering (`tool_result` user message → steering user message) and all providers accept them, so no synthetic assistant acknowledgment is needed. Because the summary sits at the very front and never changes until the next compaction, it is prompt-cache friendly.

`sessionToProviderMessages(session, draft)` needs no change — it already concatenates path + draft before calling `entriesToProviderMessages`, so a compaction entry sitting in the draft works mid-turn.

### 3. Cut point selection — `planCompaction()`

New module `packages/agent/src/compaction.ts` (exported from `index.ts`).

```ts
export function planCompaction(
  entries: readonly SessionEntry[],          // full active path (+ draft)
  options: { keepRecentTokens: number },     // default 20_000
): CompactionPlan | null
```

- Operate on `getModelVisibleEntries(entries)` so a previous compaction is respected.
- Walk backward accumulating `estimateEntryTokens()` (char/4 on text and JSON-stringified tool inputs, ~1,600 per image, thinking blocks excluded since they are never sent).
- **Valid cut points are `user` and `assistant` entries — never `tool_result`**, so a tool call always stays paired with its results.
- Choose the most recent valid cut point at which the kept tail reaches `keepRecentTokens`. Prefer a **non-steering `user` entry** (turn boundary) when one exists within 2× the budget; otherwise split the oversized turn at an `assistant` entry. This mirrors Pi's turn-boundary rule plus split-turn fallback.
- Return `null` when there is nothing before the cut (the whole context fits in the keep budget) — the caller reports "Nothing to compact".
- Plan output: `{ firstKeptEntryId, messagesToSummarize: ProviderMessage[], tokensBeforeEstimate, tokensKeptEstimate, touchedFiles }`.

`touchedFiles` is extracted deterministically from `read`/`write`/`edit` `tool_use` inputs in the summarized range and appended to the summary as a "Files touched" list (Pi's `readFiles`/`modifiedFiles` idea, no LLM needed). It gives the model a cheap rehydration hint.

Manual `/compact` uses the same plan (keeps the recent ~20k). One code path, and the last exchange survives verbatim which guards against requirement drift. (Alternative if we later want a "clean slate": `keepRecentTokens: 0`.)

### 4. Summarizer — `summarizeForCompaction()`

```ts
export async function summarizeForCompaction(params: {
  provider: Provider;
  model: string;
  system: string;
  toolDefs: ToolDefinition[];
  providerOptions?: Record<string, unknown>;
  maxTokens: number;
  messages: ProviderMessage[];   // plan.messagesToSummarize
  focus?: string;
  signal?: AbortSignal;
}): Promise<{ summary: string; usage: UsageInfo }>
```

- One-shot `provider.stream()` (same pattern as the title generator), **no agent loop, no tool execution**.
- Sends **the same system prompt, tool definitions, and model as the main loop**, with the messages to summarize followed by one extra user message containing the summarization instructions. The messages are an exact prefix of what the main loop just sent, so on cache-capable providers the 150k input is mostly a cache read (~10% of full price). This is the Claude Code "forked one-turn agent sharing the cache prefix" trick.
- The instruction tells the model to answer with text only. If the response has no text block (model tried to call a tool), **retry once with `tools: []`**. If still empty, throw.
- `maxTokens = min(modelConfig.maxOutputTokens, 16_000)` so thinking variants have room.
- Output format requested from the model (headings, not XML, so it renders nicely when expanded in the TUI):

  ```
  ## Goal
  ## User requests (verbatim, oldest → newest)
  ## Decisions and rationale
  ## Work completed (files, paths, what changed)
  ## Current state / in progress
  ## Errors encountered and fixes
  ## Next steps
  ## Key context (commands, config, gotchas)
  ```

  Verbatim user requests are the main defense against requirement drift. `focus` (from `/compact <text>`) is appended as "Pay particular attention to: …".
- Model selection: default is the **current model** (cache sharing + best quality). `compaction.model` in config can override it (e.g. a cheap flash model), at the cost of the cache hit.

### 5. Trigger — auto

Add an optional policy object to `AgentLoopParams` in `loop.ts`:

```ts
/** Auto-compaction policy. Omit to disable. */
compaction?: {
  /** Compact before the next request once the context reaches this size. */
  thresholdTokens: number;
  /** Context size carried into this run (last assistant entry on the path). */
  initialContextTokens: number;
  /**
   * Compact the context so the next `getMessages` returns a smaller payload.
   * Called at most once per assistant response. Must not throw except for abort.
   */
  compact: () => Promise<void>;
};
```

Loop changes (small, keeps the loop session-agnostic like `getMessages`):

- Track `contextTokens` = `initialContextTokens`, updated to `inputTokens + outputTokens` after each response.
- At the iteration boundary, after `takeSteeringMessages` and before `getMessages`: if `compaction && contextTokens >= thresholdTokens && !compactedSinceLastResponse` → `await compaction.compact()`, set the flag. The flag resets on the next response. Steering first, so the newest user instruction is guaranteed to land in the kept tail.
- Abort errors propagate as today; the turn is cancelled and no compaction entry is written.

Effective threshold computed by the caller:

```
effective = min(config.compaction.thresholdTokens /* 150_000 */,
                contextWindow - maxOutputTokens - 8_000)
```

The clamp matters: the catalog has 128k and 32k models where a flat 150k would never fire before a context overflow. Disabled when `contextWindow` is 0/unknown.

**Circuit breaker** (app level, per session): 3 consecutive summarizer failures → auto-compaction is disabled for the rest of the session with a visible notice; a success resets the count. Manual `/compact` is never blocked by it.

### 6. Trigger — manual `/compact [focus]`

In `handleCommand()`:

1. Refuse while `promptRunning` (already the case for all slash commands via `queueSteeringMessage`).
2. `planCompaction(getActivePath(activeSession))` → if `null`, show "Nothing to compact (context ≈ Nk tokens)".
3. Set `promptRunning`, `currentAbortController`, `tui.setRunning(true, …)` so **Esc aborts** the summarizer.
4. Add a `Compacting context…` block in `running` state; call the summarizer.
5. Append the `CompactionEntry` with `appendEntries(activeSession, [entry])`, `saveSession`, `rebuildTuiFromSession()`, `refreshSessionStatsFromSession()`.
6. Status line: `Compacted 132k → ~18k tokens`.

Add `{ label: "/compact", detail: "Summarize older context to free up the window", insertText: "/compact " }` to `slashCommands`.

### 7. Shared app-side routine

Both triggers funnel through one function in `app.ts`:

```ts
async function compactContext(opts: {
  trigger: "auto" | "manual";
  focus?: string;
  draft?: TurnDraft;      // present when called from the loop mid-turn
  signal?: AbortSignal;
}): Promise<CompactionEntry | null>
```

- Builds the entry list from `getActivePath(activeSession)` + `draft?.entries`.
- Mid-turn: `appendTurnDraftEntry(draft, entry)` — the draft's normal commit path persists it, so no early commit or draft restart is needed. Idle: `appendEntries` + `saveSession`.
- Updates the token meter: `lastInputTokens = entry.tokensAfter; lastOutputTokens = 0`, and `ContextInfo` gains an optional `estimated: boolean` so the status bar shows `~18k (9%)` until the next real usage arrives.
- Adds `accumulatedCost += entry.cost`.
- UI feedback: a block with role `assistant`, title `Context compacted · 132k → ~18k tokens`, content = the summary, `collapsed: true` (expandable like reasoning blocks; `resolveCollapsed` already supports explicit `collapsed`).

`headless.ts` gets a thinner equivalent (no TUI): same plan/summarize/append steps, and `stream-json` emits `{ type: "compaction", tokensBefore, tokensAfter, cost }`.

### 8. Rendering & navigation

- `session-view.ts` `entriesToRenderBlocks`: `case "compaction"` → the collapsed block above, keyed `entry:<id>`. `getTurnSummary` and the trailing turn-summary check already ignore non-assistant/user types; no change.
- `sessionToTreeOverlayEntries` already filters to user/assistant and re-links parents through hidden entries, so compaction nodes are invisible in `/tree` and the tree stays connected.
- `navigateToEntry()`: when jumping to a user entry it walks up to the nearest `user`/`assistant` parent so a resubmit creates a sibling branch. Extend the stop condition to include `compaction`, so branching from a post-compaction message keeps the compaction instead of silently restoring the full 150k context. Branching to a point *before* a compaction restores the full context by design (matches Pi); auto-compaction will simply fire again.
- `/undo` (`undoLastUserTurn`) moves to the parent of the last user entry — if that is a compaction entry, the compaction survives. Correct as is.

### 9. Config

`~/.config/pace/config.json`:

```json
{
  "compaction": {
    "auto": true,
    "thresholdTokens": 150000,
    "keepRecentTokens": 20000,
    "model": "opencode/deepseek-v4-flash:nothink"
  }
}
```

All optional. `model` is parsed with `parseModelSelection` like `sessionTitleModel`. Defaults: `auto: true`, `thresholdTokens: 150_000`, `keepRecentTokens: 20_000`, `model` = current model.

### 10. Failure handling

| Failure | Behavior |
|---|---|
| Summarizer network/API error | Error block; context untouched; auto: count toward circuit breaker |
| Esc during compaction | Abort error propagates; mid-turn the turn cancels as today; idle `/compact` shows "Cancelled" |
| Model returns tool calls / no text | Retry once with `tools: []`; then treat as failure |
| `firstKeptEntryId` not on path (corrupt) | Treat as "keep nothing"; never throw during request assembly |
| Context still over threshold after compaction | Fires again after the next response (flag resets); each pass shrinks the context |

Out of scope for v1 (tracked as follow-ups): reactive fallback on `prompt_too_long`/413 errors, subagent compaction, no-LLM pruning tier (OpenCode-style tool-output hiding), re-reading recently touched files after compaction.

## Implementation steps

1. **`packages/agent/src/session.ts`** — `CompactionEntry` type, `createCompactionEntry`, validator case, `getModelVisibleEntries`, `entriesToProviderMessages` update, cost rollup in `toSessionListItem`.
2. **`packages/agent/src/compaction.ts`** (new) — `estimateEntryTokens`, `extractTouchedFiles`, `planCompaction`, `COMPACTION_PROMPT`, `summarizeForCompaction`, `buildSummaryMessage`. Export from `index.ts`.
3. **`packages/agent/src/loop.ts`** — `compaction` param, `contextTokens` tracking, boundary check, `compactedSinceLastResponse` flag.
4. **`apps/pace/src/config.ts`** — `compaction` schema + defaults.
5. **`apps/pace/src/view-model.ts`** — `ContextInfo.estimated?: boolean`; `tui.ts` `formatContextInfo` prefixes `~`.
6. **`apps/pace/src/session-view.ts`** — render compaction entries.
7. **`apps/pace/src/app.ts`** — `compactContext()`, `effectiveCompactionThreshold()`, wire `compaction` into `runAgentLoop`, `/compact` command + slash entry, circuit breaker state, `refreshSessionStatsFromSession` (cost + `tokensAfter` when a compaction is the newest entry), `navigateToEntry` stop condition.
8. **`apps/pace/src/headless.ts`** — wire `compaction`, emit stream-json event.
9. **Tests** (below), then `npm run lint`, `npm run build`, `npm test`.
10. **Docs** — README section for `/compact` and the config keys; remove the bare "Compaction" line from `BACKLOG.md`.

Steps 1–3 are pure library work and fully testable with the existing mock provider before any UI is touched.

## Tests

`test/compaction.test.ts` (new):
- `planCompaction`: cuts at the latest turn boundary reaching the budget; never cuts at a `tool_result`; splits an oversized turn at an `assistant` entry; returns `null` when everything fits; respects a prior compaction (operates on the visible range).
- `getModelVisibleEntries` / `entriesToProviderMessages`: summary emitted first as a user message; kept tail follows; entries appended after the compaction are included; only the **last** compaction applies; missing `firstKeptEntryId` → keep nothing.
- `summarizeForCompaction` with a scripted provider: request carries the same system/tools plus the instruction message; `focus` appears in the instruction; tool-only response triggers the `tools: []` retry; empty retry throws.
- `estimateEntryTokens` sanity; `extractTouchedFiles` picks up read/write/edit paths and de-duplicates.
- Session round-trip: `saveSession`/`loadSession` with a compaction entry validates.

`test/loop.test.ts` additions:
- `compact` is called before the request once `initialContextTokens ≥ threshold` (first iteration).
- Called before the second request when the first response's usage crosses the threshold; **not** called twice without an intervening response.
- Not called when `compaction` is omitted.
- Abort inside `compact` cancels the run.

`test/headless.test.ts` addition:
- Scripted run whose first response reports usage over a low threshold → saved session contains a `compaction` entry; `stream-json` output includes the `compaction` event.

## Decisions to confirm

1. **Threshold clamp** — `min(150k, contextWindow − maxOutputTokens − 8k)` so 128k/32k models still compact. OK?
2. **Summarizer model** — current model with shared system/tools for cache hits (recommended), overridable via `compaction.model`. OK?
3. **Manual `/compact` keeps the recent ~20k** (same plan as auto) rather than summarizing everything. OK, or should manual be a full clean slate?
4. **Summary as a standalone user message** (relies on consecutive-user-message support, which steering already exercises) vs. merging it into the first kept user message. Standalone recommended.
