# Context compaction in coding agents

Research into how three coding agents — **Claude Code**, **Pi** (`@earendil-works/pi-coding-agent`), and **OpenCode** (`anomalyco/opencode`) — manage their context window when long sessions approach the limit.

Compiled 2026-07-03. Pace itself currently has **no** compaction implementation (the only "compact" reference in `src/` is an unrelated "compact skill listing" helper in `src/skill.ts`); this document is reference material for designing one.

## TL;DR — the three philosophies

| | Claude Code | Pi | OpenCode |
|---|---|---|---|
| Layers | Multi-tier cascade (≥4) | Single layer + branch summary | Two-tier (prune → summarize) |
| Auto-trigger | `context − min(maxOut, 20K) − 13K` (~83% of 200K) | `context − 16,384` (~92%) | `input − min(20K, maxOut)` (~96–99%) |
| Token source | Hybrid: API usage + char/4 heuristic (4/3× padding) | Actual API usage from last assistant msg | Actual API usage (char/4 only for prune estimates) |
| Cheapest tier | Microcompaction via `cache_edits` (no LLM, cache-friendly) + Session-Memory compact (no LLM) | None — default condenser does no LLM work until triggered | Prune (no LLM) |
| Old tool results | Placeholder replacement, or deleted from server cache without busting prefix | Kept verbatim in JSONL; only the kept window is sent | Timestamp-marked & hidden (`"[output truncated by compaction]"`), data stays in DB |
| History preservation | Replaced in-context | Lossy in-context, **full JSONL retained** (`/tree` to revisit) | Replaced in-context |
| Post-compact | Rehydrates recent files, skills, plan, todos + continuation msg | Reloads `summary + messages[from firstKeptEntryId]` | Auto-replays last user msg + synthetic "continue" msg |
| Manual trigger | `/compact [focus]` | `/compact [instructions]` | `/compact` |

---

## Claude Code — the layered cascade

Claude Code treats compaction as an *operational mechanism*, not "summarize and hope." It uses a tiered approach, cheapest first:

### 1. Microcompaction (no LLM)
When tool outputs get bulky, it offloads old results from `Bash, Read, Grep, Glob, WebFetch, WebSearch, FileEdit, FileWrite` to disk and keeps only the most recent ~5 inline. Cleverly, it uses Anthropic's `cache_edits` capability to delete them from the **server-side cache without invalidating the cached prefix** — so prompt-cache hit rates barely suffer. Triggered by a warning threshold, a 60-min idle, or a count limit.

### 2. Session-Memory compact (no LLM, experimental)
A background process continuously maintains a structured markdown notes file. When compaction is needed, it just *uses those notes as the summary* — skipping the API call entirely. Only falls through to a real LLM summary if this is unavailable/insufficient. Template is user-customizable at `~/.claude/session-memory/config/template.md`.

### 3. Full auto-compact (1 LLM call)
The core layer.
- Threshold: `contextWindow − min(maxOutputTokens, 20,000) − 13,000`. For a 200K model → **167K (83.5%)**; for a 1M model → ~967K. The 20K reserve comes from production stats (p99.99 summary = 17,387 tokens).
- Runs a **forked one-turn agent** sharing the parent's cache prefix, `maxTurns=1`, **tools disabled** (an isolated summarizer calling tools can fail — Sonnet 4.6 hit 2.79% tool-trigger failure vs 0.01% on 4.5), output capped at 20K.
- Output is two XML blocks: `<analysis>` (scratchpad, later stripped by `formatCompactSummary`) + `<summary>` (intent, decisions, errors, fixes, pending work, **user prompts preserved verbatim** to prevent requirement drift).
- **Circuit breaker**: 3 consecutive failures → stop trying for the session. Counter resets on success.
- Cache-sharing feature flag `tengu_compact_cache_prefix` tries to reuse a compaction result from another session with the same prefix.

### 4. Manual `/compact [focus]`
Same path, at a task boundary, with optional focus instructions; not subject to the circuit breaker. PreCompact/PostCompact hooks let extensions inspect/modify before and react after.

### 5. Sub-agent compact
Runs before a turn in the sub-agent loop (sub-agents keep big reads out of your main context).

