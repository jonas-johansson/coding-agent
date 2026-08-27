/**
 * Tests for frontmatter parsing, focused on the YAML shapes that appear in
 * real-world SKILL.md and agent definition files.
 *
 * Run with: npm test
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFrontmatter, stripFrontmatter } from "@pace/agent";

// ── Block scalars ────────────────────────────────────────────────────────────

test("folded block scalar (>) folds continuation lines into one line", () => {
  const text = [
    "---",
    "name: alignment-to-plan",
    "description: >",
    "  Turn an alignment output (Briefs/<name>-alignment-output.md) plus its brief",
    "  into an executable task breakdown at Plans/<name>-plan.md. Use when the user",
    "  has a completed alignment doc and asks for a plan. Triggers: alignment, plan.",
    "---",
    "",
    "# Body",
  ].join("\n");

  const fm = parseFrontmatter(text);
  assert.ok(fm);
  assert.equal(fm.name, "alignment-to-plan");
  assert.equal(
    fm.description,
    "Turn an alignment output (Briefs/<name>-alignment-output.md) plus its brief " +
      "into an executable task breakdown at Plans/<name>-plan.md. Use when the user " +
      "has a completed alignment doc and asks for a plan. Triggers: alignment, plan.",
  );
  // Continuation lines must not leak in as keys.
  assert.deepEqual(Object.keys(fm).sort(), ["description", "name"]);
});

test("literal block scalar (|) preserves line breaks and relative indentation", () => {
  const text = [
    "---",
    "name: demo",
    "description: |",
    "  First line",
    "    indented line",
    "  Last line",
    "---",
  ].join("\n");

  const fm = parseFrontmatter(text);
  assert.ok(fm);
  assert.equal(fm.description, "First line\n  indented line\nLast line");
});

test("block scalars support chomping and indentation indicators", () => {
  const strip = parseFrontmatter("---\ndescription: >-\n  one\n  two\n---\n");
  assert.ok(strip);
  assert.equal(strip.description, "one two");

  const keep = parseFrontmatter("---\ndescription: |+\n  one\n  two\n---\n");
  assert.ok(keep);
  assert.equal(keep.description, "one\ntwo");

  const explicit = parseFrontmatter("---\ndescription: >2\n    deep\n---\n");
  assert.ok(explicit);
  assert.equal(explicit.description, "  deep");
});

test("block scalar ends at a column-0 key and blank lines separate paragraphs", () => {
  const text = [
    "---",
    "description: >",
    "  first paragraph",
    "",
    "  second paragraph",
    "name: after",
    "---",
  ].join("\n");

  const fm = parseFrontmatter(text);
  assert.ok(fm);
  assert.equal(fm.description, "first paragraph\nsecond paragraph");
  assert.equal(fm.name, "after");
});

test("empty block scalar yields an empty string", () => {
  const fm = parseFrontmatter("---\ndescription: >\nname: demo\n---\n");
  assert.ok(fm);
  assert.equal(fm.description, "");
  assert.equal(fm.name, "demo");
});

// ── Plain and quoted scalars ─────────────────────────────────────────────────

test("flat key/value pairs, booleans, and comments", () => {
  const text = [
    "---",
    "# a comment",
    "name: demo",
    "disable-model-invocation: true",
    "hidden: false",
    "empty:",
    "---",
  ].join("\n");

  const fm = parseFrontmatter(text);
  assert.ok(fm);
  assert.equal(fm.name, "demo");
  assert.equal(fm["disable-model-invocation"], true);
  assert.equal(fm.hidden, false);
  assert.equal(fm.empty, "");
});

test("trailing comments are stripped from plain values", () => {
  const fm = parseFrontmatter(
    "---\nname: demo # trailing comment\nurl: http://example.com/#anchor\nhash: # start of value\n---\n",
  );
  assert.ok(fm);
  assert.equal(fm.name, "demo");
  // A `#` not preceded by whitespace is part of the value.
  assert.equal(fm.url, "http://example.com/#anchor");
  assert.equal(fm.hash, "");
});

test("keys may contain colons; values may contain colon-space pairs", () => {
  const fm = parseFrontmatter("---\na:b: c\nname: demo: with colons\n---\n");
  assert.ok(fm);
  assert.equal(fm["a:b"], "c");
  assert.equal(fm.name, "demo: with colons");
});

test("key without a space after the colon still parses", () => {
  const fm = parseFrontmatter("---\nname:demo\nflag:true\n---\n");
  assert.ok(fm);
  assert.equal(fm.name, "demo");
  assert.equal(fm.flag, true);
});

test("quoted values are unquoted and unescaped", () => {
  const fm = parseFrontmatter(
    '---\nname: "demo"\nquote: "He said \\"hi\\""\napostrophe: \'Don\'t\'\n---\n',
  );
  assert.ok(fm);
  assert.equal(fm.name, "demo");
  assert.equal(fm.quote, 'He said "hi"');
  assert.equal(fm.apostrophe, "Don't");
});

test("multi-line quoted scalars are folded", () => {
  const fm = parseFrontmatter(
    '---\ndescription: "first part\n  second part"\nname: demo\n---\n',
  );
  assert.ok(fm);
  assert.equal(fm.description, "first part second part");
  assert.equal(fm.name, "demo");
});

test("multi-line plain scalars are folded, including colon-bearing lines", () => {
  const text = [
    "---",
    "description: Does stuff",
    "  Triggers: things, stuff",
    "name: demo",
    "---",
  ].join("\n");

  const fm = parseFrontmatter(text);
  assert.ok(fm);
  assert.equal(fm.description, "Does stuff Triggers: things, stuff");
  assert.equal(fm.name, "demo");
});

test("key with empty value and indented text folds into the value", () => {
  const fm = parseFrontmatter("---\ndescription:\n  Some text\n  more text\n---\n");
  assert.ok(fm);
  assert.equal(fm.description, "Some text more text");
});

test("list items after an empty value are skipped, not folded in", () => {
  const text = [
    "---",
    "name: demo",
    "tools:",
    "  - Read",
    "  - Write",
    "description: does things",
    "---",
  ].join("\n");

  const fm = parseFrontmatter(text);
  assert.ok(fm);
  assert.equal(fm.tools, "");
  assert.equal(fm.description, "does things");
});

test("indented nested mapping does not clobber top-level keys", () => {
  const text = [
    "---",
    "name: outer",
    "metadata:",
    "  name: inner",
    "---",
  ].join("\n");

  const fm = parseFrontmatter(text);
  assert.ok(fm);
  assert.equal(fm.name, "outer");
});

// ── Delimiters and edge cases ────────────────────────────────────────────────

test("CRLF line endings and a BOM are tolerated", () => {
  const text = "\uFEFF---\r\nname: demo\r\ndescription: >\r\n  folded text\r\n---\r\n";
  const fm = parseFrontmatter(text);
  assert.ok(fm);
  assert.equal(fm.name, "demo");
  assert.equal(fm.description, "folded text");
});

test("missing closing delimiter returns null", () => {
  assert.equal(parseFrontmatter("---\nname: demo\n"), null);
  assert.equal(parseFrontmatter("---\nname: demo\n----\n"), null);
});

test("text without frontmatter returns null", () => {
  assert.equal(parseFrontmatter("# Just a title\n\nBody\n"), null);
  assert.equal(parseFrontmatter("----\nname: demo\n---\n"), null);
});

test("empty frontmatter returns an empty record", () => {
  assert.deepEqual(parseFrontmatter("---\n---\n"), {});
  assert.deepEqual(parseFrontmatter("---\n# only a comment\n---\n"), {});
});

// ── stripFrontmatter ─────────────────────────────────────────────────────────

test("stripFrontmatter returns the body after the frontmatter", () => {
  const text = "---\nname: demo\ndescription: >\n  folded\n---\n\n# Title\n\nBody.";
  assert.equal(stripFrontmatter(text), "# Title\n\nBody.");
});

test("stripFrontmatter keeps the first body line's indentation", () => {
  assert.equal(stripFrontmatter("---\nname: demo\n---\n  indented body"), "  indented body");
});

test("stripFrontmatter returns the full text when there is no frontmatter", () => {
  assert.equal(stripFrontmatter("# Title\n\nBody\n"), "# Title\n\nBody\n");
  assert.equal(stripFrontmatter("---\nname: demo\n"), "---\nname: demo\n");
});

test("stripFrontmatter handles CRLF line endings", () => {
  assert.equal(stripFrontmatter("---\r\nname: demo\r\n---\r\n# Body\r\n"), "# Body\n");
});
