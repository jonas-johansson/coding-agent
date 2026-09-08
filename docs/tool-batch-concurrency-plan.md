# Mixed tool batches — concurrency plan

The loop currently executes a batch of tool calls all-or-nothing: if *any* call
in the assistant turn uses a non-safe tool, the *entire* batch runs
sequentially. This plan changes that so concurrency-safe calls (subagents,
reads, web tools, MCP) still run concurrently inside mixed batches, while
exclusive calls (bash, write, edit) keep strict ordering guarantees.

## Problem

When the model emits five tool calls in one turn — four `agent` delegations
plus one `bash` — the batch takes `a1 + a2 + a3 + a4 + b` wall-clock time even
though the four subagent runs are independent and each takes tens of seconds
to minutes. The single bash call demotes everything to one-at-a-time
execution.

## Current behavior

The decision lives in one place, `packages/agent/src/loop.ts`:

- `hasExclusiveTool()` (loop.ts:178–183) returns true when any tool use in the
  batch resolves to a descriptor whose `concurrency !== "safe"`. Unknown tools
  count as exclusive (conservative default).
- `runAgentLoop()` (loop.ts:290–297) branches on it:
  - **Any exclusive tool present** → `for` loop, one call at a time, in
    tool-call order, `throwIfAborted` before each start.
  - **All safe** → `Promise.all` over every call.

Everything downstream is already order-independent:

- Results are collected into a `completed` map keyed by tool_use id and
  re-emitted in tool-call order (loop.ts:306–318), so persistence
  (`onToolResults`) and provider messages stay valid regardless of completion
  order.
- `onToolResult` fires per call as it finishes; the TUI already renders
  concurrent spinners for the all-safe path (app.ts:2142–2155).
- Only `AbortError` breaks a batch (executeToolCall rethrows it, loop.ts:172);
  ordinary tool failures become `is_error` results and never affect siblings.

Concurrency flags today (`ToolConcurrency = "safe" | "exclusive"`,
core.ts:55):

| Tool | Flag | Location |
|---|---|---|
| `agent` | safe | tools/agent.ts:70 |
| `read` | safe | tools/files.ts:34 |
| `web_fetch` | safe | tools/web-fetch.ts:57 |
| `web_search` | safe | tools/web-search.ts:48 |
| `skill` | safe | tools/skill.ts:27 |
| MCP tools | safe | mcp-tools.ts:177 |
| `bash` | exclusive | tools/bash.ts:31 |
| `write` | exclusive | tools/files.ts:132 |
| `edit` | exclusive | tools/files.ts:181 |

## Design

### Semantics: exclusive tools are barriers

Walk the batch in submission order and split it into steps:

- A **maximal run of consecutive safe calls** executes as one step via
  `Promise.all` (concurrent).
- Each **exclusive call** is its own step and runs alone.

Steps run strictly in order: a step starts only after the previous step
finished. So an exclusive call is a barrier in both directions — it waits for
everything before it, and nothing after it starts until it completes.

Example: `[agent, agent, agent, agent, bash]` → the four subagents start
concurrently; bash runs once they all finish. Wall-clock drops from
`a1+a2+a3+a4+b` to `max(a1..a4) + b`.

Example: `[bash, read, read, read]` → bash alone, then the three reads
concurrently.

### Why barriers instead of full two-lane overlap

The alternative — a concurrent "safe lane" and "exclusive lane" with no
cross-class waiting — is faster in a few cases but introduces races that
today's sequential mode is what prevents:

- `[bash "generate out.ts", read out.ts]` — the read could run before the
  file exists. Models do emit such side-effect-dependent batches, and the
  current sequential execution is what makes them safe.
- `[edit foo.ts, read foo.ts]` — the read could observe pre-edit content.
- Main-thread bash overlapping subagent internals — a new race class. (Parallel
  subagents racing *each other's* bash is already accepted today, but there is
  a documented independence contract for same-batch `agent` calls — the tool
  description says "For parallel independent work" — and no such contract for
  `[bash, agent]`.)