### Guardrails
- **Blocking limit** (~88.5% usable context): stops outgoing requests before a 413.
- **Reactive fallback**: deletes earliest chronological messages after a `prompt_too_long` API error. Groups messages by API round (assistant message-ID boundaries), drops oldest groups until the token gap is covered; falls back to dropping 20% of groups when the gap is unparseable.

### Rehydration (the standout)
After compaction it re-reads the **top 5 recently-accessed files** (50K budget, 5K/file), re-injects invoked skills (25K, 5K/skill), the active plan file, plan-mode instructions, deferred tool deltas, agent-listing deltas, MCP instruction deltas, and session-start hook outputs — then a continuation message tells Claude to resume without re-asking.

### Token counting
Hybrid system designed for accuracy during streaming with parallel tool calls. Walks messages backwards to find the last message with API usage data, then estimates new messages via `character/4 ≈ token` with 4/3× conservative padding. Final count = last known API `input_tokens` + estimated tokens for new messages.

### Env knobs
`CLAUDE_CODE_AUTO_COMPACT_WINDOW`, `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`, `DISABLE_AUTO_COMPACT`, `DISABLE_COMPACT`, `autoCompactEnabled` setting.

---

## Pi — append-only, lossy-in-context but history-retained

Pi (pi.dev) is the most *minimal and explicit* of the three. It has two related mechanisms sharing one summary format.

### Compaction
- Trigger: `contextTokens > contextWindow − reserveTokens`, `reserveTokens` default **16,384** (~92% fill on a 200K model). Uses **actual API usage** from the last assistant message.
- Flow:
  1. **Find cut point** — walk backwards from the newest message accumulating token estimates until `keepRecentTokens` (default **20K**) is reached. Cuts at **turn boundaries**; never cuts at a tool result (it must stay with its call).
  2. **Extract** messages from the previous kept boundary (or session start) up to the cut point.
  3. **Generate summary** via a direct `pi-ai` call (not the full agent loop), no tools, `maxTokens = 0.8 × reserveTokens`, thinking **off**. Passes the *previous* summary as iterative context so summaries chain coherently.
  4. **Append a `CompactionEntry`** — appended to the JSONL, **never inserted mid-file**. The full history stays on disk.
  5. **Reload** — the session rebuilds as `system prompt + summary + messages from firstKeptEntryId onwards`.

```typescript
interface CompactionEntry<T = unknown> {
  type: "compaction";
  id: string;
  parentId: string;
  timestamp: number;
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  fromHook?: boolean;       // true if provided by extension (legacy field name)
  details?: T;              // implementation-specific data
}

// Default compaction uses this for details:
interface CompactionDetails {
  readFiles: string[];
  modifiedFiles: string[];
}
```

```
Before compaction:

  entry:  0     1     2     3      4     5     6      7      8     9
        ┌─────┬─────┬─────┬─────┬──────┬─────┬─────┬──────┬──────┬─────┐
        │ hdr │ usr │ ass │ tool │ usr │ ass │ tool │ tool │ ass │ tool│
        └─────┴─────┴─────┴──────┴─────┴─────┴──────┴──────┴─────┴─────┘
                └────────┬───────┘ └──────────────┬──────────────┘
               messagesToSummarize            kept messages
                                   ↑
                          firstKeptEntryId (entry 4)

After compaction (new entry appended):

  entry:  0     1     2     3      4     5     6      7      8     9     10
        ┌─────┬─────┬─────┬─────┬──────┬─────┬─────┬──────┬──────┬─────┬─────┐
        │ hdr │ usr │ ass │ tool │ usr │ ass │ tool │ tool │ ass │ tool│ cmp │
        └─────┴─────┴─────┴──────┴─────┴─────┴──────┴──────┴─────┴─────┴─────┘
               └──────────┬──────┘ └──────────────────────┬───────────────────┘
                 not sent to LLM                    sent to LLM
                                                         ↑
                                              starts from firstKeptEntryId

What the LLM sees:

  ┌────────┬─────────┬─────┬─────┬──────┬──────┬─────┬──────┐
  │ system │ summary │ usr │ ass │ tool │ tool │ ass │ tool │
  └────────┴─────────┴─────┴─────┴──────┴──────┴─────┴──────┘
       ↑         ↑      └─────────────────┬────────────────┘
    prompt   from cmp          messages from firstKeptEntryId
```

