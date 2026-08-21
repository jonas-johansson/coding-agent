/**
 * Shared provider for OpenAI-compatible Chat Completions APIs.
 *
 * Uses raw fetch() + SSE parsing so it works against any endpoint that
 * speaks the Chat Completions wire format (Fireworks, LM Studio,
 * OpenCode Zen, local gateways, ...). Vendor-specific behaviour is
 * parameterized through {@link OpenAiCompatibleProviderOptions}.
 *
 * Some backends also serve select models through an OpenAI-style
 * `/responses` endpoint instead of `/chat/completions`; requests opt in
 * per model via the `apiStyle: "responses"` provider option.
 */

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
import { fetchWithRetry } from "../fetch-retry";

export type OpenAiCompatibleProviderOptions = {
  /**
   * Identifier stored in `providerMetadata` on assistant messages. Used to
   * decide which messages' reasoning content gets replayed on later turns.
   */
  providerId: string;
  /** Human-readable name used in error messages. */
  displayName: string;
  /** Bearer token. When undefined, no Authorization header is sent. */
  apiKey?: string;
  /** Thrown when `apiKey` is required but missing. */
  missingKeyMessage?: string;
  baseUrl: string;
  /** Translate a Pace model ID into the backend's wire model identifier. */
  mapModel?: (model: string) => string;
  /** Static defaults merged under the per-request body. */
  defaultBody?: Record<string, unknown>;
  /** Retry transient failures (429s, connection resets) with backoff. */
  useFetchRetry?: boolean;
  extraHeaders?: Record<string, string>;
};

// ── OpenAI-compatible types (minimal) ────────────────────────────────────────

type OaiContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: string } };

type OaiMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | OaiContentPart[] }
  | { role: "assistant"; content?: string | null; reasoning_content?: string | null; tool_calls?: OaiToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string | OaiContentPart[] };

type OaiToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

type OaiTool = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

type OaiStreamDelta = {
  role?: string;
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: Array<{
    index: number;
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string };
  }>;
};

type OaiStreamChoice = {
  index: number;
  delta: OaiStreamDelta;
  finish_reason: string | null;
};

type OaiStreamChunk = {
  id: string;
  object: string;
  choices: OaiStreamChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: {
      cached_tokens?: number;
    };
  } | null;
};

// ── Responses API types (OpenAI-compatible) ─────────────────────────────────

type OaiResponseContentPart =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string; detail?: string };

type OaiResponseInputItem =
  | { role: "system" | "user" | "assistant"; content: string | OaiResponseContentPart[] }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string | OaiResponseContentPart[] };

type OaiResponseTool = {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

type OaiResponseStreamEvent = {
  type: string;
  delta?: string;
  item_id?: string;
  item?: {
    id: string;
    type: string;
    call_id?: string;
    name?: string;
    arguments?: string;
  };
  response?: {
    status?: string;
    error?: { message?: string } | null;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      input_tokens_details?: { cached_tokens?: number };
    };
  };
};

// ── Message translation ─────────────────────────────────────────────────────

