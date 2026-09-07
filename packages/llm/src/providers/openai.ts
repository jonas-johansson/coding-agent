/**
 * OpenAI provider — uses the official `openai` npm package and the
 * Responses API for streaming tool-use conversations.
 *
 * Supports reasoning models (GPT-5.5, etc.) by capturing raw output items
 * — including reasoning items — and storing them on the AssistantMessage's
 * `providerMetadata` field. On subsequent requests, these are sanitized and
 * replayed so the model can continue after tool calls without relying on
 * server-side item persistence.
 */

import OpenAI, { APIUserAbortError } from "openai";
import type {
  Provider,
  ProviderStream,
  ProviderResponse,
  ProviderMessage,
  ContentBlock,
  StreamEvent,
  ToolDefinition,
  UsageInfo,
} from "../provider";
import type {
  ResponseInputItem,
  ResponseOutputItem,
  ResponseStreamEvent,
  ResponseFunctionCallOutputItemList,
  FunctionTool,
  ResponseCreateParamsStreaming,
} from "openai/resources/responses/responses";
import { serializeToolArguments } from "./openai-compatible";

// ── Provider metadata type ──────────────────────────────────────────────────

/**
 * Shape of the `providerMetadata` stored on AssistantMessages originating
 * from this provider. Contains the raw Responses API output items; they are
 * sanitized before being sent as input on subsequent requests.
 */
type OpenAIMetadata = {
  provider: "openai";
  outputItems: ResponseOutputItem[];
};

function isOpenAIMetadata(v: unknown): v is OpenAIMetadata {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as Record<string, unknown>).provider === "openai" &&
    Array.isArray((v as Record<string, unknown>).outputItems)
  );
}

function textFromOutputMessage(item: Extract<ResponseOutputItem, { type: "message" }>): string {
  // Some OpenAI-compatible endpoints (e.g. OpenCode Zen) emit `content: null`.
  return (item.content ?? [])
    .map((part) => {
      if (part.type === "output_text") return part.text;
      if (part.type === "refusal") return part.refusal;
      return "";
    })
    .join("");
}

function textFromReasoningItem(item: Extract<ResponseOutputItem, { type: "reasoning" }>): string {
  const reasoningText = item.content?.map((part) => part.text).join("") ?? "";
  if (reasoningText) {
    return reasoningText;
  }

  return (item.summary ?? []).map((part) => part.text).filter(Boolean).join("\n");
}

function stripReplayReadonlyFields(item: ResponseOutputItem): ResponseInputItem {
  const { id: _id, status: _status, created_by: _createdBy, ...rest } = item as unknown as Record<string, unknown>;
  return rest as unknown as ResponseInputItem;
}

function isFunctionCallInputItem(
  item: ResponseInputItem,
): item is Extract<ResponseInputItem, { type: "function_call" }> {
  return (item as { type?: string }).type === "function_call";
}

function toReplayInputItem(item: ResponseOutputItem): ResponseInputItem | undefined {
  if (item.type === "reasoning") {
    if (!item.encrypted_content) {
      return undefined;
    }

    return {
      type: "reasoning",
      encrypted_content: item.encrypted_content,
      summary: item.summary,
    } as unknown as ResponseInputItem;
  }

  if (item.type === "message") {
    const text = textFromOutputMessage(item);
    if (!text) {
      return undefined;
    }

    return {
      type: "message",
      role: "assistant",
      content: text,
      ...(item.phase !== undefined && { phase: item.phase }),
    };
  }

  if (item.type === "function_call") {
    return {
      type: "function_call",
      call_id: item.call_id,
      name: item.name,
      arguments: item.arguments,
      ...(item.namespace !== undefined && { namespace: item.namespace }),
    };
  }

  return stripReplayReadonlyFields(item);
}

// ── Message translation ─────────────────────────────────────────────────────

/**
 * Convert our provider-agnostic messages into Responses API input items.
 *
 * For assistant messages that carry `providerMetadata` from a previous
 * OpenAI response, we replay sanitized output items. Responses created with
 * `store: false` are not persisted server-side, so replaying service-assigned
 * item ids (especially reasoning ids) can make the API try to look them up and
 * fail. Reasoning continuity is preserved via encrypted_content when available.
 * For messages without metadata (e.g. from a different provider or a legacy
 * session), we translate from the ContentBlock format.
 */