### Split turns
A "turn" starts with a user message and includes all assistant responses and tool calls until the next user message. Normally compaction cuts at turn boundaries. When a *single* turn exceeds `keepRecentTokens`, the cut point lands mid-turn at an assistant message, and Pi generates **two** summaries and merges them:
1. History summary (previous context, if any)
2. Turn-prefix summary (the early part of the split turn)

### Repeated compactions
The new summarized span starts at the previous compaction's `firstKeptEntryId`, not at the compaction entry itself — so messages that survived an earlier compaction get folded back into the next pass. `tokensBefore` is recalculated from the rebuilt session context before writing the new `CompactionEntry`.

### Cut point rules
Valid cut points: user messages, assistant messages, BashExecution messages, custom messages (`custom_message`, `branch_summary`). Never cut at tool results.

### Cumulative file tracking
File reads/edits are extracted and appended to every summary (both compaction and branch summaries).

### Branch summarization
When you `/tree`-navigate to a different branch, Pi offers to summarize the work you're leaving and injects that context into the new branch (finds the common ancestor first). This is the mechanism that preserves context across branch switches.

### Extensibility
Extensions can override summarization via `session_before_compact` / `session_before_tree` hooks to do topic-based, code-aware, or alternate-model compaction. Extensions can store any JSON-serializable data in the `details` field.

### Settings
`~/.pi/agent/settings.json` or `<project-dir>/.pi/settings.json`:

| Setting | Default | Description |
|---|---|---|
| `enabled` | `true` | Enable auto-compaction |
| `reserveTokens` | `16384` | Tokens to reserve for LLM response |
| `keepRecentTokens` | `20000` | Recent tokens to keep (not summarized) |

Disable auto-compaction with `"enabled": false`; `/compact` still works manually.

---

## OpenCode — stepped governance with non-destructive pruning

OpenCode (`anomalyco/opencode`, TypeScript + Effect-TS) explicitly tries cheap measures first and only calls the LLM when truly necessary.

### 1. Overflow detection (`isOverflow`)
```typescript
const COMPACTION_BUFFER = 20_000;

export async function isOverflow(input: {
  tokens: MessageV2.Assistant["tokens"];
  model: Provider.Model;
}) {
  const config = await Config.get();
  if (config.compaction?.auto === false) return false;
  const context = input.model.limit.context;
  if (context === 0) return false;

  const count = input.tokens.total ||
    input.tokens.input + input.tokens.output +
    input.tokens.cache.read + input.tokens.cache.write;

  const reserved = config.compaction?.reserved ??
    Math.min(COMPACTION_BUFFER, ProviderTransform.maxOutputTokens(input.model));
  const usable = input.model.limit.input
    ? input.model.limit.input - reserved
    : context - reserved;

  return count >= usable;
}
```
Fires at **~96–99% fill (latest of the three)**. Uses real API usage counts. The 20K reserve ensures there's still room for a final response and a compaction summary even when overflow is detected.

### 2. Prune (no LLM, non-destructive)
Constants: `PRUNE_MINIMUM = 20_000`, `PRUNE_PROTECT = 40_000`, `PRUNE_PROTECTED_TOOLS = ["skill"]`.

Walks backwards through message history:
1. Protect all content from the **last 2 conversation turns**.
2. Protect tool outputs within the last **40K tokens**.
3. Replace older tool outputs beyond the protection zone with `"[output truncated by compaction]"` and stamp `compacted = Date.now()`.
4. `skill` tool outputs are **never** cleaned (critical for subsequent behavior).

The data **stays in the database** — it's just hidden from subsequent requests. Only prunes if it would free at least `PRUNE_MINIMUM` (20K) tokens.

### 3. Full compaction (LLM)
If prune isn't enough, a **hidden dedicated agent** calls the LLM with the prompt in `agent/prompt/compaction.txt` to produce a fixed **5-heading** summary that replaces the old message history.

### 4. Post-compact continuation
OpenCode **auto-replays the last user message** so the agent keeps going unaware that compression happened. An optional `experimental.compaction.autocontinue` plugin injects a synthetic *"Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed."* message. When overflow was caused by oversized media attachments, the message instead explains the attachments were too large and suggests retrying with smaller/fewer files.

### Token estimation
Precise token counts come from the LLM provider's response `usage` metadata. The fast `Token.estimate()` (`Math.ceil(text.length / 4)`) is only used in the Prune strategy to judge "approximately" how many tokens have been cleaned.

