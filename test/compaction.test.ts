/**
 * Tests for context compaction: planning, request assembly, and the
 * summarizer, using a scripted mock provider.
 *
 * Run with: npm test (build first: npm run build)
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type {
  Provider,
  ProviderMessage,
  ProviderResponse,
  ProviderStream,
  StreamEvent,
  ToolDefinition,
} from "@pace/llm";
import {
  createAssistantEntry,
  createCompactionEntry,
  createSession,
  createUserEntry,
  createToolResultEntry,
  appendEntries,
  entriesToProviderMessages,
  estimateEntryTokens,
  extractTouchedFiles,
  getModelVisibleEntries,
  loadSession,
  planCompaction,
  saveSession,
  summarizeForCompaction,
  createProjectKey,
} from "@pace/agent";

// ── Entry helpers ────────────────────────────────────────────────────────────

/** Text of ~chars/4 tokens. */
function textOfTokens(tokens: number): string {
  return "x".repeat(tokens * 4);
}

let entryCounter = 0;

function userEntry(tokens: number, steering = false) {
  entryCounter += 1;
  return createUserEntry({
    content: [{ type: "text", text: textOfTokens(tokens) }],
    ...(steering && { steering: true }),
  });
}

function assistantEntry(tokens: number, toolUse?: { id: string; name: string; input: unknown }) {
  entryCounter += 1;
  return createAssistantEntry({
    content: toolUse
      ? [{ type: "text", text: textOfTokens(tokens) }, { type: "tool_use", ...toolUse }]
      : [{ type: "text", text: textOfTokens(tokens) }],
    provider: "test",
    modelId: "test-model",
    tokensIn: 0,
    tokensOut: 0,
    cost: 0,
  });
}

function toolResultEntry(toolUseId: string, tokens: number) {
  entryCounter += 1;
  return createToolResultEntry({
    toolUseId,
    content: [{ type: "text", text: textOfTokens(tokens) }],
  });
}

function compactionEntry(firstKeptEntryId: string | null, summary = "S") {
  entryCounter += 1;
  return createCompactionEntry({
    summary,
    firstKeptEntryId,
    tokensBefore: 0,
    tokensAfter: 0,
    trigger: "auto",
    provider: "test",
    modelId: "test-model",
    tokensIn: 0,
    tokensOut: 0,
    cost: 0,
  });
}

// ── planCompaction ───────────────────────────────────────────────────────────

test("planCompaction cuts at the latest turn boundary reaching the budget", () => {
  const u1 = userEntry(100);
  const a1 = assistantEntry(100);
  const u2 = userEntry(100);
  const a2 = assistantEntry(100);

  const plan = planCompaction([u1, a1, u2, a2], { keepRecentTokens: 150 });

  assert.ok(plan);
  assert.equal(plan.firstKeptEntryId, u2.id);
  assert.equal(plan.tokensKeptEstimate, 200);
  assert.equal(plan.tokensBeforeEstimate, 400);
  // Summarized range covers everything before the cut.
  assert.equal(plan.messagesToSummarize.length, 2); // u1, a1
});

test("planCompaction never cuts between a tool call and its result", () => {
  const u1 = userEntry(100);
  const a1 = assistantEntry(50, { id: "call_1", name: "read", input: { path: "a" } });
  const tr1 = toolResultEntry("call_1", 1000);
  const u2 = userEntry(100);

  const plan = planCompaction([u1, a1, tr1, u2], { keepRecentTokens: 150 });

  assert.ok(plan);
  // The cut lands on the assistant entry so the tool call stays paired with
  // its result in the kept tail.
  assert.equal(plan.firstKeptEntryId, a1.id);
});

test("planCompaction splits an oversized turn at an assistant entry", () => {
  const u1 = userEntry(100);
  const a1 = assistantEntry(600);
  const steer = userEntry(100, true);
  const a2 = assistantEntry(100);

  const plan = planCompaction([u1, a1, steer, a2], { keepRecentTokens: 150 });

  assert.ok(plan);
  // The turn boundary (u1) is outside 2× the budget, so the turn is split at
  // the assistant entry; the steering message stays with its turn.
  assert.equal(plan.firstKeptEntryId, a1.id);
});

