/**
 * Shared agent context wiring used by both the TUI and the headless runner.
 *
 * This module owns the pieces of the "agent setup" that must stay identical
 * between interactive and non-interactive runs: AGENTS.md discovery, system
 * prompt assembly, and the subagent runtime injected into the agent tool.
 * It has no UI dependencies.
 */

import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { ModelConfig } from "@pace/llm";
import {
  loadAgentBody,
  runSubagent,
  filterToolsForAgent,
  toProviderToolDefinitions,
  type ConnectedMcpServer,
  type AgentRuntime,
} from "@pace/agent";
import { resolveProvider } from "@pace/llm";

// ── AGENTS.md discovery ──────────────────────────────────────────────────────

/** Attempts to read AGENTS.md from the current working directory. */
export async function loadAgentsFile(): Promise<string | null> {
  const filePath = join(process.cwd(), "AGENTS.md");
  if (!existsSync(filePath)) return null;
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

/** Attempts to read the global AGENTS.md from ~/.config/pace/AGENTS.md. */
export async function loadGlobalAgentsFile(): Promise<string | null> {
  const filePath = join(homedir(), ".config", "pace", "AGENTS.md");
  if (!existsSync(filePath)) return null;
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

// ── System prompt assembly ───────────────────────────────────────────────────

export function formatCwd(cwd: string): string {
  return cwd.startsWith(homedir()) ? `~${cwd.slice(homedir().length)}` : cwd;
}

/** Base system prompt shared by the TUI and headless runners. */
export function buildBaseSystemPrompt(cwd: string): string {
  const date = new Date().toISOString().split("T")[0];
  return `You are Pace, a highly capable coding agent designed to assist with software development tasks.\n\nCurrent working directory: ${formatCwd(cwd)}\n\nCurrent date (YYYY-MM-DD): ${date}\n\nWhen operating on files or directories in the current working directory, use relative paths rather than absolute paths.\n\nWhen listing files, use \`/bin/ls -1\` to show only filenames (one per line, no icons or extra info). Only add flags like \`-la\` if the user explicitly asks for more details.\n\nWhen searching files with Bash, prefer \`rg\`/\`rg --files\` over \`grep -R\`, \`find .\`, or \`ls -R\` because ripgrep respects \`.gitignore\`; do not run unbounded recursive searches, and if \`rg\` is unavailable explicitly exclude \`node_modules\`, \`.git\`, \`dist\`, \`build\`, \`coverage\`, \`.next\`, and \`vendor\`.`;
}

export type SystemPromptParts = {
  cwd: string;
  skillsSection?: string;
  /** Connected MCP servers, as returned by getConnectedMcpServers(). */
  mcpServers: ConnectedMcpServer[];
  globalAgentsFileContents: string | null;
  agentsFileContents: string | null;
  /** Extra system text appended last (used by `pace run --append-system`). */
  appendSystem?: string;
};

/**
 * Build the main-agent system text: base → skills → MCP → AGENTS.md → append.
 * The order and separators match the TUI prompt path exactly.
 */
export function assembleSystemText(parts: SystemPromptParts): string {
  let systemText = buildBaseSystemPrompt(parts.cwd);

  if (parts.skillsSection) {
    systemText += `\n\n---\n\n${parts.skillsSection}`;
  }

  if (parts.mcpServers.length > 0) {
    const mcpLines = parts.mcpServers.map(
      (s) => `  - ${s.name} (${s.tools.length} tool${s.tools.length === 1 ? "" : "s"})`,
    );
    systemText +=
      `\n\n---\n\nAvailable MCP servers:\n${mcpLines.join("\n")}\n\n` +
      `MCP tools are named mcp__<server>__<tool>. Use them when they are relevant to the task.`;
  }

  if (parts.globalAgentsFileContents) {
    systemText += `\n\n---\n\n# Global instructions (from ~/.config/pace/AGENTS.md)\n\n${parts.globalAgentsFileContents}`;
  }

  if (parts.agentsFileContents) {
    systemText += `\n\n---\n\n# Project-specific instructions (from AGENTS.md)\n\n${parts.agentsFileContents}`;
  }

  if (parts.appendSystem) {
    systemText += `\n\n---\n\n${parts.appendSystem}`;
  }

  return systemText;
}

// ── Cost wiring ──────────────────────────────────────────────────────────────

export function computeCallCost(
  config: ModelConfig,
  totalInputTokens: number,
  inputTokens: number,
  cacheCreationTokens: number,
  cacheReadTokens: number,
  outputTokens: number,
): number {
  const pricing = config.longContextPricing && totalInputTokens > config.longContextPricing.inputTokenThreshold
    ? config.longContextPricing.pricing
    : config.pricing;

  return (
    (inputTokens / 1_000_000) * pricing.inputPerMTok +
    (cacheCreationTokens / 1_000_000) * pricing.cacheWritePerMTok +
    (cacheReadTokens / 1_000_000) * pricing.cacheReadPerMTok +
    (outputTokens / 1_000_000) * pricing.outputPerMTok
  );
}

/** Price one assistant response for the given model config. */
export function computeUsageCost(
  config: ModelConfig,
  usage: { inputTokens: number; outputTokens: number; cacheCreationTokens: number; cacheReadTokens: number },
): number {
  return computeCallCost(
    config,
    usage.inputTokens,
    usage.inputTokens - usage.cacheCreationTokens - usage.cacheReadTokens,
    usage.cacheCreationTokens,
    usage.cacheReadTokens,
    usage.outputTokens,
  );
}

// ── Subagent runtime ─────────────────────────────────────────────────────────

export type SubagentRuntimeDeps = {
  /** Resolve the model config for a subagent run (undefined = current model). */
  resolveModelConfig: (modelId: string | undefined) => ModelConfig;
};

export type SubagentRuntimeContext = {
  skillsSection: string;
  globalAgentsFileContents: string | null;
  agentsFileContents: string | null;
};

/**
 * Build the runtime injected into the agent tool via setAgentRuntime(). The
 * caller supplies model resolution and cost wiring; everything else (system
 * prompt shape, tool filtering) is shared between TUI and headless runs.
 */
export function makeSubagentRuntime(
  deps: SubagentRuntimeDeps,
  context: SubagentRuntimeContext,
): AgentRuntime {
  return {
    run: async ({ agent, task, signal, onProgress }) => {
      const modelConfig = deps.resolveModelConfig(agent.model || undefined);
      const provider = await resolveProvider(modelConfig);
      const body = await loadAgentBody(agent);
      const subagentTools = filterToolsForAgent(agent);

      const system = [
        `You are ${agent.name}, a subagent of the Pace coding agent. You work in an isolated context window and do not see the main conversation. Complete the task you are given. Work autonomously with your tools. When you are done, return a concise final report with the key results and any important file paths.`,
        `Current working directory: ${formatCwd(process.cwd())}`,
        `Current date (YYYY-MM-DD): ${new Date().toISOString().split("T")[0]}`,
        // Same skills section as the main prompt, but only when this agent
        // can actually load skills (explicit tools lists may exclude it).
        ...(context.skillsSection && subagentTools.some((t) => t.name === "skill")
          ? [context.skillsSection]
          : []),
        ...(context.globalAgentsFileContents
          ? [`# Global instructions (from ~/.config/pace/AGENTS.md)\n\n${context.globalAgentsFileContents}`]
          : []),
        ...(context.agentsFileContents
          ? [`# Project-specific instructions (from AGENTS.md)\n\n${context.agentsFileContents}`]
          : []),
        body,
      ].join("\n\n---\n\n");

      return runSubagent({
        system,
        task,
        tools: subagentTools,
        toolDefs: toProviderToolDefinitions(subagentTools),
        provider,
        modelConfig,
        signal,
        onProgress,
        onUsage: (usage) => computeUsageCost(modelConfig, usage),
      });
    },
  };
}