### Config
`compaction.auto` (true), `compaction.prune` (true), `compaction.reserved`. Model limits configurable per-model in config (`limit.context`, `limit.input`, `limit.output`).

### Known rough edges
- Sub-agents reportedly lack compaction and hit `context_length_exceeded` (the primary agent handles context management; sub-agents do not, in ~100% of multi-sub-agent cases).
- Bugs where `compaction.auto: false` was bypassed by the provider-overflow recovery path (which hardcoded `auto: true`), and where auto-compaction fired at only ~27% context usage due to large media-attachment payloads rather than token-threshold overflow.

---

## The core design trade-off each makes

- **Claude Code** invests heavily in *avoiding* the LLM call (microcompact + session memory) and, when it must summarize, in **rehydrating a productive working state** afterward. Most expensive to build but gives the smoothest continuity — at the cost of significant internal complexity.
- **Pi** bets on **transparency and recoverability**: append-only entries, full JSONL retained, branch summarization, and an explicit `firstKeptEntryId` model that chains summaries correctly. Simplest internals, fully user/extensible, and you can always `/tree` back to lost context. Does the least proactive work before summarizing.
- **OpenCode** sits in the middle with **non-destructive pruning as the cheap tier** (timestamp-hiding rather than deletion) and fires latest (≈97%), relying on real API token counts. Its signature move is **auto-replaying the last instruction** so the model doesn't notice the compression.

## Shared insights

- The art is *what to keep vs. discard*: old tool results are the safest first thing to drop; recent turns and file state are the most valuable to preserve.
- The cheapest compaction is the one that never calls the LLM at all — all three have a no-LLM tier (microcompact/session-memory for Claude Code, prune for OpenCode; Pi's "no work until triggered" default).
- Preserve **user prompts verbatim** in summaries to prevent requirement drift (Claude Code does this explicitly).
- Real API usage token counts beat local estimation for trigger accuracy; local char/4 heuristics are only good enough for the cheap tiers.
- Reserving output space (16–20K) before the threshold is universal — it guarantees room for both the summary itself and a final response.
- Continuity after compaction matters as much as the compression: re-reading recent files, replaying the last instruction, or rehydrating todos/plans is what prevents the model from stalling.

## Sources

- Claude Code docs — https://code.claude.com/docs/en/context-window
- Claude Platform compaction API — https://platform.claude.com/docs/en/build-with-claude/compaction
- "Inside Claude Code's Compaction System" — https://decodeclaude.com/compaction-deep-dive/
- Claude Code compact-system architecture (community reverse-engineering) — https://github.com/openedclaude/claude-reviews-claude/blob/main/architecture/11-compact-system.md
- "06 — Context & Autocompact · Inside Claude Code" — https://manavgup.github.io/shipai/deep-dives/claude-code/06-context-autocompact.html
- Claude Code compaction deep dive v2.1.68 (deobfuscated) — https://gist.github.com/sam-saffron-jarvis/9d8e291c4e696ac7948702d6c4884448
- "Context Compaction in Claude Code: A Five-Layer Cascade" — https://finisky.github.io/en/claude-code-context-compaction/
- "Claude Code Four-Tier Context Compression Architecture" — https://blog.4sapi.com/blog/claude-code-four-tier-context-compression
- Anthropic — "Effective context engineering for AI agents" — https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- Pi compaction docs — https://pi.dev/docs/latest/compaction
- Pi compaction source — https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/compaction.md
- Pi compaction implementation — https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/src/core/compaction/compaction.ts
- Pi compaction design issue — https://github.com/earendil-works/pi/issues/92
- OpenCode compaction book — https://www.opencodebook.xyz/en/chapter_04_session_system/4.5_compaction_context_window_management
- OpenCode compaction source — https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/compaction.ts
- OpenCode auto-compaction issue — https://github.com/anomalyco/opencode/issues/8089
- OpenCode `compaction.auto=false` bypass issue — https://github.com/anomalyco/opencode/issues/30664
- "Shedding Heavy Memories: Context Compaction in Codex, Claude Code, and OpenCode" — https://justin3go.com/en/posts/2026/04/09-context-compaction-in-codex-claude-code-and-opencode
- "How AI Coding Agents Handle a Full Context Window" — https://wasnotwas.com/writing/context-compaction/
