/**
 * Anthropic provider — wraps the @anthropic-ai/sdk to implement the
 * Provider interface.
 */

import Anthropic, { type AnthropicError } from "@anthropic-ai/sdk";
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
import { emitEvent } from "../events";
import { delay } from "../fetch-retry";

const MAX_REQUEST_BODY_BYTES = 10 * 1024 * 1024;

const STREAM_MAX_RETRIES = 3;
const STREAM_RETRY_BASE_DELAY_MS = 1000;
const STREAM_RETRY_MAX_DELAY_MS = 8000;

/**
 * Errors where a fresh request can succeed: dropped connections, mid-stream
 * SSE error events (e.g. overloaded_error, which carry no HTTP status), and
 * rate-limit/server errors that outlasted the SDK's own connect-time retries.
 * Client errors (400/401/403/404) and user aborts are not retried.
 */
function isRetryableStreamError(error: unknown): boolean {
  if (error instanceof Anthropic.APIUserAbortError) return false;
  if (error instanceof Anthropic.APIConnectionError) return true;
  if (error instanceof Anthropic.APIError) {
    if (error.status === undefined) return true; // mid-stream SSE error event
    return error.status === 429 || error.status >= 500;
  }
  // Generic SDK errors, e.g. "request ended without sending any chunks".
  if (error instanceof Anthropic.AnthropicError) return true;
  return false;
}

function streamRetryReason(error: unknown): string {
  if (error instanceof Anthropic.APIError) {
    if (error.type) return String(error.type);
    if (error.status) return `HTTP ${error.status}`;
  }
  if (error instanceof Error && error.message) {
    return error.message.length > 80 ? `${error.message.slice(0, 80)}…` : error.message;
  }
  return "unknown error";
}

// ── Provider metadata ────────────────────────────────────────────────────────

/**
 * Shape of the `providerMetadata` stored on AssistantMessages originating from
 * this provider. Captures raw Anthropic content blocks so thinking blocks (and
 * their signatures) can be replayed verbatim on subsequent turns, which is
 * required for extended-thinking continuity around tool use.
 */
type AnthropicMetadata = {
  provider: "anthropic";
  contentBlocks: Anthropic.ContentBlock[];
};

function isAnthropicMetadata(v: unknown): v is AnthropicMetadata {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as Record<string, unknown>).provider === "anthropic" &&
    Array.isArray((v as Record<string, unknown>).contentBlocks)
  );
}

function toAnthropicContentBlockParam(block: Anthropic.ContentBlock): Anthropic.ContentBlockParam | undefined {
  if (block.type === "text") {
    return { type: "text", text: block.text };
  }
  if (block.type === "thinking") {
    return { type: "thinking", thinking: block.thinking, signature: block.signature };
  }
  if (block.type === "redacted_thinking") {
    return { type: "redacted_thinking", data: block.data };
  }
  if (block.type === "tool_use") {
    return {
      type: "tool_use",
      id: block.id,
      name: block.name,
      input: block.input as Record<string, unknown>,
    };
  }
  return undefined;
}

// ── Message translation ─────────────────────────────────────────────────────

function toAnthropicMessages(messages: ProviderMessage[]): Anthropic.MessageParam[] {
  return messages.map((msg): Anthropic.MessageParam => {
    if (msg.role === "user") {
      const content: Anthropic.ContentBlockParam[] = msg.content.map((block) => {
        if (block.type === "text") {
          return { type: "text" as const, text: block.text };
        }
        if (block.type === "image") {
          return {
            type: "image" as const,
            source: {
              type: "base64" as const,
              media_type: block.mediaType,
              data: block.data,
            },
          };
        }
        // tool_result
        return {
          type: "tool_result" as const,
          tool_use_id: block.tool_use_id,
          content: block.content.map((p) =>
            p.type === "image"
              ? { type: "image" as const, source: { type: "base64" as const, media_type: p.mediaType, data: p.data } }
              : { type: "text" as const, text: p.text }
          ),
          ...(block.is_error && { is_error: true }),
        };
      });
      return { role: "user", content };
    }

    // assistant — prefer raw Anthropic content if available so thinking blocks
    // and signatures are preserved across tool-calling turns.
    if (isAnthropicMetadata(msg.providerMetadata)) {
      const content = msg.providerMetadata.contentBlocks
        .map(toAnthropicContentBlockParam)
        .filter((block): block is Anthropic.ContentBlockParam => block !== undefined);
      return { role: "assistant", content };
    }

    const content: Anthropic.ContentBlockParam[] = msg.content.map((block) => {
      if (block.type === "text") {
        return { type: "text" as const, text: block.text };
      }
      // tool_use
      return {
        type: "tool_use" as const,
        id: block.id,
        name: block.name,
        input: block.input as Record<string, unknown>,
      };
    });
    return { role: "assistant", content };
  });
}