function toOaiMessages(
  system: string,
  messages: ProviderMessage[],
  supportsImages: boolean,
  providerId: string,
): OaiMessage[] {
  const result: OaiMessage[] = [{ role: "system", content: system }];

  for (const msg of messages) {
    if (msg.role === "user") {
      // Flatten user content. Text blocks become a single string (or
      // multi-part content when images are present). Tool results become
      // separate role:"tool" messages.
      const contentParts: OaiContentPart[] = [];
      const toolResults: { tool_call_id: string; content: string | OaiContentPart[] }[] = [];
      let hasImages = false;

      for (const block of msg.content) {
        if (block.type === "text") {
          contentParts.push({ type: "text", text: block.text });
        } else if (block.type === "image") {
          if (supportsImages) {
            hasImages = true;
            contentParts.push({
              type: "image_url",
              image_url: {
                url: `data:${block.mediaType};base64,${block.data}`,
                detail: "auto",
              },
            });
          } else {
            contentParts.push({ type: "text", text: `[Image: ${block.mediaType}]` });
          }
        } else {
          // tool_result
          if (block.content.some((p) => p.type === "image")) {
            if (supportsImages) {
              // Multi-part tool result with images for vision-capable models.
              const parts: OaiContentPart[] = [];
              for (const part of block.content) {
                if (part.type === "text") {
                  parts.push({ type: "text", text: block.is_error ? `Error: ${part.text}` : part.text });
                } else if (part.type === "image") {
                  parts.push({
                    type: "image_url",
                    image_url: {
                      url: `data:${part.mediaType};base64,${part.data}`,
                      detail: "auto",
                    },
                  });
                }
              }
              toolResults.push({ tool_call_id: block.tool_use_id, content: parts });
            } else {
              // Non-vision model: replace images with placeholders so text
              // parts still reach the model.
              const text = block.content
                .map((part) =>
                  part.type === "text"
                    ? (block.is_error ? `Error: ${part.text}` : part.text)
                    : `[Image: ${part.mediaType}]`
                )
                .join("\n");
              toolResults.push({ tool_call_id: block.tool_use_id, content: text });
            }
          } else {
            const text = block.content.filter((p) => p.type === "text").map((p) => p.text).join("\n");
            toolResults.push({
              tool_call_id: block.tool_use_id,
              content: block.is_error ? `Error: ${text}` : text,
            });
          }
        }
      }

      if (contentParts.length > 0) {
        if (hasImages) {
          // Multi-part content when images are present
          result.push({ role: "user", content: contentParts });
        } else {
          // Plain string for backward compatibility when no images
          const textContent = contentParts
            .filter((p): p is { type: "text"; text: string } => p.type === "text")
            .map((p) => p.text)
            .join("\n");
          result.push({ role: "user", content: textContent });
        }
      }

      for (const tr of toolResults) {
        result.push({
          role: "tool",
          tool_call_id: tr.tool_call_id,
          content: tr.content,
        });
      }
    } else {
      // assistant
      const textParts: string[] = [];
      const toolCalls: OaiToolCall[] = [];

      for (const block of msg.content) {
        if (block.type === "text") {
          textParts.push(block.text);
        } else {
          // tool_use
          toolCalls.push({
            id: block.id,
            type: "function",
            function: {
              name: block.name,
              arguments: typeof block.input === "string" ? block.input : JSON.stringify(block.input),
            },
          });
        }
      }

      // Replay reasoning_content from providerMetadata so the model can
      // reference its prior chain-of-thought across tool-calling turns.
      // Only metadata produced by this same provider is replayed.
      const meta = msg.providerMetadata as { provider?: string; reasoningContent?: string } | undefined;
      const reasoning =
        meta?.provider === providerId && typeof meta.reasoningContent === "string"
          ? meta.reasoningContent
          : undefined;

      const assistantMsg: OaiMessage = {
        role: "assistant",
        content: textParts.length > 0 ? textParts.join("\n") : null,
        ...(reasoning && { reasoning_content: reasoning }),
        ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
      };
      result.push(assistantMsg);
    }
  }

  return result;
}

/**
 * Metadata written by this provider carries its own `provider` tag, so
 * reasoning content is only replayed for messages this provider produced.
 * Expressed indirectly because the tag is known per instance.
 */
let activeMetadataProviderId: string | undefined;

function metaProviderIdOf(_msg: ProviderMessage): string {
  return activeMetadataProviderId ?? "";
}

function toOaiTools(tools: ToolDefinition[]): OaiTool[] {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));
}

