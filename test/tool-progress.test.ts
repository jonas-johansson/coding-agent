/**
 * Tests for streaming tool-call progress: the live streaming tool title
 * (raw byte counter and on/off behavior).
 *
 * Run with: npm test (build first: npm run build)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { streamingToolTitle } from "../apps/pace/dist/tool-progress.js";

// ── streamingToolTitle ───────────────────────────────────────────────────────

const WRITE_INPUT = JSON.stringify({ path: "src/app.ts", content: "x".repeat(1024) });

test("streamingToolTitle appends the raw byte count", () => {
  const title = streamingToolTitle({
    name: "write",
    inputJson: WRITE_INPUT,
    inputBytes: 12_600,
    showBytes: true,
  });
  assert.equal(title, "write: src/app.ts · 12600 B");
});

test("streamingToolTitle counts in raw bytes, never converted units", () => {
  const title = streamingToolTitle({
    name: "write",
    inputJson: WRITE_INPUT,
    inputBytes: 5 * 1024 * 1024 + 7,
    showBytes: true,
  });
  assert.equal(title, "write: src/app.ts · 5242887 B");
});

test("streamingToolTitle shows the counter from the first byte", () => {
  const title = streamingToolTitle({
    name: "write",
    inputJson: '{"path": "src/app.ts", "content": "x"',
    inputBytes: 1,
    showBytes: true,
  });
  assert.equal(title, "write: src/app.ts · 1 B");
});

test("streamingToolTitle shows the counter on a small input", () => {
  const title = streamingToolTitle({
    name: "write",
    inputJson: JSON.stringify({ path: "src/app.ts", content: "" }),
    inputBytes: 42,
    showBytes: true,
  });
  assert.equal(title, "write: src/app.ts · 42 B");
});

test("streamingToolTitle omits the counter when disabled", () => {
  const title = streamingToolTitle({
    name: "write",
    inputJson: WRITE_INPUT,
    inputBytes: 12_600,
    showBytes: false,
  });
  assert.equal(title, "write: src/app.ts");
});

test("streamingToolTitle falls back to the generic partial title for unknown tools", () => {
  const title = streamingToolTitle({
    name: "nosuchtool",
    inputJson: JSON.stringify({ path: "a/b" }),
    inputBytes: 256,
    showBytes: true,
  });
  assert.equal(title, "nosuchtool: a/b · 256 B");
});

test("streamingToolTitle handles unparsable partial JSON", () => {
  const title = streamingToolTitle({
    name: "write",
    inputJson: '{"path": "src/ap',
    inputBytes: 256,
    showBytes: true,
  });
  assert.ok(title.startsWith("write:"));
  assert.ok(title.endsWith("· 256 B"));
});
