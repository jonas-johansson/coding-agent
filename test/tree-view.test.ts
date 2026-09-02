/**
 * Tests for the conversation tree overlay view model: flattening of linear
 * chains, fork nesting, and compaction section rows.
 *
 * Run with: npm test (build first: npm run build)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appendEntries,
  createAssistantEntry,
  createCompactionEntry,
  createSession,
  createUserEntry,
  setActiveEntryId,
} from "@pace/agent";
import { sessionToTreeOverlayEntries } from "../apps/pace/dist/session-view.js";

// ── Entry helpers ────────────────────────────────────────────────────────────

let entryCounter = 0;

function userEntry() {
  entryCounter += 1;
  return createUserEntry({
    content: [{ type: "text", text: `user message ${entryCounter}` }],
  });
}

function assistantEntry() {
  entryCounter += 1;
  return createAssistantEntry({
    content: [{ type: "text", text: `assistant message ${entryCounter}` }],
    provider: "test",
    modelId: "test-model",
    tokensIn: 0,
    tokensOut: 0,
    cost: 0,
  });
}

function compactionEntry(firstKeptEntryId: string | null) {
  entryCounter += 1;
  return createCompactionEntry({
    summary: "summary",
    firstKeptEntryId,
    tokensBefore: 100_000,
    tokensAfter: 18_000,
    trigger: "auto",
    provider: "test",
    modelId: "test-model",
    tokensIn: 0,
    tokensOut: 0,
    cost: 0,
  });
}

// ── Flattening ───────────────────────────────────────────────────────────────

test("tree renders a linear conversation flat (no pyramid)", () => {
  let session = createSession("/tmp", "test-model");
  session = appendEntries(session, [userEntry(), assistantEntry(), userEntry(), assistantEntry()]);

  const rows = sessionToTreeOverlayEntries(session);

  assert.equal(rows.length, 4);
  for (const row of rows) {
    assert.equal(row.depth, 0, `row ${row.id} should be at depth 0`);
    assert.equal(row.isForkChild, undefined);
  }
});

test("tree nests only branch alternatives under a fork", () => {
  let session = createSession("/tmp", "test-model");
  const u1 = userEntry();
  const a1 = assistantEntry();
  session = appendEntries(session, [u1, a1]);
  // Branch from u1: a1 becomes an inactive alternative.
  session = setActiveEntryId(session, u1.id);
  const a1b = assistantEntry();
  session = appendEntries(session, [a1b]);

  const rows = sessionToTreeOverlayEntries(session);

  assert.equal(rows.length, 3);
  const u1Row = rows.find((row) => row.id === u1.id);
  const a1Row = rows.find((row) => row.id === a1.id);
  const a1bRow = rows.find((row) => row.id === a1b.id);
  assert.equal(u1Row?.depth, 0);
  assert.equal(u1Row?.hasChildren, true);
  assert.equal(a1Row?.depth, 1);
  assert.equal(a1Row?.isForkChild, true);
  assert.equal(a1Row?.isLastForkChild, true);
  assert.equal(a1Row?.isActive, false);
  assert.equal(a1bRow?.depth, 1);
  assert.equal(a1bRow?.isForkChild, true);
  assert.equal(a1bRow?.isLastForkChild, undefined);
  assert.equal(a1bRow?.isLeaf, true);
});

// ── Compaction sections ──────────────────────────────────────────────────────

test("tree renders a compaction as a section with folded summarized entries", () => {
  let session = createSession("/tmp", "test-model");
  const u1 = userEntry();
  const a1 = assistantEntry();
  const u2 = userEntry();
  const a2 = assistantEntry();
  session = appendEntries(session, [u1, a1, u2, a2]);
  const comp = compactionEntry(u2.id);
  session = appendEntries(session, [comp]);

  const rows = sessionToTreeOverlayEntries(session);

  const compRow = rows.find((row) => row.id === comp.id);
  const u1Row = rows.find((row) => row.id === u1.id);
  const a1Row = rows.find((row) => row.id === a1.id);
  const u2Row = rows.find((row) => row.id === u2.id);
  const a2Row = rows.find((row) => row.id === a2.id);

  // The compaction is a root-level section header before its summarized range.
  assert.equal(compRow?.depth, 0);
  assert.equal(compRow?.role, "compaction");
  assert.equal(compRow?.hasChildren, true);
  assert.equal(compRow?.startFolded, true);
  assert.match(compRow?.preview ?? "", /Context compacted · .* tokens · auto/);

  // Summarized entries nest under it, dimmed, with connectors.
  assert.equal(u1Row?.depth, 1);
  assert.equal(u1Row?.summarized, true);
  assert.equal(u1Row?.isForkChild, true);
  assert.equal(a1Row?.depth, 1);
  assert.equal(a1Row?.summarized, true);
  assert.equal(a1Row?.isLastForkChild, true);

  // The kept tail anchors at the compaction's own depth: folding the
  // summary never hides the live context.
  assert.equal(u2Row?.depth, 0);
  assert.equal(u2Row?.summarized, undefined);
  assert.equal(a2Row?.depth, 0);
});

test("tree renders chained compactions as nested sections", () => {
  let session = createSession("/tmp", "test-model");
  const u1 = userEntry();
  const a1 = assistantEntry();
  const u2 = userEntry();
  const a2 = assistantEntry();
  session = appendEntries(session, [u1, a1, u2, a2]);
  const comp1 = compactionEntry(u2.id);
  session = appendEntries(session, [comp1]);
  const u3 = userEntry();
  const a3 = assistantEntry();
  session = appendEntries(session, [u3, a3]);
  const comp2 = compactionEntry(u3.id);
  session = appendEntries(session, [comp2]);

  const rows = sessionToTreeOverlayEntries(session);

  const comp1Row = rows.find((row) => row.id === comp1.id);
  const comp2Row = rows.find((row) => row.id === comp2.id);
  const u1Row = rows.find((row) => row.id === u1.id);
  const u2Row = rows.find((row) => row.id === u2.id);
  const u3Row = rows.find((row) => row.id === u3.id);

  // comp1's section keeps its own summarized range…
  assert.equal(comp1Row?.depth, 1);
  assert.equal(u1Row?.depth, 2);
  assert.equal(u1Row?.summarized, true);
  // …and is itself swallowed by comp2's section.
  assert.equal(comp2Row?.depth, 0);
  // comp1's former kept tail (u2) is now summarized by comp2.
  assert.equal(u2Row?.depth, 1);
  assert.equal(u2Row?.summarized, true);
  // comp2's kept tail anchors at root depth.
  assert.equal(u3Row?.depth, 0);
  assert.equal(u3Row?.summarized, undefined);
});