function toResponsesInput(
  system: string,
  messages: ProviderMessage[],
  supportsImages: boolean,
): OaiResponseInputItem[] {
  const items: OaiResponseInputItem[] = [
    { role: "system", content: [{ type: "input_text", text: system }] },
  ];

  for (const msg of messages) {
    if (msg.role === "user") {
      // Accumulate text/image parts into one user message, then emit
      // separate function_call_output items for tool results.
      const parts: OaiResponseContentPart[] = [];

      for (const block of msg.content) {
        if (block.type === "text") {
          parts.push({ type: "input_text", text: block.text });
        } else if (block.type === "image") {
          if (supportsImages) {
            parts.push({
              type: "input_image",
              image_url: `data:${block.mediaType};base64,${block.data}`,
              detail: "auto",
            });
          } else {
            parts.push({ type: "input_text", text: `[Image: ${block.mediaType}]` });
          }
        } else {
          // tool_result — flush accumulated parts first
          if (parts.length > 0) {
            items.push({ role: "user", content: parts });
            parts.length = 0;
          }

          const outputParts: OaiResponseContentPart[] = [];
          for (const part of block.content) {
            if (part.type === "text") {
              outputParts.push({
                type: "input_text",
                text: block.is_error ? `Error: ${part.text}` : part.text,
              });
            } else if (part.type === "image") {
              if (supportsImages) {
                outputParts.push({
                  type: "input_image",
                  image_url: `data:${part.mediaType};base64,${part.data}`,
                  detail: "auto",
                });
              } else {
                outputParts.push({ type: "input_text", text: `[Image: ${part.mediaType}]` });
              }
            }
          }

          items.push({
            type: "function_call_output",
            call_id: block.tool_use_id,
            output: outputParts.length === 1 && outputParts[0].type === "input_text"
              ? outputParts[0].text
              : outputParts,
          });
        }
      }

      if (parts.length > 0) {
        items.push({ role: "user", content: parts });
      }
    } else {
      // assistant — translate from ContentBlock format. Prior reasoning is
      // not replayed: the responses API has no reasoning_content field.
      const textParts: string[] = [];

      for (const block of msg.content) {
        if (block.type === "text") {
          textParts.push(block.text);
        } else {
          if (textParts.length > 0) {
            items.push({ role: "assistant", content: textParts.join("\n") });
            textParts.length = 0;
          }
          items.push({
            type: "function_call",
            call_id: block.id,
            name: block.name,
            arguments: typeof block.input === "string" ? block.input : JSON.stringify(block.input),
          });
        }
      }

      if (textParts.length > 0) {
        items.push({ role: "assistant", content: textParts.join("\n") });
      }
    }
  }

  return items;
}

function toResponsesTools(tools: ToolDefinition[]): OaiResponseTool[] {
  return tools.map((t) => ({
    type: "function",
    name: t.name,
    description: t.description,
    parameters: t.inputSchema,
  }));
}

// ── SSE line parser ─────────────────────────────────────────────────────────

async function* parseSseLines(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    // Keep the last potentially-incomplete line in the buffer.
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      if (trimmed.startsWith("data: ")) {
        const payload = trimmed.slice(6);
        if (payload === "[DONE]") return;
        yield payload;
      }
    }
  }

  // Flush remaining buffer
  if (buffer.trim().startsWith("data: ")) {
    const payload = buffer.trim().slice(6);
    if (payload !== "[DONE]") yield payload;
  }
}

// ── Provider implementation ─────────────────────────────────────────────────

export class OpenAiCompatibleProvider implements Provider {
  protected readonly options: OpenAiCompatibleProviderOptions;

  constructor(options: OpenAiCompatibleProviderOptions) {
    if (options.apiKey === undefined && options.missingKeyMessage) {
      throw new Error(options.missingKeyMessage);
    }
    this.options = options;
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
    const options = this.options;

    // supportsImages and apiStyle are provider-native formatting hints, not
    // API parameters.
    const providerOptions = params.providerOptions ?? {};
    const {
      supportsImages: supportsImagesOption,
      apiStyle: apiStyleOption,
      ...restProviderOptions
    } = providerOptions;
    const supportsImages = (supportsImagesOption as boolean | undefined) ?? true;
    const apiStyle = (apiStyleOption as string | undefined) ?? "chat";

    const model = options.mapModel ? options.mapModel(params.model) : params.model;
    const endpoint = apiStyle === "responses" ? "responses" : "chat/completions";

    const body = apiStyle === "responses"
      ? {
          ...options.defaultBody,
          model,
          input: toResponsesInput(params.system, params.messages, supportsImages),
          tools: toResponsesTools(params.tools),
          max_output_tokens: params.maxTokens,
          stream: true,
          ...restProviderOptions,
        }
      : {
          ...options.defaultBody,
          model,
          messages: toOaiMessages(params.system, params.messages, supportsImages, options.providerId),
          tools: toOaiTools(params.tools),
          max_tokens: params.maxTokens,
          stream: true,
          // Include usage in the streamed response
          stream_options: { include_usage: true },
          ...restProviderOptions,
        };

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(options.extraHeaders ?? {}),
    };
    if (options.apiKey !== undefined) {
      headers["Authorization"] = `Bearer ${options.apiKey}`;
    }