test("planCompaction prefers the turn boundary within 2× the budget", () => {
  const u0 = userEntry(100);
  const a0 = assistantEntry(100);
  const u1 = userEntry(100);
  const a1 = assistantEntry(600);
  const steer = userEntry(100, true);
  const a2 = assistantEntry(100);

  // The budget cut lands on a1 (assistant), but the turn boundary u1 is
  // within 2× the budget (900 ≤ 1000), so the cut moves back to u1.
  const plan = planCompaction([u0, a0, u1, a1, steer, a2], { keepRecentTokens: 500 });

  assert.ok(plan);
  assert.equal(plan.firstKeptEntryId, u1.id);
});

test("planCompaction returns null when everything fits in the keep budget", () => {
  const u1 = userEntry(100);
  const a1 = assistantEntry(100);

  assert.equal(planCompaction([u1, a1], { keepRecentTokens: 20_000 }), null);
  assert.equal(planCompaction([], {}), null);
});

test("planCompaction respects a prior compaction (operates on the visible range)", () => {
  const u1 = userEntry(100);
  const a1 = assistantEntry(100);
  const comp = compactionEntry(a1.id, "earlier summary");
  const u2 = userEntry(100);
  const a2 = assistantEntry(100);

  const plan = planCompaction([u1, a1, comp, u2, a2], { keepRecentTokens: 150 });

  assert.ok(plan);
  // u1 is hidden behind the prior compaction, so the summarized range starts
  // at a1 and the kept tail starts at u2.
  assert.equal(plan.firstKeptEntryId, u2.id);
  assert.equal(plan.messagesToSummarize.length, 1); // a1 only
});

test("planCompaction extracts touched files from the summarized range", () => {
  const u1 = userEntry(100);
  const a1 = assistantEntry(10, { id: "c1", name: "read", input: { path: "src/a.ts" } });
  const tr1 = toolResultEntry("c1", 10);
  const a2 = assistantEntry(10, { id: "c2", name: "write", input: { path: "src/b.ts" } });
  const a3 = assistantEntry(10, { id: "c3", name: "edit", input: { path: "src/a.ts" } });
  const u2 = userEntry(100);

  const plan = planCompaction([u1, a1, tr1, a2, a3, u2], { keepRecentTokens: 50 });

  assert.ok(plan);
  assert.deepEqual(plan.touchedFiles, ["src/a.ts", "src/b.ts"]);
});

// ── getModelVisibleEntries / entriesToProviderMessages ──────────────────────

function textOfMessage(message: ProviderMessage): string {
  if (message.role !== "user") return "";
  return message.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("");
}

test("entriesToProviderMessages emits the summary first, then the kept tail", () => {
  const u1 = userEntry(10);
  const a1 = assistantEntry(10);
  const comp = compactionEntry(u1.id, "the summary");
  const u2 = userEntry(10);

  const messages = entriesToProviderMessages([u1, a1, comp, u2]);

  assert.equal(messages.length, 4);
  assert.equal(messages[0].role, "user");
  const summaryText = textOfMessage(messages[0]);
  assert.match(summaryText, /<conversation_summary>/);
  assert.match(summaryText, /the summary/);
  assert.match(summaryText, /was compacted/);
  // Kept tail: u1 (firstKept) through the compaction, plus later entries.
  assert.equal(messages[1].role, "user");
  assert.equal(messages[2].role, "assistant");
  assert.equal(messages[3].role, "user");
});

test("entriesToProviderMessages keeps entries appended after the compaction", () => {
  const comp = compactionEntry(null, "S");
  const u1 = userEntry(10);
  const a1 = assistantEntry(10);

  const { summary, entries } = getModelVisibleEntries([comp, u1, a1]);

  assert.equal(summary, "S");
  assert.deepEqual(entries, [u1, a1]);
});

test("only the last compaction applies", () => {
  const u1 = userEntry(10);
  const comp1 = compactionEntry(null, "first");
  const u2 = userEntry(10);
  const a2 = assistantEntry(10);
  const comp2 = compactionEntry(u2.id, "second");
  const u3 = userEntry(10);

  const { summary, entries } = getModelVisibleEntries([u1, comp1, u2, a2, comp2, u3]);

  assert.equal(summary, "second");
  // Kept tail of the last compaction (u2, a2) plus entries after it (u3).
  assert.deepEqual(entries, [u2, a2, u3]);
});

