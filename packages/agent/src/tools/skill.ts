import { z } from "zod";
import { defineTool, throwIfAborted, type ToolOutput } from "./core";
import type { Skill } from "../skill";
import { findSkill, loadSkillContent } from "../skill";

// ─── Skill Tool ─────────────────────────────────────────────────────────────

let currentSkills: Skill[] = [];

/**
 * Update the set of skills available to the skill tool.
 * Called from app.ts at the start of each prompt cycle.
 */
export function setCurrentSkills(skills: Skill[]) {
  currentSkills = skills;
}

export function getCurrentSkills() {
  return currentSkills;
}

export const skillTool = defineTool({
  name: "skill",
  description:
    "Load a skill's full instructions by name. " +
    "Use this to read the complete SKILL.md content for an available skill when you determine it is relevant to the current task.",
  concurrency: "safe",
  inputSchema: z.object({
    name: z.string().describe("The skill name to load"),
  }),
  titleFormatter: (input) => `skill: ${input.name ?? ""}`,
  showContent: false,
  truncateOutput: false,
  execute: async (input, signal): Promise<ToolOutput> => {
    throwIfAborted(signal);
    const skill = findSkill(currentSkills, input.name);
    if (!skill) {
      return {
        content: [{ type: "text", text: `Unknown skill: ${input.name}` }],
        is_error: true,
      };
    }
    const content = await loadSkillContent(skill);
    return {
      content: [{ type: "text", text: content }],
    };
  },
});
