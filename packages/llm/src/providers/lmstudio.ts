/**
 * LM Studio provider — OpenAI-compatible Chat Completions API.
 *
 * Uses raw fetch() + SSE parsing to stream responses from a local
 * LM Studio server (default: http://localhost:1234/v1/chat/completions).
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

const DEFAULT_BASE_URL = "http://localhost:1234/v1";

type OaiContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: string } };

type OaiMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | OaiContentPart[] }
  | { role: "assistant"; content?: string | null; reasoning_content?: string | null; tool_calls?: OaiToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

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
 * subsequent turns — the model needs its prior chain-of-thought for continuity.
 */
type LmStudioMetadata = {
  provider: "lmstudio";
  reasoningContent?: string;
};

function isLmStudioMetadata(v: unknown): v is LmStudioMetadata {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as Record<string, unknown>).provider === "lmstudio"
  );
}

function toOaiMessages(system: string, messages: ProviderMessage[]): OaiMessage[] {
  const result: OaiMessage[] = [{ role: "system", content: system }];

  for (const msg of messages) {
    if (msg.role === "user") {
      const contentParts: OaiContentPart[] = [];
      const toolResults: { tool_call_id: string; content: string; is_error?: boolean }[] = [];
      let hasImages = false;

      for (const block of msg.content) {
        if (block.type === "text") {
          contentParts.push({ type: "text", text: block.text });
        } else if (block.type === "image") {
          hasImages = true;
          contentParts.push({
            type: "image_url",
            image_url: {
              url: `data:${block.mediaType};base64,${block.data}`,
              detail: "auto",
            },
          });
        } else {
          const text = block.content.filter((p) => p.type === "text").map((p) => p.text).join("\n");
          toolResults.push({
            tool_call_id: block.tool_use_id,
            content: block.is_error ? `Error: ${text}` : text,
          });
        }
      }

      if (contentParts.length > 0) {
        if (hasImages) {
          result.push({ role: "user", content: contentParts });
        } else {
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
      const textParts: string[] = [];
      const toolCalls: OaiToolCall[] = [];

      for (const block of msg.content) {
        if (block.type === "text") {
          textParts.push(block.text);
        } else {
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
      const reasoning = isLmStudioMetadata(meta) ? meta.reasoningContent : undefined;

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

async function* parseSseLines(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
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

  if (buffer.trim().startsWith("data: ")) {
    const payload = buffer.trim().slice(6);
    if (payload !== "[DONE]") yield payload;
  }
}

export class LmStudioProvider implements Provider {
  private apiKey: string | undefined;
  private baseUrl: string;

  constructor() {
    this.apiKey = process.env.LMSTUDIO_API_KEY;
    this.baseUrl = process.env.LMSTUDIO_BASE_URL ?? DEFAULT_BASE_URL;
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
    const modelId = process.env.LMSTUDIO_MODEL ?? params.model;

    const body = {
      model: modelId,
      messages: toOaiMessages(params.system, params.messages),
      tools: toOaiTools(params.tools),
      max_tokens: params.maxTokens,
      stream: true,
      stream_options: { include_usage: true },
    };

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: params.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`LM Studio request failed (${response.status}): ${text.slice(0, 500)}`);
    }

    if (!response.body) {
      throw new Error("LM Studio response has no body");
    }

    return new LmStudioStream(response.body.getReader());
  }
}

type PendingToolCall = {
  id: string;
  streamId: string;
  name: string;
  arguments: string;
};

class LmStudioStream implements ProviderStream {
  private reader: ReadableStreamDefaultReader<Uint8Array>;

  private finishReason: string | null = null;
  private fullTextContent = "";
  private fullReasoningContent = "";
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
      // Models like Gemma 4 emit thinking content in `reasoning_content`
      // rather than `content`. Surface it with dedicated events so the UI
      // can make clear that it is reasoning, not final answer text.
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

    for (const id of startedTools) {
      yield { type: "block_stop", id };
    }

    for (const [, tc] of this.pendingToolCalls) {
      this.completedToolCalls.push(tc);
    }

    this.iterationDone = true;
  }

  async finalMessage(): Promise<ProviderResponse> {
    if (!this.iterationDone) {
      const iter = this[Symbol.asyncIterator]();
      while (!(await iter.next()).done) {
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

    const metadata: LmStudioMetadata | undefined = this.fullReasoningContent
      ? { provider: "lmstudio", reasoningContent: this.fullReasoningContent }
      : undefined;

    return {
      content,
      stopReason,
      usage: this.usage,
      ...(metadata && { providerMetadata: metadata }),
    };
  }
}