function toResponsesInput(messages: ProviderMessage[]): ResponseInputItem[] {
  const items: ResponseInputItem[] = [];

  for (const msg of messages) {
    if (msg.role === "user") {
      // Build a single multi-part user message for text/image blocks,
      // then emit separate function_call_output items for tool results.
      const parts: Array<
        | { type: "input_text"; text: string }
        | { type: "input_image"; image_url: string; detail: "auto" }
      > = [];

      for (const block of msg.content) {
        if (block.type === "text") {
          parts.push({ type: "input_text", text: block.text });
        } else if (block.type === "image") {
          parts.push({
            type: "input_image",
            image_url: `data:${block.mediaType};base64,${block.data}`,
            detail: "auto",
          });
        } else {
          // tool_result → flush any accumulated parts, then emit function_call_output
          if (parts.length > 0) {
            items.push({
              role: "user",
              content: parts.length === 1 && parts[0].type === "input_text"
                ? parts[0].text
                : parts as unknown as string,
            } as ResponseInputItem);
            parts.length = 0;
          }

          const hasImage = block.content.some((p) => p.type === "image");
          if (hasImage) {
            const outputParts: ResponseFunctionCallOutputItemList = [];
            for (const part of block.content) {
              if (part.type === "text") {
                outputParts.push({ type: "input_text", text: block.is_error ? `Error: ${part.text}` : part.text });
              } else if (part.type === "image") {
                outputParts.push({
                  type: "input_image",
                  image_url: `data:${part.mediaType};base64,${part.data}`,
                  detail: "auto",
                });
              }
            }
            items.push({
              type: "function_call_output",
              call_id: block.tool_use_id,
              output: outputParts,
            });
          } else {
            const text = block.content.filter((p) => p.type === "text").map((p) => p.text).join("\n");
            items.push({
              type: "function_call_output",
              call_id: block.tool_use_id,
              output: block.is_error ? `Error: ${text}` : text,
            });
          }
        }
      }

      // Flush remaining parts
      if (parts.length > 0) {
        items.push({
          role: "user",
          content: parts.length === 1 && parts[0].type === "input_text"
            ? parts[0].text
            : parts as unknown as string,
        } as ResponseInputItem);
      }
    } else {
      // Assistant message — prefer sanitized OpenAI output items if available.
      if (isOpenAIMetadata(msg.providerMetadata)) {
        const replayed: ResponseInputItem[] = [];
        for (const item of msg.providerMetadata.outputItems) {
          const replayItem = toReplayInputItem(item);
          if (replayItem) {
            replayed.push(replayItem);
          }
        }

        // A stream that ended before emitting response.output_item.done for a
        // function call still yields a tool_use content block (via the
        // completed-tool-calls fallback) but no function_call output item.
        // Replaying such metadata would send a function_call_output with no
        // matching call, which the API rejects with a 400. Synthesize the
        // missing function_call items from the content blocks. This also
        // repairs sessions persisted before the stream adapter kept metadata
        // consistent.
        const replayedCallIds = new Set(
          replayed.filter(isFunctionCallInputItem).map((item) => item.call_id),
        );
        for (const block of msg.content) {
          if (block.type === "tool_use" && !replayedCallIds.has(block.id)) {
            replayed.push({
              type: "function_call",
              call_id: block.id,
              name: block.name,
              arguments: serializeToolArguments(block.input),
            });
          }
        }

        items.push(...replayed);
        continue;
      }

      // Fallback: translate from our ContentBlock format (no reasoning items)
      const textParts: string[] = [];

      for (const block of msg.content) {
        if (block.type === "text") {
          textParts.push(block.text);
        } else {
          // Flush any accumulated text before the tool call
          if (textParts.length > 0) {
            items.push({
              role: "assistant",
              content: textParts.join("\n"),
            });
            textParts.length = 0;
          }

          items.push({
            type: "function_call",
            call_id: block.id,
            name: block.name,
            arguments: serializeToolArguments(block.input),
          });
        }
      }

      // Flush remaining text
      if (textParts.length > 0) {
        items.push({
          role: "assistant",
          content: textParts.join("\n"),
        });
      }
    }
  }

  return items;
}

