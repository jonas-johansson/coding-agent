/**
 * Headless subagent runner.
 *
 * Runs a fresh agent loop in an isolated message list. The subagent does not
 * see the parent conversation. It returns only its final text, which keeps
 * exploration and tool noise out of the parent context.
 */

import type { ContentBlock, ProviderMessage } from "@pace/llm";
import type { ModelConfig, Provider, ToolDefinition } from "@pace/llm";
import type { ToolDescriptor } from "./tools/core";
import { runAgentLoop } from "./loop";

// ── Types ────────────────────────────────────────────────────────────────────

export type SubagentResult = {
  text: string;
  turns: number;
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** Total cost of all turns, aggregated from the onUsage callback. */
  cost: number;
  hitTurnCap: boolean;
};

export type SubagentRunParams = {
  system: string;
  task: string;
  /** Tool descriptors used to execute tool calls. */
  tools: ToolDescriptor[];
  /** Provider-agnostic tool definitions sent to the model. */
  toolDefs: ToolDefinition[];
  provider: Provider;
  modelConfig: ModelConfig;
  signal?: AbortSignal;
  /** Called with a short status line per step, for TUI progress. */
  onProgress?: (line: string) => void;
  /**
   * Called after each assistant turn with that turn's usage.
   * Return the cost of the turn; the runner aggregates it into the result.
   */
  onUsage?: (usage: { inputTokens: number; outputTokens: number; cacheCreationTokens: number; cacheReadTokens: number }) => number;
  maxTurns?: number;
};

export const DEFAULT_MAX_SUBAGENT_TURNS = 100;

// ── Runner ───────────────────────────────────────────────────────────────────

export async function runSubagent(params: SubagentRunParams): Promise<SubagentResult> {
  const messages: ProviderMessage[] = [
    { role: "user", content: [{ type: "text", text: params.task }] },
  ];

  let lastText = "";
  let turn = 0;

  // Progress: show only the current turn and current step, e.g. "turn 2 · read".
  const progress = (step: string) => params.onProgress?.(`turn ${turn} · ${step}`);

  const result = await runAgentLoop({
    provider: params.provider,
    model: params.modelConfig.providerModel,
    system: params.system,
    tools: params.tools,
    toolDefs: params.toolDefs,
    maxTokens: params.modelConfig.maxOutputTokens,
    providerOptions: params.modelConfig.providerOptions,
    signal: params.signal,
    maxTurns: params.maxTurns ?? DEFAULT_MAX_SUBAGENT_TURNS,

    getMessages: () => {
      turn += 1;
      progress("thinking");
      return messages;
    },
    computeCost: (usage) => params.onUsage?.(usage) ?? 0,

    onStreamEvent: (event) => {
      if (event.type === "tool_use_start") {
        progress(event.name);
      }
    },
    onResponse: (response) => {
      const text = response.content
        .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      if (text) lastText = text;
      messages.push({ role: "assistant", content: response.content });
    },
    onToolResults: (executed) => {
      messages.push({
        role: "user",
        content: executed.map((executedTool) => executedTool.result),
      });
    },
  });

  return {
    text: lastText,
    turns: result.turns,
    tokensIn: result.usage.inputTokens,
    tokensOut: result.usage.outputTokens,
    cacheReadTokens: result.usage.cacheReadTokens,
    cacheCreationTokens: result.usage.cacheCreationTokens,
    cost: result.totalCost,
    hitTurnCap: result.hitTurnCap,
  };
}