test("missing firstKeptEntryId keeps nothing before the compaction", () => {
  const u1 = userEntry(10);
  const a1 = assistantEntry(10);
  const comp = compactionEntry("no-such-id", "S");
  const u2 = userEntry(10);

  const { summary, entries } = getModelVisibleEntries([u1, a1, comp, u2]);

  assert.equal(summary, "S");
  assert.deepEqual(entries, [u2]);

  const messages = entriesToProviderMessages([u1, a1, comp, u2]);
  assert.equal(messages.length, 2); // summary + u2
});

test("entriesToProviderMessages passes plain histories through unchanged", () => {
  const u1 = userEntry(10);
  const a1 = assistantEntry(10);

  const { summary, entries } = getModelVisibleEntries([u1, a1]);
  assert.equal(summary, undefined);
  assert.deepEqual(entries, [u1, a1]);
  assert.deepEqual(entriesToProviderMessages([u1, a1]).length, 2);
});

// ── estimateEntryTokens / extractTouchedFiles ───────────────────────────────

test("estimateEntryTokens uses the char/4 heuristic and counts images", () => {
  const entry = userEntry(10); // 40 chars → 10 tokens
  assert.equal(estimateEntryTokens(entry), 10);

  const withImage = createUserEntry({
    content: [
      { type: "text", text: textOfTokens(10) },
      { type: "image", mediaType: "image/png", data: "AAAA" },
    ],
  });
  assert.equal(estimateEntryTokens(withImage), 10 + 1_600);

  // Thinking blocks are never sent, so they contribute nothing.
  const withThinking = createAssistantEntry({
    content: [
      { type: "thinking", thinking: "long thinking " .repeat(100) },
      { type: "text", text: textOfTokens(10) },
    ],
    provider: "test",
    modelId: "test-model",
    tokensIn: 0,
    tokensOut: 0,
    cost: 0,
  });
  assert.equal(estimateEntryTokens(withThinking), 10);
});

test("extractTouchedFiles picks up read/write/edit paths and de-duplicates", () => {
  const a1 = assistantEntry(0, { id: "c1", name: "read", input: { path: "src/a.ts" } });
  const a2 = assistantEntry(0, { id: "c2", name: "write", input: { path: "src/b.ts" } });
  const a3 = assistantEntry(0, { id: "c3", name: "edit", input: { path: "src/a.ts" } });
  const a4 = assistantEntry(0, { id: "c4", name: "bash", input: { command: "ls" } });

  assert.deepEqual(extractTouchedFiles([a1, a2, a3, a4]), ["src/a.ts", "src/b.ts"]);
  assert.deepEqual(extractTouchedFiles([]), []);
});

// ── summarizeForCompaction ───────────────────────────────────────────────────

type CapturedRequest = {
  system: string;
  messages: ProviderMessage[];
  tools: ToolDefinition[];
};

function scriptedSummarizer(responses: ProviderResponse[]) {
  const requests: CapturedRequest[] = [];
  const provider: Provider = {
    async stream(params) {
      requests.push({ system: params.system, messages: params.messages, tools: params.tools });
      const response = responses[requests.length - 1];
      if (!response) throw new Error(`Unexpected summarizer request #${requests.length}`);
      const stream: ProviderStream = {
        async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
          yield* [];
        },
        finalMessage: async () => response,
      };
      return stream;
    },
  };
  return { provider, requests };
}

const toolDefs: ToolDefinition[] = [
  { name: "read", description: "read", inputSchema: { type: "object" } },
];

function baseSummarizerParams(provider: Provider, messages: ProviderMessage[]) {
  return {
    provider,
    model: "test-model",
    system: "sys",
    toolDefs,
    maxTokens: 1_000,
    messages,
  };
}

