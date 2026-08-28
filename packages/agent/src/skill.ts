/**
 * Skill discovery and loading.
 *
 * Implements the Agent Skills specification (https://github.com/agentskills/agentskills).
 * Skills are directories containing a SKILL.md file with YAML frontmatter
 * (name + description) followed by markdown instructions.
 *
 * Discovery paths:
 *   Project: .agents/skills/<name>/SKILL.md
 *   Global:  ~/.config/agents/skills/<name>/SKILL.md
 */

import { readFile, readdir, stat } from "fs/promises";
import { homedir } from "os";
import { join, basename } from "path";
import { parseFrontmatter } from "./frontmatter";

// ── Types ────────────────────────────────────────────────────────────────────

export type SkillSource = "project" | "global";

export type Skill = {
  name: string;
  description: string;
  /** Absolute path to the SKILL.md file. */
  filePath: string;
  /** Absolute path to the skill directory (parent of SKILL.md). */
  baseDir: string;
  source: SkillSource;
  disableModelInvocation: boolean;
};

// ── Name validation ──────────────────────────────────────────────────────────

const SKILL_NAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

function isValidSkillName(name: string): boolean {
  if (name.length < 1 || name.length > 64) return false;
  if (!SKILL_NAME_RE.test(name)) return false;
  if (name.includes("--")) return false;
  return true;
}

// ── Discovery ────────────────────────────────────────────────────────────────

/**
 * Scan a single skills directory for valid skill subdirectories.
 * Returns skills found, silently skipping invalid ones.
 */
async function scanSkillsDir(
  skillsDir: string,
  source: SkillSource,
): Promise<Skill[]> {
  let entries: string[];
  try {
    entries = await readdir(skillsDir);
  } catch {
    return [];
  }

  const skills: Skill[] = [];

  for (const entry of entries) {
    const skillDir = join(skillsDir, entry);

    // Must be a directory
    try {
      const s = await stat(skillDir);
      if (!s.isDirectory()) continue;
    } catch {
      continue;
    }

    const skillFile = join(skillDir, "SKILL.md");
    let content: string;
    try {
      content = await readFile(skillFile, "utf-8");
    } catch {
      continue;
    }

    const fm = parseFrontmatter(content);
    if (!fm) continue;

    const name = typeof fm.name === "string" ? fm.name : "";
    const description = typeof fm.description === "string" ? fm.description : "";

    // Validate name
    if (!isValidSkillName(name)) continue;

    // Name must match directory name
    if (name !== basename(skillDir)) continue;

    // Description is required and must be 1-1024 chars
    if (description.length < 1 || description.length > 1024) continue;

    skills.push({
      name,
      description,
      filePath: skillFile,
      baseDir: skillDir,
      source,
      disableModelInvocation: fm["disable-model-invocation"] === true,
    });
  }

  return skills;
}

/**
 * Discover all skills from project and global directories.
 *
 * Scanned in order (first match for a given name wins):
 *   1. <cwd>/.agents/skills/    (project)
 *   2. ~/.agents/skills/         (global — used by Cline, Warp, and others)
 *   3. ~/.config/agents/skills/  (global — universal convention)
 */
export async function discoverSkills(): Promise<Skill[]> {
  const projectDir = join(process.cwd(), ".agents", "skills");
  const globalDir1 = join(homedir(), ".agents", "skills");
  const globalDir2 = join(homedir(), ".config", "agents", "skills");

  const [projectSkills, globalSkills1, globalSkills2] = await Promise.all([
    scanSkillsDir(projectDir, "project"),
    scanSkillsDir(globalDir1, "global"),
    scanSkillsDir(globalDir2, "global"),
  ]);

  // Deduplicate: project → ~/.agents/ → ~/.config/agents/
  const seen = new Set<string>();
  const result: Skill[] = [];

  for (const list of [projectSkills, globalSkills1, globalSkills2]) {
    for (const skill of list) {
      if (!seen.has(skill.name)) {
        seen.add(skill.name);
        result.push(skill);
      }
    }
  }

  return result;
}

// ── Querying ─────────────────────────────────────────────────────────────────

/** Return skills the model can see (excludes disable-model-invocation). */
export function getModelVisibleSkills(skills: Skill[]): Skill[] {
  return skills.filter((s) => !s.disableModelInvocation);
}

/** Find a skill by name. */
export function findSkill(skills: Skill[], name: string): Skill | undefined {
  return skills.find((s) => s.name === name);
}

/** Read the full content of a skill's SKILL.md. */
export async function loadSkillContent(skill: Skill): Promise<string> {
  return readFile(skill.filePath, "utf-8");
}

// ── Formatting ───────────────────────────────────────────────────────────────

/**
 * Collapse whitespace runs (including newlines from multi-line descriptions)
 * into single spaces so each description stays on one line.
 */
function toSingleLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Build the skills section for the system prompt: the <available_skills> XML
 * block (model-visible skills only) followed by the invocation directive that
 * tells the model to check for a matching skill before starting work.
 */
export function formatSkillsSystemPromptBlock(skills: Skill[]): string {
  const visible = getModelVisibleSkills(skills);
  if (visible.length === 0) return "";

  const lines = visible.map(
    (s) => `<skill name="${s.name}">${toSingleLine(s.description)}</skill>`,
  );
  return (
    `<available_skills>\n${lines.join("\n")}\n</available_skills>\n\n` +
    "Skills are established workflows. Before starting a task, check whether " +
    "it matches a skill above — each description lists its trigger phrases. " +
    "If one matches, load it with the skill tool before doing anything else " +
    "and follow it instead of improvising an equivalent."
  );
}

/**
 * Build a human-readable listing of all skills for the /skills command.
 */
export function formatSkillsListing(skills: Skill[]): string {
  const projectSkills = skills.filter((s) => s.source === "project");
  const globalSkills = skills.filter((s) => s.source === "global");
  const sections: string[] = [];

  if (projectSkills.length > 0) {
    const lines = projectSkills.map(
      (s) => `**${s.name}**\n${s.description}`,
    );
    sections.push(`### Project (.agents/skills/)\n\n${lines.join("\n\n")}`);
  }

  if (globalSkills.length > 0) {
    const lines = globalSkills.map(
      (s) => `**${s.name}**\n${s.description}`,
    );
    sections.push(`### Global (~/.agents/skills/)\n\n${lines.join("\n\n")}`);
  }

  if (sections.length === 0) {
    return "No skills found.\n\nPlace skills in `.agents/skills/<name>/SKILL.md` (project) or `~/.agents/skills/<name>/SKILL.md` (global).\n\nOr install from the skills.sh ecosystem: `npx skills add <owner/repo>`";
  }

  return `## Available Skills\n\n${sections.join("\n\n")}`;
}

/**
 * Build a compact skill listing for tool descriptions.
 * Format: "- name: description" per line.
 */
export function formatSkillsForToolDescription(skills: Skill[]): string {
  const visible = getModelVisibleSkills(skills);
  if (visible.length === 0) return "";
  return visible.map((s) => `- ${s.name}: ${toSingleLine(s.description)}`).join("\n");
}