    const doFetch = options.useFetchRetry ? fetchWithRetry : fetch;
    const response = await doFetch(
      `${options.baseUrl}/${endpoint}`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        ...(params.signal && { signal: params.signal }),
      },
      ...(options.useFetchRetry ? [params.signal] : []),
    );

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      let detail = text.slice(0, 500);
      if (!detail.trim()) {
        // Some gateways reject image content with a bare status code and no
        // body. Give the user a hint instead of an empty error message.
        const hadImages = apiStyle === "responses"
          ? (body as { input: OaiResponseInputItem[] }).input.some(
              (item) => "content" in item
                && Array.isArray(item.content)
                && item.content.some((p) => p.type === "input_image"),
            )
          : (body as { messages: OaiMessage[] }).messages.some(
              (m) => Array.isArray(m.content) && m.content.some((p) => p.type === "image_url"),
            );
        if (hadImages) {
          detail = `The request included image content, but this model does not accept images through ${options.displayName}. Use a vision-capable model or send the prompt without an image.`;
        }
      }
      throw new Error(`${options.displayName} request failed (${response.status}): ${detail}`);
    }

    if (!response.body) {
      throw new Error(`${options.displayName} response has no body`);
    }

    if (apiStyle === "responses") {
      return new OpenAiCompatibleResponsesStream(response.body.getReader(), options.providerId);
    }

    return new OpenAiCompatibleChatStream(response.body.getReader(), options.providerId);
  }
}

// ── Stream adapters ─────────────────────────────────────────────────────────

/**
 * Accumulator state for a single tool call being streamed.
 */
type PendingToolCall = {
  id: string;
  streamId: string;
  name: string;
  arguments: string;
};

abstract class BaseOpenAiCompatibleStream implements ProviderStream {
  protected readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  protected readonly providerId: string;

  // Accumulated state built up during iteration, consumed by finalMessage().
  protected finishReason: string | null = null;
  protected fullReasoningContent = "";
  protected fullTextContent = "";
  protected completedToolCalls: PendingToolCall[] = [];
  protected usage: UsageInfo = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
  protected iterationDone = false;

  constructor(reader: ReadableStreamDefaultReader<Uint8Array>, providerId: string) {
    this.reader = reader;
    this.providerId = providerId;
  }

  abstract [Symbol.asyncIterator](): AsyncIterator<StreamEvent>;

  protected computeStopReason(): "end_turn" | "tool_use" {
    return this.finishReason === "tool_calls" ? "tool_use" : "end_turn";
  }

  async finalMessage(): Promise<ProviderResponse> {
    // If the caller didn't fully consume the iterator, drain it.
    if (!this.iterationDone) {
      const iter = this[Symbol.asyncIterator]();
      while (!(await iter.next()).done) {
        // drain
      }
    }

    const content: ContentBlock[] = [];

    if (this.fullTextContent) {
      content.push({ type: "text", text: this.fullTextContent });
    }

    for (const tc of this.completedToolCalls) {
      let input: unknown;
      try {
        input = JSON.parse(tc.arguments);
      } catch {
        input = tc.arguments;
      }
      content.push({
        type: "tool_use",
        id: tc.streamId,
        name: tc.name,
        input,
      });
    }

    const stopReason = this.computeStopReason();

    const metadata = this.fullReasoningContent
      ? { provider: this.providerId, reasoningContent: this.fullReasoningContent }
      : undefined;

    return {
      content,
      stopReason,
      usage: this.usage,
      ...(metadata && { providerMetadata: metadata }),
    };
  }
}

