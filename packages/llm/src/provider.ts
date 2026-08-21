/**
 * Provider-agnostic types and interface.
 */

// ── Content blocks ───────────────────────────────────────────────────────────

export type TextBlock = {
  type: "text";
  text: string;
};

export type ImageBlock = {
  type: "image";
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  data: string;
};

export type ToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
};

export type ToolResultPart = {
  type: "text";
  text: string;
} | ImageBlock;

export type ToolResultContent = {
  type: "tool_result";
  tool_use_id: string;
  content: ToolResultPart[];
  is_error?: boolean;
};

export type ContentBlock = TextBlock | ToolUseBlock;

// ── Messages ─────────────────────────────────────────────────────────────────

export type UserMessage = {
  role: "user";
  content: Array<TextBlock | ImageBlock | ToolResultContent>;
};

export type AssistantMessage = {
  role: "assistant";
  content: Array<TextBlock | ToolUseBlock>;
  /**
   * Provider-specific metadata needed to faithfully continue conversations.
   * Examples: Anthropic raw content blocks, OpenAI Responses output items,
   * OpenCode Zen reasoning_content.
   */
  providerMetadata?: unknown;
};

export type ProviderMessage = UserMessage | AssistantMessage;

// ── Streaming events ─────────────────────────────────────────────────────────

export type TextStartEvent = {
  type: "text_start";
  text: string;
};

export type TextDeltaEvent = {
  type: "text_delta";
  text: string;
};

export type ReasoningStartEvent = {
  type: "reasoning_start";
  text: string;
};

export type ReasoningDeltaEvent = {
  type: "reasoning_delta";
  text: string;
};

export type ToolUseStartEvent = {
  type: "tool_use_start";
  id: string;
  name: string;
};

export type ToolInputDeltaEvent = {
  type: "tool_input_delta";
  id: string;
  partialJson: string;
};

export type BlockStopEvent = {
  type: "block_stop";
  id?: string;
};

export type StreamEvent =
  | TextStartEvent
  | TextDeltaEvent
  | ReasoningStartEvent
  | ReasoningDeltaEvent
  | ToolUseStartEvent
  | ToolInputDeltaEvent
  | BlockStopEvent;

// ── Usage / response ─────────────────────────────────────────────────────────

export type UsageInfo = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
};

export type ProviderResponse = {
  content: ContentBlock[];
  stopReason: "end_turn" | "tool_use";
  usage: UsageInfo;
  providerMetadata?: unknown;
};

export type ProviderStream = {
  [Symbol.asyncIterator](): AsyncIterator<StreamEvent>;
  finalMessage(): Promise<ProviderResponse>;
};

// ── Tool definition (provider-agnostic) ──────────────────────────────────────

export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

// ── Provider interface ───────────────────────────────────────────────────────

export interface Provider {
  stream(params: {
    model: string;
    system: string;
    messages: ProviderMessage[];
    tools: ToolDefinition[];
    maxTokens: number;
    /** Provider-native options for the selected model variant. */
    providerOptions?: Record<string, unknown>;
    signal?: AbortSignal;
  }): Promise<ProviderStream>;
}
