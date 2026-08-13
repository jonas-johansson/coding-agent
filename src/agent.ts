/**
 * Subagent discovery and loading.
 *
 * Subagents are specialized helpers that run in an isolated context window
 * with their own system prompt, tool set, and (optionally) model. The main
 * agent delegates tasks to them via the `agent` tool.
 *
 * Discovery paths (mirrors skills):
 *   Project: .agents/agents/<name>.md
 *   Global:  ~/.agents/agents/<name>.md
 *            ~/.config/agents/agents/<name>.md
 *
 * A built-in `explore` agent is always available. Project and global agents
 * override it by name.
 */

import { readFile, readdir } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { parseFrontmatter, stripFrontmatter } from "./frontmatter";

// ── Types ────────────────────────────────────────────────────────────────────

export type AgentSource = "builtin" | "project" | "global";

export type AgentDefinition = {
  name: string;
  description: string;
  /** Tool allowlist. Empty means all tools except `agent`. */
  tools: string[];
  /** Optional model id override. Empty means inherit the current model. */
  model?: string;
  /** Absolute path to the agent file. Absent for built-in agents. */
  filePath?: string;
  /** System prompt body. Present only for built-in agents. */
  body?: string;
  source: AgentSource;
};

// ── Built-in agents ──────────────────────────────────────────────────────────

const BUILTIN_EXPLORE_AGENT: AgentDefinition = {
  name: "explore",
  description:
    "Fast, read-only codebase exploration. Use for searching code, finding files, " +
    "and answering questions about the project. Delegate research tasks here to " +
    "keep the main conversation clean.",
  tools: ["read", "bash", "web_fetch", "web_search"],
  model: "fireworks/deepseek-v4-flash-0731",
  source: "builtin",
  body: `You are the explore agent. You do fast, read-only codebase exploration.

Your job: find files, search code, and answer questions about the project. You work in an isolated context window and do not see the main conversation.

Rules:
- Never modify, create, or delete files.
- Use bash only for read-only commands such as rg, grep, ls, cat, git status, git diff, and git log.
- Prefer \`rg\` over \`grep -R\` and \`find\`. Respect .gitignore. Do not run unbounded recursive searches.
- When listing files, use \`/bin/ls -1\` to show only file names.

Report:
- A concise structured summary of your findings.
- Key files with paths and line numbers.
- Short explanations. Quote only the important parts, never entire files.`,
};

// ── Name validation ──────────────────────────────────────────────────────────

const AGENT_NAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

function isValidAgentName(name: string): boolean {
  if (name.length < 1 || name.length > 64) return false;
  if (!AGENT_NAME_RE.test(name)) return false;
  if (name.includes("--")) return false;
  return true;
}

// ── Discovery ────────────────────────────────────────────────────────────────

/**
 * Scan a single agents directory for valid agent markdown files.
 * Returns agents found, silently skipping invalid ones.
 */
async function scanAgentsDir(
  agentsDir: string,
  source: AgentSource,
): Promise<AgentDefinition[]> {
  let entries: string[];
  try {
    entries = await readdir(agentsDir);
  } catch {
    return [];
  }

  const agents: AgentDefinition[] = [];

  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;

    const filePath = join(agentsDir, entry);
    let content: string;
    try {
      content = await readFile(filePath, "utf-8");
    } catch {
      continue;
    }

    const fm = parseFrontmatter(content);
    if (!fm) continue;

    const name = typeof fm.name === "string" ? fm.name : "";
    const description = typeof fm.description === "string" ? fm.description : "";

    // Name must match the file name and be valid
    if (!isValidAgentName(name)) continue;
    if (name !== entry.slice(0, -".md".length)) continue;

    // Description is required and must be 1-1024 chars
    if (description.length < 1 || description.length > 1024) continue;

    const tools = typeof fm.tools === "string"
      ? fm.tools.split(",").map((t) => t.trim()).filter(Boolean)
      : [];

    agents.push({
      name,
      description,
      tools,
      ...(typeof fm.model === "string" && fm.model.length > 0 ? { model: fm.model } : {}),
      filePath,
      source,
    });
  }

  return agents;
}

/**
 * Discover all agents from project, global, and built-in sources.
 *
 * Scanned in order (first match for a given name wins):
 *   1. <cwd>/.agents/agents/    (project)
 *   2. ~/.agents/agents/         (global)
 *   3. ~/.config/agents/agents/  (global)
 *   4. Built-in (fallback)
 */
export async function discoverAgents(): Promise<AgentDefinition[]> {
  const projectDir = join(process.cwd(), ".agents", "agents");
  const globalDir1 = join(homedir(), ".agents", "agents");
  const globalDir2 = join(homedir(), ".config", "agents", "agents");

  const [projectAgents, globalAgents1, globalAgents2] = await Promise.all([
    scanAgentsDir(projectDir, "project"),
    scanAgentsDir(globalDir1, "global"),
    scanAgentsDir(globalDir2, "global"),
  ]);

  // Deduplicate: project → ~/.agents/ → ~/.config/agents/ → builtin (fallback)
  const seen = new Set<string>();
  const result: AgentDefinition[] = [];

  for (const list of [projectAgents, globalAgents1, globalAgents2, [BUILTIN_EXPLORE_AGENT]]) {
    for (const agent of list) {
      if (!seen.has(agent.name)) {
        seen.add(agent.name);
        result.push(agent);
      }
    }
  }

  return result;
}

// ── Querying ─────────────────────────────────────────────────────────────────

/** Find an agent by name. */
export function findAgent(agents: AgentDefinition[], name: string): AgentDefinition | undefined {
  return agents.find((a) => a.name === name);
}

/** Read the system prompt body of an agent (frontmatter stripped). */
export async function loadAgentBody(agent: AgentDefinition): Promise<string> {
  if (agent.body !== undefined) return agent.body;
  const content = await readFile(agent.filePath!, "utf-8");
  return stripFrontmatter(content);
}

// ── Formatting ───────────────────────────────────────────────────────────────

/**
 * Build a compact agent listing for tool descriptions.
 * Format: "- name: description" per line.
 */
export function formatAgentsForToolDescription(agents: AgentDefinition[]): string {
  if (agents.length === 0) return "";
  return agents.map((a) => `- ${a.name}: ${a.description}`).join("\n");
}

/**
 * Build a human-readable listing of all agents for the /agents command.
 */
export function formatAgentsListing(agents: AgentDefinition[]): string {
  const builtinAgents = agents.filter((a) => a.source === "builtin");
  const projectAgents = agents.filter((a) => a.source === "project");
  const globalAgents = agents.filter((a) => a.source === "global");

  const formatAgent = (a: AgentDefinition) =>
    `**${a.name}**\n${a.description}${a.model ? `\nModel: ${a.model}` : ""}`;

  const sections: string[] = [];

  if (projectAgents.length > 0) {
    const lines = projectAgents.map(formatAgent);
    sections.push(`### Project (.agents/agents/)\n\n${lines.join("\n\n")}`);
  }

  if (globalAgents.length > 0) {
    const lines = globalAgents.map(formatAgent);
    sections.push(`### Global (~/.agents/agents/)\n\n${lines.join("\n\n")}`);
  }

  if (builtinAgents.length > 0) {
    const lines = builtinAgents.map(formatAgent);
    sections.push(`### Built-in\n\n${lines.join("\n\n")}`);
  }

  if (sections.length === 0) {
    return "No agents found.\n\nPlace agents in `.agents/agents/<name>.md` (project) or `~/.agents/agents/<name>.md` (global).";
  }

  return `## Available Agents\n\n${sections.join("\n\n")}`;
}
