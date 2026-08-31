/**
 * Event-driven agent loop.
 *
 * Runs the stream → tool-call → stream cycle against a provider until the
 * model stops calling tools. The loop owns control flow, tool execution,
 * and cost/usage rollup, and reports everything through callbacks. It never
 * touches sessions, drafts, or UI: callers persist assistant/tool-result
 * data via the `onResponse`/`onToolResults` hooks and render from events.
 */

import type {
  ContentBlock,
  Provider,
  ProviderResponse,
  ProviderMessage,
  StreamEvent,
  ToolDefinition,
  ToolResultContent,
  ToolUseBlock,
  UsageInfo,
} from "@pace/llm";
import { isAbortError, formatToolResultBody, throwIfAborted, type ToolDescriptor } from "./tools/core";
import { truncateToolOutputIfNeeded } from "./tools/output";

// ── Types ────────────────────────────────────────────────────────────────────

export type ExecutedTool = {
  result: ToolResultContent;
  cost?: number;
  /**
   * User-facing body for the TUI: the tool's `display` override when set,
   * otherwise the formatted output body (empty when the tool hides content).
   */
  display: string;
};

export type AgentLoopResult = {
  /** True when the run ended because the abort signal fired. */
  cancelled: boolean;
  /** True when the run ended because maxTurns was reached. */
  hitTurnCap: boolean;
  turns: number;
  totalCost: number;
  /** Cumulative usage summed over all assistant responses. */
  usage: UsageInfo;
};

export type AgentLoopParams = {
  provider: Provider;
  model: string;
  system: string;
  /** Tool descriptors used to execute tool calls. */
  tools: ToolDescriptor[];
  /** Provider-agnostic tool definitions sent to the model. */
  toolDefs: ToolDefinition[];
  maxTokens: number;
  providerOptions?: Record<string, unknown>;
  signal?: AbortSignal;
  /** Maximum assistant turns. Unlimited when omitted. */
  maxTurns?: number;

  /**
   * Build the provider request messages for an iteration. Called once per
   * iteration so callers can inject steering entries, compact context, or
   * cap payload size.
   */
  getMessages: () => ProviderMessage[];
  /**
   * Deliver queued steering messages at an iteration boundary, before
   * `getMessages` is called. Return the message texts (for display); the
   * caller is responsible for persisting them so the next `getMessages`
   * includes them.
   */
  takeSteeringMessages?: () => string[];
  /** Price a single assistant response's usage. */
  computeCost: (usage: UsageInfo) => number;

  /** Raw provider stream events, forwarded as they arrive. */
  onStreamEvent?: (event: StreamEvent) => void;
  /** Streamed incremental output from a running tool (appended). */
  onToolOutput?: (toolUseId: string, chunk: string) => void;
  /** Streamed output from a running tool (replaces previous content). */
  onToolContent?: (toolUseId: string, content: string) => void;
  /**
   * Called after each assistant response, before its tool calls execute.
   * Persist the assistant message here.
   */
  onResponse?: (
    response: ProviderResponse,
    meta: { cost: number; streamDurationMs: number },
  ) => void;
  /**
   * Called once per iteration with the results for every tool call of the
   * preceding assistant message, in tool-call order. Persist them here.
   * On cancellation, unexecuted calls receive synthesized error results.
   */
  onToolResults?: (executed: ExecutedTool[]) => void;
  /**
   * Called as soon as each individual tool call finishes, even while other
   * parallel calls from the same assistant message are still running. Use
   * this for per-tool UI updates; persistence should use onToolResults.
   */
  onToolResult?: (executed: ExecutedTool) => void;
};

// ── Tool execution ───────────────────────────────────────────────────────────

export function makeToolErrorResult(toolUseId: string, text: string): ToolResultContent {
  return {
    type: "tool_result",
    tool_use_id: toolUseId,
    is_error: true,
    content: [{ type: "text", text }],
  };
}

/**
 * Execute a single tool call: registry lookup, input validation, execution
 * with streaming-output callbacks, truncation, and error mapping. Throws
 * only on abort.
 */
export async function executeToolCall(
  block: ToolUseBlock,
  toolList: ToolDescriptor[],
  signal?: AbortSignal,
  context?: { onOutput?: (content: string) => void; onContent?: (content: string) => void },
): Promise<ExecutedTool> {
  const tool = toolList.find((candidate) => candidate.name === block.name);
  if (!tool) {
    const errorText = `Couldn't find tool ${block.name}`;
    return { result: makeToolErrorResult(block.id, errorText), display: errorText };
  }

  const inputParseResult = tool.inputSchema.safeParse(block.input);
  if (!inputParseResult.success) {
    const errorText = `Input did not match schema: ${JSON.stringify(inputParseResult.error.issues)}`;
    return { result: makeToolErrorResult(block.id, errorText), display: errorText };
  }

  try {
    const rawOutput = await tool.execute(inputParseResult.data, signal, context);
    const output = tool.truncateOutput === false
      ? rawOutput
      : await truncateToolOutputIfNeeded(rawOutput, tool.name, block.id);

    const showContent = tool.showContent !== false || output.is_error === true;
    return {
      result: {
        type: "tool_result",
        tool_use_id: block.id,
        content: output.content,
        ...(output.is_error && { is_error: true }),
      },
      ...(output.cost !== undefined && { cost: output.cost }),
      display: output.display ?? (showContent ? formatToolResultBody(output) : ""),
    };
  } catch (error) {
    if (isAbortError(error)) throw error;
    const errorText = error instanceof Error ? error.message : String(error);
    return { result: makeToolErrorResult(block.id, errorText), display: errorText };
  }
}