function toResponsesTools(tools: ToolDefinition[]): FunctionTool[] {
  return tools.map((t) => ({
    type: "function" as const,
    name: t.name,
    description: t.description,
    parameters: t.inputSchema,
    strict: false,
  }));
}

function parseToolArguments(args: string): unknown {
  try {
    return JSON.parse(args);
  } catch {
    return args;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function openAIReasoningOption(options: Record<string, unknown> | undefined): ResponseCreateParamsStreaming["reasoning"] | undefined {
  const reasoning = options?.reasoning;
  if (isRecord(reasoning)) {
    return reasoning as ResponseCreateParamsStreaming["reasoning"];
  }
  return undefined;
}

function openAIIncludeOption(options: Record<string, unknown> | undefined): ResponseCreateParamsStreaming["include"] | undefined {
  const include = options?.include;
  if (Array.isArray(include) && include.every((value) => typeof value === "string")) {
    return include as ResponseCreateParamsStreaming["include"];
  }
  return undefined;
}

function contentFromOutputItems(outputItems: ResponseOutputItem[]): ContentBlock[] {
  const content: ContentBlock[] = [];

  for (const item of outputItems) {
    if (item.type === "message") {
      const text = (item.content ?? [])
        .map((part) => {
          if (part.type === "output_text") return part.text;
          if (part.type === "refusal") return part.refusal;
          return "";
        })
        .join("");

      if (text) {
        content.push({ type: "text", text });
      }
    } else if (item.type === "function_call") {
      content.push({
        type: "tool_use",
        id: item.call_id,
        name: item.name,
        input: parseToolArguments(item.arguments),
      });
    }
  }

  return content;
}

// ── Provider implementation ─────────────────────────────────────────────────

export class OpenAIProvider implements Provider {
  private client: OpenAI;

  constructor(options?: { apiKey?: string; baseURL?: string }) {
    this.client = new OpenAI({
      ...(options?.apiKey && { apiKey: options.apiKey }),
      ...(options?.baseURL && { baseURL: options.baseURL }),
    });
  }

  async stream(params: {
    model: string;
    system: string;
    messages: ProviderMessage[];
    tools: ToolDefinition[];
    maxTokens: number;
    providerOptions?: Record<string, unknown>;
    signal?: AbortSignal;
  }): Promise<ProviderStream> {
    const reasoning = openAIReasoningOption(params.providerOptions);
    const include = openAIIncludeOption(params.providerOptions);

    let eventStream: AsyncIterable<ResponseStreamEvent>;
    try {
      // Stream raw events via responses.create() instead of the
      // responses.stream() helper. The helper's ResponseStream accumulator
      // indexes response.output[...] and message content[...] without null
      // guards and crashes ("Cannot read properties of null (reading '0')")
      // when an OpenAI-compatible endpoint (e.g. OpenCode Zen) emits
      // `output: null` in response.created or `content: null` on a message
      // output item. OpenAIStream does its own event accumulation and never
      // uses the helper's snapshot/finalResponse features.
      eventStream = await this.client.responses.create(
        {
          model: params.model,
          instructions: params.system,
          input: toResponsesInput(params.messages),
          tools: toResponsesTools(params.tools),
          max_output_tokens: params.maxTokens,
          parallel_tool_calls: true,
          store: false,
          stream: true,
          ...(reasoning && { reasoning }),
          ...(include && { include }),
        },
        { signal: params.signal },
      );
    } catch (error) {
      // The SDK converts fetch aborts into APIUserAbortError; translate back
      // to a DOMException AbortError so isAbortError() recognizes the cancel.
      if (error instanceof APIUserAbortError || params.signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      throw error;
    }

    return new OpenAIStream(eventStream, params.signal);
  }
}

// ── Stream adapter ──────────────────────────────────────────────────────────

/**
 * Accumulator state for a single tool call being streamed.
 */
type PendingToolCall = {
  itemId: string;
  callId: string;
  name: string;
  arguments: string;
};

class OpenAIStream implements ProviderStream {
  private inner: AsyncIterable<ResponseStreamEvent>;
  private signal?: AbortSignal;

  // Accumulated state built up during iteration, consumed by finalMessage().
  private fullTextContent = "";
  private completedToolCalls: PendingToolCall[] = [];
  private pendingToolCallsByItemId = new Map<string, PendingToolCall>();
  private pendingToolCallsByCallId = new Map<string, PendingToolCall>();
  private pendingToolCallsByOutputIndex = new Map<number, PendingToolCall>();
  private outputItems: ResponseOutputItem[] = [];
  private usage: UsageInfo = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
  private hasToolCalls = false;
  private iterationDone = false;

  constructor(inner: AsyncIterable<ResponseStreamEvent>, signal?: AbortSignal) {
    this.inner = inner;
    this.signal = signal;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    const startedTools = new Set<string>();
    const streamedReasoningOutputIndexes = new Set<number>();
    // Track any open assistant text/reasoning block so transitions are explicit.
    let openBlock: "text" | "reasoning" | undefined;

    for await (const event of this.inner) {
      switch (event.type) {
        // ── Reasoning output ──
        // GPT-5.5 streams reasoning separately from final answer text. Surface both
        // raw reasoning-text deltas and reasoning-summary deltas through the common
        // provider reasoning events so the TUI can render them as thinking blocks.
        case "response.reasoning_text.delta":
        case "response.reasoning_summary_text.delta": {
          streamedReasoningOutputIndexes.add(event.output_index);
          if (event.delta === "") {
            break;
          }

          if (openBlock === "text") {
            openBlock = undefined;
            yield { type: "block_stop" };
          }

          if (openBlock !== "reasoning") {
            openBlock = "reasoning";
            yield { type: "reasoning_start", text: event.delta };
          } else {
            yield { type: "reasoning_delta", text: event.delta };
          }
          break;
        }

        // ── Text output ──
        case "response.output_text.delta": {
          if (event.delta === "") {
            break;
          }

          if (openBlock === "reasoning") {
            openBlock = undefined;
            yield { type: "block_stop" };
          }

          if (openBlock !== "text") {
            openBlock = "text";
            yield { type: "text_start", text: event.delta };
          } else {
            yield { type: "text_delta", text: event.delta };
          }
          this.fullTextContent += event.delta;
          break;
        }

        // ── Function call started ──
        case "response.output_item.added": {
          if (event.item.type === "function_call") {
            // Close any open text/reasoning block before starting tool calls.
            if (openBlock) {
              openBlock = undefined;
              yield { type: "block_stop" };
            }

            this.hasToolCalls = true;
            const itemId = event.item.id ?? event.item.call_id;
            const callId = event.item.call_id;
            const name = event.item.name;

            const pending: PendingToolCall = { itemId, callId, name, arguments: "" };
            this.pendingToolCallsByItemId.set(itemId, pending);
            this.pendingToolCallsByCallId.set(callId, pending);
            this.pendingToolCallsByOutputIndex.set(event.output_index, pending);

            if (!startedTools.has(callId)) {
              startedTools.add(callId);
              yield { type: "tool_use_start", id: callId, name };
            }
          }
          break;
        }

        // ── Function call arguments delta ──
        case "response.function_call_arguments.delta": {
          const pending =
            this.pendingToolCallsByItemId.get(event.item_id) ??
            this.pendingToolCallsByOutputIndex.get(event.output_index);
          if (pending) {
            pending.arguments += event.delta;
            yield { type: "tool_input_delta", id: pending.callId, partialJson: event.delta };
          }
          break;
        }

        // ── Output item done ──
        case "response.output_item.done": {
          // Capture all completed output items (reasoning, messages, tool calls)
          this.outputItems.push(event.item);

          if (event.item.type === "reasoning" && !streamedReasoningOutputIndexes.has(event.output_index)) {
            const reasoningText = textFromReasoningItem(event.item);
            if (reasoningText) {
              if (openBlock) {
                openBlock = undefined;
                yield { type: "block_stop" };
              }
              yield { type: "reasoning_start", text: reasoningText };
              yield { type: "block_stop" };
            }
          }

          if (event.item.type === "function_call") {
            const itemId = event.item.id ?? event.item.call_id;
            const pending =
              this.pendingToolCallsByItemId.get(itemId) ??
              this.pendingToolCallsByCallId.get(event.item.call_id) ??
              this.pendingToolCallsByOutputIndex.get(event.output_index) ??
              { itemId, callId: event.item.call_id, name: event.item.name, arguments: "" };
            pending.arguments = event.item.arguments;
            this.completedToolCalls.push(pending);
            this.pendingToolCallsByItemId.delete(pending.itemId);
            this.pendingToolCallsByCallId.delete(pending.callId);
            this.pendingToolCallsByOutputIndex.delete(event.output_index);
            yield { type: "block_stop", id: pending.callId };
          }
          break;
        }

        // ── Text/reasoning content part done ──
        case "response.content_part.done": {
          if (event.part.type === "reasoning_text") {
            if (openBlock === "reasoning") {
              openBlock = undefined;
              yield { type: "block_stop" };
            }
          } else if (openBlock === "text") {
            openBlock = undefined;
            yield { type: "block_stop" };
          }
          break;
        }

        // ── Reasoning content/summary done ──
        case "response.reasoning_text.done":
        case "response.reasoning_summary_text.done": {
          if (openBlock === "reasoning") {
            openBlock = undefined;
            yield { type: "block_stop" };
          }
          break;
        }

        // ── Response completed — extract usage ──
        case "response.completed": {
          const resp = event.response;
          if (resp?.usage) {
            this.usage = {
              inputTokens: resp.usage.input_tokens,
              outputTokens: resp.usage.output_tokens,
              cacheReadTokens: resp.usage.input_tokens_details?.cached_tokens ?? 0,
              cacheCreationTokens: 0,
            };
          }
          break;
        }

        default:
          break;
      }
    }

    // The SDK's raw stream swallows fetch aborts and simply ends the
    // iteration. Surface cancellation as a DOMException AbortError so the
    // caller takes its cancel path instead of completing an empty turn.
    if (this.signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }

    // Close any still-open text/reasoning block.
    if (openBlock) {
      yield { type: "block_stop" };
    }

    // Move any remaining pending tool calls to completed. Normally OpenAI emits
    // response.output_item.done for each function call, but this preserves the
    // best-effort fallback behavior if a stream ends without those events.
    for (const [, tc] of this.pendingToolCallsByItemId) {
      this.completedToolCalls.push(tc);
    }
    this.pendingToolCallsByItemId.clear();
    this.pendingToolCallsByCallId.clear();
    this.pendingToolCallsByOutputIndex.clear();

    this.iterationDone = true;
  }

  async finalMessage(): Promise<ProviderResponse> {
    // If the caller didn't fully consume the iterator, drain it.
    if (!this.iterationDone) {
      const iter = this[Symbol.asyncIterator]();
      while (!(await iter.next()).done) {
        // drain
      }
    }

    const content = contentFromOutputItems(this.outputItems);

    // Best-effort fallback for incomplete streams that produced text/tool deltas
    // but did not emit the corresponding response.output_item.done events.
    const hasOutputMessage = this.outputItems.some((item) => item.type === "message");
    if (!hasOutputMessage && this.fullTextContent) {
      content.unshift({ type: "text", text: this.fullTextContent });
    }

    const outputToolCallIds = new Set(
      this.outputItems
        .filter((item) => item.type === "function_call")
        .map((item) => item.call_id),
    );
    for (const tc of this.completedToolCalls) {
      if (outputToolCallIds.has(tc.callId)) continue;
      content.push({
        type: "tool_use",
        id: tc.callId,
        name: tc.name,
        input: parseToolArguments(tc.arguments),
      });
      // Keep the replayed metadata consistent with the content: without the
      // function_call output item, the next request would carry a
      // function_call_output with no matching call and the API would reject
      // it with a 400.
      this.outputItems.push({
        type: "function_call",
        id: tc.itemId,
        call_id: tc.callId,
        name: tc.name,
        arguments: serializeToolArguments(parseToolArguments(tc.arguments)),
      } as ResponseOutputItem);
    }

    const stopReason: "end_turn" | "tool_use" =
      this.hasToolCalls ? "tool_use" : "end_turn";

    const metadata: OpenAIMetadata = {
      provider: "openai",
      outputItems: this.outputItems,
    };

    return {
      content,
      stopReason,
      usage: this.usage,
      providerMetadata: metadata,
    };
  }
}
