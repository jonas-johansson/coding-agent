/**
 * Headless subagent runner.
 *
 * Runs a fresh agent loop in an isolated message list. The subagent does not
 * see the parent conversation. It returns only its final text, which keeps
 * exploration and tool noise out of the parent context.
 */

import type {
  ContentBlock,
  Provider,
  ProviderMessage,
  ToolDefinition,
  ToolResultContent,
  ToolResultPart,
  ToolUseBlock,
  UsageInfo,
} from "./provider";
import type { ModelConfig } from "./models";
import {
  isAbortError,
  throwIfAborted,
  type ToolDescriptor,
  type ToolOutput,
} from "./tools/core";
import { truncateToolOutputIfNeeded } from "./tools/output";

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
  onUsage?: (usage: UsageInfo) => number;
  maxTurns?: number;
};

export const DEFAULT_MAX_SUBAGENT_TURNS = 25;

// ── Runner ───────────────────────────────────────────────────────────────────

export async function runSubagent(params: SubagentRunParams): Promise<SubagentResult> {
  const maxTurns = params.maxTurns ?? DEFAULT_MAX_SUBAGENT_TURNS;
  const messages: ProviderMessage[] = [
    { role: "user", content: [{ type: "text", text: params.task }] },
  ];

  let turns = 0;
  let lastText = "";
  let tokensIn = 0;
  let tokensOut = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let cost = 0;
  let hitTurnCap = false;

  // Progress: show only the current turn and current step, e.g. "turn 2 · read".
  // Each call carries the full text so the consumer replaces its content
  // instead of appending (see ToolExecutionContext.onContent).
  const progress = (step: string) => params.onProgress?.(`turn ${turns} · ${step}`);

  while (true) {
    if (turns >= maxTurns) {
      hitTurnCap = true;
      break;
    }
    turns += 1;
    throwIfAborted(params.signal);
    progress("thinking");

    const stream = await params.provider.stream({
      model: params.modelConfig.providerModel,
      system: params.system,
      messages,
      tools: params.toolDefs,
      maxTokens: params.modelConfig.maxOutputTokens,
      providerOptions: params.modelConfig.providerOptions,
      signal: params.signal,
    });

    for await (const event of stream) {
      if (event.type === "tool_use_start") {
        progress(event.name);
      }
    }

    const response = await stream.finalMessage();
    tokensIn += response.usage.inputTokens;
    tokensOut += response.usage.outputTokens;
    cacheReadTokens += response.usage.cacheReadTokens;
    cacheCreationTokens += response.usage.cacheCreationTokens;
    cost += params.onUsage?.(response.usage) ?? 0;

    const text = response.content
      .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    if (text) lastText = text;

    const toolUses = response.content.filter(isToolUseBlock);
    if (toolUses.length === 0) break;

    const toolResults: ToolResultContent[] = [];
    for (const block of toolUses) {
      throwIfAborted(params.signal);
      toolResults.push(await executeSubagentTool(block, params.tools, params.signal));
    }

    messages.push({ role: "assistant", content: response.content });
    messages.push({ role: "user", content: toolResults });
  }

  return {
    text: lastText,
    turns,
    tokensIn,
    tokensOut,
    cacheReadTokens,
    cacheCreationTokens,
    cost,
    hitTurnCap,
  };
}

// ── Tool execution ───────────────────────────────────────────────────────────

async function executeSubagentTool(
  block: ToolUseBlock,
  toolList: ToolDescriptor[],
  signal?: AbortSignal,
): Promise<ToolResultContent> {
  const tool = toolList.find((candidate) => candidate.name === block.name);
  if (!tool) {
    return makeToolError(block.id, `Couldn't find tool ${block.name}`);
  }

  const inputParseResult = tool.inputSchema.safeParse(block.input);
  if (!inputParseResult.success) {
    return makeToolError(
      block.id,
      `Input did not match schema: ${JSON.stringify(inputParseResult.error.issues)}`,
    );
  }

  try {
    const rawOutput = await tool.execute(inputParseResult.data, signal);
    const output = tool.truncateOutput === false
      ? rawOutput
      : await truncateToolOutputIfNeeded(rawOutput, tool.name, block.id);

    return {
      type: "tool_result",
      tool_use_id: block.id,
      content: toToolResultParts(output),
      ...(output.is_error && { is_error: true }),
    };
  } catch (error) {
    if (isAbortError(error)) throw error;
    return makeToolError(block.id, error instanceof Error ? error.message : String(error));
  }
}

function makeToolError(toolUseId: string, text: string): ToolResultContent {
  return {
    type: "tool_result",
    tool_use_id: toolUseId,
    content: [{ type: "text", text }],
    is_error: true,
  };
}

function toToolResultParts(output: ToolOutput): ToolResultPart[] {
  return output.content.reduce<ToolResultPart[]>((acc, part) => {
    if (part.type === "text") {
      acc.push({ type: "text", text: part.text });
    } else if (part.type === "image" && part.source.type === "base64") {
      acc.push({ type: "image", mediaType: part.source.media_type, data: part.source.data });
    }
    return acc;
  }, []);
}

function isToolUseBlock(block: ContentBlock): block is ToolUseBlock {
  return block.type === "tool_use";
}