function toAnthropicTools(tools: ToolDefinition[]): Anthropic.Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as Anthropic.Tool["input_schema"],
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function anthropicThinkingOption(options: Record<string, unknown> | undefined): Anthropic.ThinkingConfigParam | undefined {
  const thinking = options?.thinking;
  if (isRecord(thinking)) {
    return thinking as unknown as Anthropic.ThinkingConfigParam;
  }
  return undefined;
}

function anthropicOutputConfigOption(options: Record<string, unknown> | undefined): Anthropic.OutputConfig | undefined {
  const outputConfig = options?.output_config;
  if (isRecord(outputConfig)) {
    return outputConfig as unknown as Anthropic.OutputConfig;
  }
  return undefined;
}

function fromAnthropicContent(blocks: Anthropic.ContentBlock[]): ContentBlock[] {
  const result: ContentBlock[] = [];
  for (const block of blocks) {
    if (block.type === "text") {
      result.push({ type: "text", text: block.text });
    } else if (block.type === "tool_use") {
      result.push({ type: "tool_use", id: block.id, name: block.name, input: block.input });
    }
    // ignore other block types
  }
  return result;
}

// ── Provider implementation ─────────────────────────────────────────────────

export class AnthropicProvider implements Provider {
  private client: Anthropic;

  constructor(options?: { apiKey?: string; baseURL?: string }) {
    this.client = new Anthropic(options);
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
    const systemPrompt: Anthropic.TextBlockParam[] = [
      {
        type: "text" as const,
        text: params.system,
        cache_control: { type: "ephemeral" as const },
      },
    ];
    const thinking = anthropicThinkingOption(params.providerOptions);
    const outputConfig = anthropicOutputConfigOption(params.providerOptions);

    const requestBody: Anthropic.MessageCreateParams = {
      model: params.model,
      max_tokens: params.maxTokens,
      system: systemPrompt,
      messages: toAnthropicMessages(params.messages),
      tools: toAnthropicTools(params.tools),
      cache_control: { type: "ephemeral" },
      ...(thinking && { thinking }),
      ...(outputConfig && { output_config: outputConfig }),
    };

    const requestBodyBytes = Buffer.byteLength(JSON.stringify(requestBody), "utf8");
    if (requestBodyBytes > MAX_REQUEST_BODY_BYTES) {
      throw new Error(
        `Anthropic request body is too large (${(requestBodyBytes / (1024 * 1024)).toFixed(1)} MB; limit ${(MAX_REQUEST_BODY_BYTES / (1024 * 1024)).toFixed(0)} MB). ` +
        "This is usually caused by large images in the conversation history. Start /new, /undo recent image reads, or use fewer/smaller images.",
      );
    }

    return new AnthropicStream(
      () => this.client.messages.stream(requestBody, { signal: params.signal }),
      params.signal,
    );
  }
}

// ── Stream adapter ──────────────────────────────────────────────────────────

class AnthropicStream implements ProviderStream {
  private innerStream: ReturnType<Anthropic["messages"]["stream"]>;
  private currentBlock: { type: "text" | "thinking" | "tool_use"; toolUseId?: string } | undefined;
  private readonly createStream: () => ReturnType<Anthropic["messages"]["stream"]>;
  private readonly signal?: AbortSignal;
  private sawMessageStop = false;
  private streamError: unknown;
  private iterationDone = false;

  constructor(
    createStream: () => ReturnType<Anthropic["messages"]["stream"]>,
    signal?: AbortSignal,
  ) {
    this.createStream = createStream;
    this.signal = signal;
    this.innerStream = this.track(createStream());
  }

