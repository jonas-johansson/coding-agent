/**
 * Anthropic provider — wraps the @anthropic-ai/sdk to implement the
 * Provider interface.
 */

import Anthropic from "@anthropic-ai/sdk";
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

const MAX_REQUEST_BODY_BYTES = 10 * 1024 * 1024;

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

    const anthropicStream = await this.client.messages.stream(
      requestBody,
      { signal: params.signal },
    );

    return new AnthropicStream(anthropicStream);
  }
}

// ── Stream adapter ──────────────────────────────────────────────────────────

class AnthropicStream implements ProviderStream {
  private innerStream: ReturnType<Anthropic["messages"]["stream"]>;
  private currentBlock: { type: "text" | "thinking" | "tool_use"; toolUseId?: string } | undefined;

  constructor(inner: ReturnType<Anthropic["messages"]["stream"]>) {
    this.innerStream = inner;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    for await (const event of this.innerStream) {
      const mapped = this.mapEvent(event);
      if (mapped) yield mapped;
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

      default:
        return null;
    }
  }

  async finalMessage(): Promise<ProviderResponse> {
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