function hasExclusiveTool(toolUseBlocks: ToolUseBlock[], toolList: ToolDescriptor[]): boolean {
  return toolUseBlocks.some((block) => {
    const tool = toolList.find((candidate) => candidate.name === block.name);
    return tool?.concurrency !== "safe";
  });
}

// ── Loop ─────────────────────────────────────────────────────────────────────

function isToolUseBlock(block: ContentBlock): block is ToolUseBlock {
  return block.type === "tool_use";
}

export async function runAgentLoop(params: AgentLoopParams): Promise<AgentLoopResult> {
  let turns = 0;
  let cancelled = false;
  let hitTurnCap = false;
  let totalCost = 0;
  const usage: UsageInfo = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };

  while (true) {
    if (params.maxTurns !== undefined && turns >= params.maxTurns) {
      hitTurnCap = true;
      break;
    }
    turns += 1;
    throwIfAborted(params.signal);

    params.takeSteeringMessages?.();

    const messages = params.getMessages();

    const stream = await params.provider.stream({
      model: params.model,
      system: params.system,
      messages,
      tools: params.toolDefs,
      maxTokens: params.maxTokens,
      providerOptions: params.providerOptions,
      signal: params.signal,
    });

    // Start timing when the request is issued so downstream TPS stats
    // measure generation speed, not time-to-first-token.
    const streamStart = performance.now();

    for await (const event of stream) {
      params.onStreamEvent?.(event);
    }

    const response = await stream.finalMessage();
    const streamDurationMs = Math.max(1, performance.now() - streamStart);

    usage.inputTokens += response.usage.inputTokens;
    usage.outputTokens += response.usage.outputTokens;
    usage.cacheReadTokens += response.usage.cacheReadTokens;
    usage.cacheCreationTokens += response.usage.cacheCreationTokens;

    const callCost = params.computeCost(response.usage);
    totalCost += callCost;

    params.onResponse?.(response, { cost: callCost, streamDurationMs });

    const toolUseBlocks = response.content.filter(isToolUseBlock);
    if (toolUseBlocks.length === 0 && response.stopReason !== "tool_use") {
      break;
    }

    // Collect and execute tool calls. Results are returned as one grouped
    // user message so every tool_use in this assistant turn is answered
    // together, even when execution happens in parallel.
    const completed = new Map<string, ExecutedTool>();
    let abortedDuringExecution = false;
    try {
      const runOne = async (block: ToolUseBlock): Promise<ExecutedTool> => {
        const executed = await executeToolCall(block, params.tools, params.signal, {
          ...(params.onToolOutput && {
            onOutput: (chunk) => params.onToolOutput!(block.id, chunk),
          }),
          ...(params.onToolContent && {
            onContent: (content) => params.onToolContent!(block.id, content),
          }),
        });
        completed.set(block.id, executed);
        params.onToolResult?.(executed);
        return executed;
      };

      if (hasExclusiveTool(toolUseBlocks, params.tools)) {
        for (const block of toolUseBlocks) {
          throwIfAborted(params.signal);
          await runOne(block);
        }
      } else {
        await Promise.all(toolUseBlocks.map(runOne));
      }
    } catch (error) {
      if (!isAbortError(error)) throw error;
      abortedDuringExecution = true;
    }

    // Answer every tool call of the turn in tool-call order so the persisted
    // conversation stays valid. On abort, unexecuted calls receive
    // synthesized cancelled results.
    const executedTools = toolUseBlocks.map(
      (block) =>
        completed.get(block.id)
        ?? (abortedDuringExecution
          ? {
              result: makeToolErrorResult(block.id, "Tool execution was cancelled by the user."),
              display: "Tool execution was cancelled by the user.",
            }
          : {
              result: makeToolErrorResult(block.id, "Tool execution did not produce a result."),
              display: "Tool execution did not produce a result.",
            }),
    );

    for (const executed of executedTools) {
      if (executed.cost !== undefined) {
        totalCost += executed.cost;
      }
    }
    params.onToolResults?.(executedTools);

    if (abortedDuringExecution) {
      cancelled = true;
      break;
    }
  }

  return {
    cancelled,
    hitTurnCap,
    turns,
    totalCost,
    usage,
  };
}
