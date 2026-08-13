import { z } from "zod";
import { defineTool, throwIfAborted, tools, type ToolDescriptor, type ToolOutput } from "./core";
import { findAgent, formatAgentsForToolDescription, type AgentDefinition } from "../agent";
import type { SubagentResult } from "../subagent";

// ─── Agent state (set by app.ts at the start of each prompt cycle) ──────────

let currentAgents: AgentDefinition[] = [];

export function setCurrentAgents(agents: AgentDefinition[]) {
  currentAgents = agents;
}

export function getCurrentAgents() {
  return currentAgents;
}

// ─── Runtime (injected by app.ts; owns provider/model/cost wiring) ──────────

export type AgentRuntime = {
  run: (params: {
    agent: AgentDefinition;
    task: string;
    signal?: AbortSignal;
    onProgress?: (line: string) => void;
  }) => Promise<SubagentResult>;
};

let agentRuntime: AgentRuntime | null = null;

export function setAgentRuntime(runtime: AgentRuntime) {
  agentRuntime = runtime;
}

// ─── Tool set filtering ──────────────────────────────────────────────────────

/**
 * Tool set for a subagent. The `agent` tool is always excluded so
 * subagents cannot spawn subagents (nesting depth 1). The `tool_composer`
 * tool is kept, but it cannot call `agent` either (enforced in
 * tool-composer.ts), so the depth-1 rule cannot be bypassed.
 */
export function filterToolsForAgent(agent: AgentDefinition): ToolDescriptor[] {
  if (agent.tools.length === 0) {
    return tools.filter((t) => t.name !== "agent");
  }
  const allowed = new Set(agent.tools);
  return tools.filter((t) => allowed.has(t.name) && t.name !== "agent");
}

// ─── Agent tool ──────────────────────────────────────────────────────────────

function oneLine(text: string): string {
  return String(text).replace(/\s+/g, " ").trim();
}

function formatTokens(count: number): string {
  return count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count);
}

export const agentTool = defineTool({
  name: "agent",
  description:
    "Delegate a task to a specialized subagent. " +
    "Subagents run in their own isolated context window and return only their final result. " +
    "Use them for side tasks that would flood the main conversation with search results, logs, " +
    "or file contents you will not reference again. " +
    "Choose the agent whose description matches the task. " +
    "For parallel independent work, call this tool multiple times in one turn.",
  concurrency: "safe",
  inputSchema: z.object({
    agent: z.string().describe("The agent name to invoke"),
    task: z.string().describe("The task for the agent to complete"),
  }),
  titleFormatter: (input) => {
    const title = `agent: ${input.agent ?? ""}${input.task ? ` — ${oneLine(input.task)}` : ""}`;
    return title.length > 120 ? `${title.slice(0, 117)}...` : title;
  },
  execute: async (input, signal, context): Promise<ToolOutput> => {
    throwIfAborted(signal);

    const agent = findAgent(currentAgents, input.agent);
    if (!agent) {
      const listing = formatAgentsForToolDescription(currentAgents);
      const available = listing ? `\n\nAvailable agents:\n${listing}` : "";
      return {
        content: [{ type: "text", text: `Unknown agent: ${input.agent}${available}` }],
        is_error: true,
      };
    }

    if (!agentRuntime) {
      return {
        content: [{ type: "text", text: "Agent runtime is not initialized." }],
        is_error: true,
      };
    }

    const result = await agentRuntime.run({
      agent,
      task: input.task,
      signal,
      onProgress: context?.onOutput,
    });

    const capNote = result.hitTurnCap
      ? `\n\nNote: the agent hit the ${result.turns}-turn limit and may not have finished.`
      : "";
    const stats =
      `\n\n[agent: ${agent.name} · ${result.turns} turn${result.turns === 1 ? "" : "s"} · ` +
      `${formatTokens(result.tokensIn)} in / ${formatTokens(result.tokensOut)} out]`;

    return {
      content: [{ type: "text", text: `${result.text}${capNote}${stats}` }],
      cost: result.cost,
    };
  },
});
