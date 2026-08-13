/**
 * OpenCode Zen provider — OpenAI-compatible Chat Completions API.
 *
 * Uses raw fetch() + SSE parsing to stream responses from
 * https://opencode.ai/zen/v1/chat/completions
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

const DEFAULT_BASE_URL = "https://opencode.ai/zen/v1";

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

// ── Provider metadata ────────────────────────────────────────────────────────

/**
 * Shape of the `providerMetadata` stored on AssistantMessages originating
 * from this provider. Captures `reasoning_content` so it can be replayed on
 * subsequent turns — the model needs its prior reasoning for continuity.
 */
type OpenCodeZenMetadata = {
  provider: "opencode-zen";
  reasoningContent?: string;
};

function isOpenCodeZenMetadata(v: unknown): v is OpenCodeZenMetadata {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as Record<string, unknown>).provider === "opencode-zen"
  );
}

// ── Message translation ─────────────────────────────────────────────────────

function toOaiMessages(
  system: string,
  messages: ProviderMessage[],
  supportsImages: boolean,
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
      const meta = msg.providerMetadata;
      const reasoning = isOpenCodeZenMetadata(meta) ? meta.reasoningContent : undefined;

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

export class OpenCodeZenProvider implements Provider {
  private apiKey: string;
  private baseUrl: string;

  constructor(options?: { apiKey?: string; baseUrl?: string }) {
    const key = options?.apiKey ?? process.env.OPENCODE_ZEN_API_KEY ?? process.env.OPENCODE_API_KEY;
    if (!key) {
      throw new Error(
        "Missing API key for OpenCode Zen. Set the OPENCODE_ZEN_API_KEY or OPENCODE_API_KEY environment variable.",
      );
    }
    this.apiKey = key;
    this.baseUrl = options?.baseUrl ?? process.env.OPENCODE_ZEN_BASE_URL ?? DEFAULT_BASE_URL;
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
    // supportsImages is a provider-native formatting hint, not an API parameter.
    const providerOptions = params.providerOptions ?? {};
    const { supportsImages: supportsImagesOption, ...restProviderOptions } = providerOptions;
    const supportsImages = (supportsImagesOption as boolean | undefined) ?? true;

    const body = {
      model: params.model,
      messages: toOaiMessages(params.system, params.messages, supportsImages),
      tools: toOaiTools(params.tools),
      max_tokens: params.maxTokens,
      stream: true,
      // Include usage in the streamed response
      stream_options: { include_usage: true },
      ...restProviderOptions,
    };

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: params.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      let detail = text.slice(0, 500);
      if (!detail.trim()) {
        // Some gateways reject image content with a bare status code and no
        // body. Give the user a hint instead of an empty error message.
        const hadImages = body.messages.some(
          (m) => Array.isArray(m.content) && m.content.some((p) => p.type === "image_url"),
        );
        if (hadImages) {
          detail = "The request included image content, but this model does not accept images through OpenCode Zen. Use a vision-capable model or send the prompt without an image.";
        }
      }
      throw new Error(`OpenCode Zen request failed (${response.status}): ${detail}`);
    }

    if (!response.body) {
      throw new Error("OpenCode Zen response has no body");
    }

    return new OpenCodeZenStream(response.body.getReader());
  }
}

// ── Stream adapter ──────────────────────────────────────────────────────────

/**
 * Accumulator state for a single tool call being streamed.
 */
type PendingToolCall = {
  id: string;
  streamId: string;
  name: string;
  arguments: string;
};

class OpenCodeZenStream implements ProviderStream {
  private reader: ReadableStreamDefaultReader<Uint8Array>;

  // Accumulated state built up during iteration, consumed by finalMessage().
  private finishReason: string | null = null;
  private fullReasoningContent = "";
  private fullTextContent = "";
  private completedToolCalls: PendingToolCall[] = [];
  private pendingToolCalls = new Map<number, PendingToolCall>();
  private usage: UsageInfo = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
  private iterationDone = false;

  constructor(reader: ReadableStreamDefaultReader<Uint8Array>) {
    this.reader = reader;
  }

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
      // Kimi K2 emits thinking content in `reasoning_content` rather than
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

    const stopReason: "end_turn" | "tool_use" =
      this.finishReason === "tool_calls" ? "tool_use" : "end_turn";

    const metadata: OpenCodeZenMetadata | undefined = this.fullReasoningContent
      ? { provider: "opencode-zen", reasoningContent: this.fullReasoningContent }
      : undefined;

    return {
      content,
      stopReason,
      usage: this.usage,
      ...(metadata && { providerMetadata: metadata }),
    };
  }
}