test("summarizeForCompaction sends the same system/tools plus the instruction", async () => {
  const { provider, requests } = scriptedSummarizer([
    { content: [{ type: "text", text: "## Goal\nDo it" }], stopReason: "end_turn", usage: {
      inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0,
    } },
  ]);

  const { summary } = await summarizeForCompaction(baseSummarizerParams(provider, [
    { role: "user", content: [{ type: "text", text: "hello" }] },
  ]));

  assert.equal(summary, "## Goal\nDo it");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].system, "sys");
  assert.equal(requests[0].tools, toolDefs);
  assert.equal(requests[0].messages.length, 2);
  assert.equal(requests[0].messages[0].role, "user");
  const instruction = textOfMessage(requests[0].messages[1]);
  assert.match(instruction, /Summarize the conversation above/);
});

test("summarizeForCompaction includes the focus in the instruction", async () => {
  const { provider, requests } = scriptedSummarizer([
    { content: [{ type: "text", text: "ok" }], stopReason: "end_turn", usage: {
      inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0,
    } },
  ]);

  await summarizeForCompaction({
    ...baseSummarizerParams(provider, []),
    focus: "the database migration",
  });

  const instruction = textOfMessage(requests[0].messages.at(-1)!);
  assert.match(instruction, /Pay particular attention to: the database migration/);
});

test("a tool-only response triggers one retry without tools", async () => {
  const { provider, requests } = scriptedSummarizer([
    {
      content: [{ type: "tool_use", id: "c1", name: "read", input: {} }],
      stopReason: "tool_use",
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
    },
    {
      content: [{ type: "text", text: "recovered summary" }],
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
    },
  ]);

  const { summary } = await summarizeForCompaction(baseSummarizerParams(provider, []));

  assert.equal(summary, "recovered summary");
  assert.equal(requests.length, 2);
  assert.equal(requests[0].tools.length, 1);
  assert.equal(requests[1].tools.length, 0);
});

test("an empty retry throws", async () => {
  const toolUseResponse: ProviderResponse = {
    content: [{ type: "tool_use", id: "c1", name: "read", input: {} }],
    stopReason: "tool_use",
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
  };
  const { provider } = scriptedSummarizer([toolUseResponse, toolUseResponse]);

  await assert.rejects(
    summarizeForCompaction(baseSummarizerParams(provider, [])),
    /returned no text/,
  );
});

// ── Session round-trip ───────────────────────────────────────────────────────

let fakeHome: string;
const realHome = process.env.HOME;

beforeEach(async () => {
  fakeHome = await mkdtemp(join(tmpdir(), "pace-compaction-test-"));
  process.env.HOME = fakeHome;
});

afterEach(async () => {
  if (realHome !== undefined) process.env.HOME = realHome;
  await rm(fakeHome, { recursive: true, force: true });
});

test("saveSession/loadSession round-trips a compaction entry", async () => {
  const session = createSession(process.cwd(), "test-model");
  const u1 = userEntry(10);
  const a1 = assistantEntry(10);
  const comp = createCompactionEntry({
    summary: "round-trip summary",
    firstKeptEntryId: u1.id,
    tokensBefore: 123_000,
    tokensAfter: 18_000,
    trigger: "manual",
    focus: "files",
    provider: "test",
    modelId: "test-model",
    tokensIn: 100,
    tokensOut: 50,
    cost: 0.25,
  });
  const withEntries = appendEntries(session, [u1, a1, comp]);

  await saveSession(withEntries);
  const loaded = await loadSession(createProjectKey(process.cwd()), withEntries.id);

  assert.equal(loaded.entries.length, 3);
  const loadedCompaction = loaded.entries[2];
  assert.ok(loadedCompaction.type === "compaction");
  assert.equal(loadedCompaction.summary, "round-trip summary");
  assert.equal(loadedCompaction.firstKeptEntryId, u1.id);
  assert.equal(loadedCompaction.tokensBefore, 123_000);
  assert.equal(loadedCompaction.tokensAfter, 18_000);
  assert.equal(loadedCompaction.trigger, "manual");
  assert.equal(loadedCompaction.focus, "files");
  assert.equal(loadedCompaction.cost, 0.25);

  // Request assembly works on the loaded session path.
  const messages = entriesToProviderMessages([u1, a1, loadedCompaction]);
  assert.match(textOfMessage(messages[0]), /round-trip summary/);
});