class OpenAiCompatibleChatStream extends BaseOpenAiCompatibleStream {
  private pendingToolCalls = new Map<number, PendingToolCall>();

  async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    // Track which tool call stream IDs have already emitted a "tool_use_start".
    const startedTools = new Set<string>();
    // Track any open assistant text/reasoning block so transitions are explicit.
    let openBlock: "text" | "reasoning" | undefined;

    for await (const line of parseSseLines(this.reader)) {
      let chunk: OaiStreamChunk;
      try {
        chunk = JSON.parse(line) as OaiStreamChunk;
      } catch {
        continue;
      }

      // Capture usage if present (usually on the last chunk)
      if (chunk.usage) {
        this.usage = {
          inputTokens: chunk.usage.prompt_tokens ?? 0,
          outputTokens: chunk.usage.completion_tokens ?? 0,
          cacheReadTokens: chunk.usage.prompt_tokens_details?.cached_tokens ?? 0,
          cacheCreationTokens: 0,
        };
      }

      const choice = chunk.choices?.[0];
      if (!choice) continue;

      if (choice.finish_reason) {
        this.finishReason = choice.finish_reason;
      }

      const delta = choice.delta;

      // ── Reasoning content (thinking) ──
      // Some models emit thinking content in `reasoning_content` rather than
      // `content`. Surface it with dedicated events so the UI can make clear
      // that it is reasoning, not final answer text.
      if (delta.reasoning_content != null && delta.reasoning_content !== "") {
        if (openBlock === "text") {
          yield { type: "block_stop" };
          openBlock = undefined;
        }

        if (openBlock !== "reasoning") {
          openBlock = "reasoning";
          yield { type: "reasoning_start", text: delta.reasoning_content };
        } else {
          yield { type: "reasoning_delta", text: delta.reasoning_content };
        }
        this.fullReasoningContent += delta.reasoning_content;
      }

      // ── Text content ──
      if (delta.content != null && delta.content !== "") {
        if (openBlock === "reasoning") {
          yield { type: "block_stop" };
          openBlock = undefined;
        }

        if (openBlock !== "text") {
          openBlock = "text";
          yield { type: "text_start", text: delta.content };
        } else {
          yield { type: "text_delta", text: delta.content };
        }
        this.fullTextContent += delta.content;
      }

      // ── Tool calls ──
      if (delta.tool_calls) {
        // If we were in an assistant text/reasoning block, close it before starting tool calls.
        if (openBlock) {
          openBlock = undefined;
          yield { type: "block_stop" };
        }

        for (const tc of delta.tool_calls) {
          const idx = tc.index;
          let pending = this.pendingToolCalls.get(idx);

          if (!pending) {
            pending = {
              id: tc.id ?? "",
              streamId: tc.id ?? `tool_call_${idx}`,
              name: tc.function?.name ?? "",
              arguments: "",
            };
            this.pendingToolCalls.set(idx, pending);
          }

          // Update fields if present. Keep streamId stable because it may
          // already be used by the TUI and final tool result IDs.
          if (tc.id) pending.id = tc.id;
          if (tc.function?.name) pending.name = tc.function.name;
          if (tc.function?.arguments) pending.arguments += tc.function.arguments;

          if (!startedTools.has(pending.streamId) && pending.name) {
            startedTools.add(pending.streamId);
            yield { type: "tool_use_start", id: pending.streamId, name: pending.name };
          }

          if (tc.function?.arguments) {
            yield { type: "tool_input_delta", id: pending.streamId, partialJson: tc.function.arguments };
          }
        }
      }
    }

    // Close any open assistant text/reasoning block.
    if (openBlock) {
      yield { type: "block_stop" };
    }

    // Close any open tool call blocks
    for (const id of startedTools) {
      yield { type: "block_stop", id };
    }

    // Move pending tool calls to completed
    for (const [, tc] of this.pendingToolCalls) {
      this.completedToolCalls.push(tc);
    }

    this.iterationDone = true;
  }
}

/**
 * Stream adapter for OpenAI-style `/responses` endpoints, used by models
 * served through that route (e.g. Grok 4.x, GPT 5.x on some gateways).
 */