  /**
   * The SDK reports mid-stream failures via an 'error' event instead of
   * throwing from its async iterator, and the event is missed when the
   * consumer is not awaiting next() at that moment. Capture it so no failure
   * is mistaken for a clean end of stream.
   */
  private track(stream: ReturnType<Anthropic["messages"]["stream"]>) {
    stream.on("error", (error: AnthropicError) => {
      this.streamError = error;
    });
    return stream;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    let attempt = 0;
    while (true) {
      this.currentBlock = undefined;
      this.sawMessageStop = false;
      this.streamError = undefined;

      let failure: unknown;
      try {
        for await (const event of this.innerStream) {
          const mapped = this.mapEvent(event);
          if (mapped) yield mapped;
        }
      } catch (error) {
        failure = error;
      }

      if (failure === undefined && this.sawMessageStop) {
        this.iterationDone = true;
        return;
      }

      // A stream that ends before message_stop produces no error from the
      // SDK, but finalMessage() would then fail with "stream ended without
      // producing a Message with role=assistant". Surface a clearer error.
      failure ??= this.streamError
        ?? new Anthropic.AnthropicError(
          "The response stream ended prematurely (connection dropped before the message completed)",
        );

      // Translate SDK aborts into a DOMException AbortError so the caller's
      // isAbortError() check takes the cancel path (same as openai.ts).
      if (this.signal?.aborted || failure instanceof Anthropic.APIUserAbortError) {
        throw new DOMException("Aborted", "AbortError");
      }

      if (!isRetryableStreamError(failure) || attempt >= STREAM_MAX_RETRIES) {
        throw failure;
      }

      // Retrying is safe: the caller only persists assistant content and
      // executes tool calls after finalMessage() succeeds.
      const waitMs =
        Math.min(STREAM_RETRY_MAX_DELAY_MS, STREAM_RETRY_BASE_DELAY_MS * 2 ** attempt) +
        Math.random() * 500;
      emitEvent("stream-retry", {
        attempt: attempt + 1,
        maxRetries: STREAM_MAX_RETRIES,
        waitMs,
        reason: streamRetryReason(failure),
      });
      await delay(waitMs, this.signal);
      attempt++;
      this.innerStream = this.track(this.createStream());
    }
  }

  private mapEvent(event: Anthropic.MessageStreamEvent): StreamEvent | null {
    switch (event.type) {
      case "content_block_start": {
        const block = event.content_block;
        if (block.type === "text") {
          this.currentBlock = { type: "text" };
          return { type: "text_start", text: block.text ?? "" };
        }
        if (block.type === "thinking") {
          this.currentBlock = { type: "thinking" };
          return { type: "reasoning_start", text: block.thinking ?? "" };
        }
        if (block.type === "tool_use") {
          this.currentBlock = { type: "tool_use", toolUseId: block.id };
          return { type: "tool_use_start", id: block.id, name: block.name };
        }
        return null;
      }

      case "content_block_delta": {
        const delta = event.delta;
        if (delta.type === "text_delta") {
          return { type: "text_delta", text: delta.text };
        }
        if (delta.type === "thinking_delta") {
          return { type: "reasoning_delta", text: delta.thinking };
        }
        if (delta.type === "input_json_delta") {
          if (this.currentBlock?.type !== "tool_use" || !this.currentBlock.toolUseId) return null;
          return { type: "tool_input_delta", id: this.currentBlock.toolUseId, partialJson: delta.partial_json };
        }
        return null;
      }

      case "content_block_stop": {
        const currentBlock = this.currentBlock;
        this.currentBlock = undefined;
        return currentBlock?.type === "tool_use" && currentBlock.toolUseId
          ? { type: "block_stop", id: currentBlock.toolUseId }
          : { type: "block_stop" };
      }

      case "message_stop": {
        this.sawMessageStop = true;
        return null;
      }

      default:
        return null;
    }
  }

  async finalMessage(): Promise<ProviderResponse> {
    // If the caller didn't fully consume the iterator, drain it. This also
    // runs the retry loop for prematurely ended streams.
    if (!this.iterationDone) {
      const iter = this[Symbol.asyncIterator]();
      while (!(await iter.next()).done) {
        // drain
      }
    }

    const response = await this.innerStream.finalMessage();

    const cacheReadTokens = response.usage.cache_read_input_tokens ?? 0;
    const cacheCreationTokens = response.usage.cache_creation_input_tokens ?? 0;

    const usage: UsageInfo = {
      inputTokens: response.usage.input_tokens + cacheCreationTokens + cacheReadTokens,
      outputTokens: response.usage.output_tokens,
      cacheReadTokens,
      cacheCreationTokens,
    };

    const stopReason: "end_turn" | "tool_use" =
      response.stop_reason === "tool_use" ? "tool_use" : "end_turn";

    const metadata: AnthropicMetadata = {
      provider: "anthropic",
      contentBlocks: response.content,
    };

    return {
      content: fromAnthropicContent(response.content),
      stopReason,
      usage,
      providerMetadata: metadata,
    };
  }
}
