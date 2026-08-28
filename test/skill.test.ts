/**
 * Tests for skill system-prompt formatting, focused on the invocation
 * directive that makes the <available_skills> block actionable.
 *
 * Run with: npm test
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { formatSkillsSystemPromptBlock } from "@pace/agent";
import type { Skill } from "@pace/agent";

function makeSkill(overrides: Partial<Skill> = {}): Skill {
  return {
    name: "implement-plan-task",
    description:
      "Implement the next uncompleted task from a plan. Triggers: implement one task, next task, continue the plan.",
    filePath: "/project/.agents/skills/implement-plan-task/SKILL.md",
    baseDir: "/project/.agents/skills/implement-plan-task",
    source: "project",
    disableModelInvocation: false,
    ...overrides,
  };
}

// ── Listing ──────────────────────────────────────────────────────────────────

test("renders one <skill> line per visible skill", () => {
  const block = formatSkillsSystemPromptBlock([
    makeSkill(),
    makeSkill({ name: "jolt-physics", description: "Runtime rules for Jolt." }),
  ]);

  assert.ok(block.startsWith("<available_skills>\n"));
  assert.ok(block.includes('<skill name="implement-plan-task">'));
  assert.ok(block.includes('<skill name="jolt-physics">Runtime rules for Jolt.</skill>'));
});

test("collapses multi-line descriptions onto one line", () => {
  const block = formatSkillsSystemPromptBlock([
    makeSkill({ description: "Line one\nline two\nline three." }),
  ]);
  assert.ok(block.includes('<skill name="implement-plan-task">Line one line two line three.</skill>'));
});

test("returns empty string when there are no skills", () => {
  assert.equal(formatSkillsSystemPromptBlock([]), "");
});

test("excludes skills with disable-model-invocation", () => {
  const block = formatSkillsSystemPromptBlock([
    makeSkill({ disableModelInvocation: true }),
    makeSkill({ name: "jolt-physics", description: "Runtime rules." }),
  ]);
  assert.ok(!block.includes('name="implement-plan-task"'));
  assert.ok(block.includes('name="jolt-physics"'));
});

// ── Invocation directive ─────────────────────────────────────────────────────

test("appends an invocation directive after the block", () => {
  const block = formatSkillsSystemPromptBlock([makeSkill()]);

  assert.ok(block.includes("</available_skills>\n\n"));
  const directive = block.split("</available_skills>\n\n")[1];
  assert.match(directive, /skill tool/);
  assert.match(directive, /before/i);
  assert.ok(!directive.includes("<skill"), "directive must not be XML");
});

test("no directive without skills", () => {
  assert.equal(formatSkillsSystemPromptBlock([]), "");
});