class OpenAiCompatibleResponsesStream extends BaseOpenAiCompatibleStream {
  private pendingToolCalls = new Map<string, PendingToolCall>();
  private failure: Error | null = null;

  protected override computeStopReason(): "end_turn" | "tool_use" {
    return this.finishReason === "tool_calls" || this.completedToolCalls.length > 0
      ? "tool_use"
      : "end_turn";
  }

  async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    const startedTools = new Set<string>();
    let openBlock: "text" | "reasoning" | undefined;

    for await (const line of parseSseLines(this.reader)) {
      let event: OaiResponseStreamEvent;
      try {
        event = JSON.parse(line) as OaiResponseStreamEvent;
      } catch {
        continue;
      }

      // ── Failure ──
      if (event.type === "response.failed") {
        const message = event.response?.error?.message;
        this.failure = new Error(`Response failed: ${message ?? "unknown error"}`);
        break;
      }

      // ── Usage and completion ──
      if (event.type === "response.completed" && event.response) {
        const usage = event.response.usage;
        if (usage) {
          this.usage = {
            inputTokens: usage.input_tokens ?? 0,
            outputTokens: usage.output_tokens ?? 0,
            cacheReadTokens: usage.input_tokens_details?.cached_tokens ?? 0,
            cacheCreationTokens: 0,
          };
        }
        this.finishReason = event.response.status === "completed" ? "stop" : event.response.status ?? "stop";
        continue;
      }

      // ── Tool call start ──
      if (event.type === "response.output_item.added" && event.item?.type === "function_call") {
        const itemId = event.item.id;
        const callId = event.item.call_id ?? itemId;
        const pending = {
          id: callId,
          streamId: callId,
          name: event.item.name ?? "",
          arguments: event.item.arguments ?? "",
        };
        this.pendingToolCalls.set(itemId, pending);

        if (openBlock) {
          openBlock = undefined;
          yield { type: "block_stop" };
        }

        if (pending.name && !startedTools.has(pending.streamId)) {
          startedTools.add(pending.streamId);
          yield { type: "tool_use_start", id: pending.streamId, name: pending.name };
        }
        continue;
      }

      // ── Tool call arguments ──
      if (event.type === "response.function_call_arguments.delta" && event.item_id) {
        const pending = this.pendingToolCalls.get(event.item_id);
        if (pending && event.delta) {
          pending.arguments += event.delta;
          yield { type: "tool_input_delta", id: pending.streamId, partialJson: event.delta };
        }
        continue;
      }

      // ── Reasoning content ──
      const reasoningDelta =
        event.type === "response.reasoning_text.delta"
        || event.type === "response.reasoning_summary_text.delta"
          ? event.delta
          : undefined;
      if (reasoningDelta != null && reasoningDelta !== "") {
        if (openBlock === "text") {
          yield { type: "block_stop" };
          openBlock = undefined;
        }

        if (openBlock !== "reasoning") {
          openBlock = "reasoning";
          yield { type: "reasoning_start", text: reasoningDelta };
        } else {
          yield { type: "reasoning_delta", text: reasoningDelta };
        }
        this.fullReasoningContent += reasoningDelta;
        continue;
      }

      // ── Text content ──
      if (event.type === "response.output_text.delta" && event.delta != null && event.delta !== "") {
        if (openBlock === "reasoning") {
          yield { type: "block_stop" };
          openBlock = undefined;
        }

        if (openBlock !== "text") {
          openBlock = "text";
          yield { type: "text_start", text: event.delta };
        } else {
          yield { type: "text_delta", text: event.delta };
        }
        this.fullTextContent += event.delta;
      }
    }

    if (openBlock) {
      yield { type: "block_stop" };
    }

    for (const id of startedTools) {
      yield { type: "block_stop", id };
    }

    for (const [, tc] of this.pendingToolCalls) {
      this.completedToolCalls.push(tc);
    }

    this.iterationDone = true;
  }

  override async finalMessage(): Promise<ProviderResponse> {
    if (this.failure) {
      this.iterationDone = true;
      throw this.failure;
    }
    return super.finalMessage();
  }
}