Barrier semantics have the key safety property: **no pair of tools ever runs
more concurrently than it already does today in the all-safe batch path.**
Uniform batches are completely unaffected — an all-safe batch is one group
(identical to today's `Promise.all`) and an all-exclusive batch is one call at
a time (identical to today's `for` loop). Only mixed batches change, and they
change strictly in the direction of the all-safe path.

The wall-clock cost of barriers vs. full overlap is small in the common case:
it is `max(0, bash − agents)` when bash trails the agents, i.e. usually just
the bash duration (seconds) after the agents (minutes) finish.

### Implementation

All changes are inside `packages/agent/src/loop.ts`. Replace
`hasExclusiveTool()` and the branch at loop.ts:290–297 with:

```ts
function isConcurrencySafe(block: ToolUseBlock, toolList: ToolDescriptor[]): boolean {
  const tool = toolList.find((candidate) => candidate.name === block.name);
  return tool?.concurrency === "safe";
}

/**
 * Execute a batch of tool calls with exclusive tools as barriers: maximal
 * runs of consecutive safe calls run concurrently, exclusive calls run
 * alone, and every step waits for the previous one. Submission order is
 * preserved; only completion order may vary within a safe run.
 */
async function runToolBatch(
  blocks: ToolUseBlock[],
  toolList: ToolDescriptor[],
  signal: AbortSignal | undefined,
  runOne: (block: ToolUseBlock) => Promise<ExecutedTool>,
): Promise<void> {
  let index = 0;
  while (index < blocks.length) {
    throwIfAborted(signal);
    if (!isConcurrencySafe(blocks[index], toolList)) {
      await runOne(blocks[index]);
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < blocks.length && isConcurrencySafe(blocks[end], toolList)) {
      end += 1;
    }
    const group = blocks.slice(index, end);
    await Promise.all(group.map(runOne));
    index = end;
  }
}
```

In `runAgentLoop`, the try block becomes:

```ts
await runToolBatch(toolUseBlocks, params.tools, params.signal, runOne);
```

`runOne` (loop.ts:276–288), the `completed` map, the abort catch, the ordered
result synthesis (loop.ts:306–318), cost rollup, and both callbacks stay
exactly as they are.

Also update two doc comments to state the contract precisely:

- `ToolConcurrency` in core.ts:55 — `safe`: may run concurrently with
  *adjacent safe calls* in the same batch; must not mutate state that other
  same-batch calls could observe. `exclusive`: runs alone as a barrier; starts
  only after all earlier calls in the batch completed, and later calls wait
  for it.
- The batch comment at loop.ts:270–272.

### Behavior preserved on purpose

- **Abort**: `throwIfAborted` before each step means no new step starts after
  cancellation; in-flight group members receive the shared signal and are
  expected to abort cooperatively (same contract as today's parallel path).
  Unexecuted calls get synthesized "cancelled" results and the run ends with
  `cancelled = true`. One known quirk carries over unchanged: when a group
  member aborts, `Promise.all` rejects while siblings keep running; late
  finishers land in `completed` after the batch result was materialized, so
  they are reported as cancelled. Identical to today's all-safe path.
- **Unknown tools** remain exclusive (barriers), preserving the conservative
  default.
- **Provider behavior**: `parallel_tool_calls: true` is already sent to
  OpenAI-compatible providers (openai.ts:393) and the `agent` tool
  description already encourages multi-call batches. No prompt or provider
  changes needed.

## Tests

Extend `test/loop.test.ts` (the existing "exclusive tools run sequentially,
safe tools run concurrently" test at line 339 only covers a single-tool batch
and keeps passing unchanged):

1. **Mixed batch, safe run then exclusive**: `[safe, safe, exclusive]` using
   the gate-release pattern — assert both safe calls start before either is
   released (concurrent), and the exclusive call starts only after both
   finish.
2. **Exclusive first**: `[exclusive, safe, safe]` — exclusive completes before
   any safe call starts; the two safe calls overlap.
3. **Barrier both sides**: `[safe, exclusive, safe]` — first safe finishes →
   exclusive → last safe.
4. **The reported scenario**: `[agent-like safe ×4, bash-like exclusive]` —
   all four safe calls start before the exclusive call.
5. **Abort inside a group**: `[slow safe, aborting safe, exclusive]` — the
   exclusive call never starts, receives a synthesized cancelled result, and
   the run reports `cancelled: true`.
6. **Result ordering**: mixed batch with staggered completion times —
   `onToolResults` receives results in tool-call order.
7. **Unknown tool as barrier**: `[safe, unknown, safe]` — the unknown call
   runs alone between the two safe calls.

No changes expected in the other suites (`tool-progress`, `headless`,
`compaction`, …) — they don't exercise batch scheduling.

## Out of scope / future refinements

- **Insulated overlap for `agent`**: a per-tool policy letting subagents
  overlap exclusive calls (they already tolerate concurrent exclusive usage
  among themselves). Only worth it if long-bash-plus-agents batches show up
  in practice; would need an explicit independence contract in the tool
  description.
- **Batch-scoped AbortController** to actively cancel in-flight group members
  on abort instead of relying on the shared signal.
- **Concurrency cap** for very large safe groups (currently unbounded
  `Promise.all`, unchanged by this work).
