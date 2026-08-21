/**
 * OpenCode Zen provider — OpenAI-compatible Chat Completions API.
 *
 * Uses raw fetch() + SSE parsing to stream responses from
 * https://opencode.ai/zen/v1/chat/completions
 */

import { OpenAiCompatibleProvider } from "./openai-compatible";

const DEFAULT_BASE_URL = "https://opencode.ai/zen/v1";

export class OpenCodeZenProvider extends OpenAiCompatibleProvider {
  constructor(options?: { apiKey?: string; baseUrl?: string }) {
    const key = options?.apiKey
      ?? process.env.OPENCODE_ZEN_API_KEY
      ?? process.env.OPENCODE_API_KEY;
    super({
      providerId: "opencode-zen",
      displayName: "OpenCode Zen",
      apiKey: key,
      missingKeyMessage:
        "Missing API key for OpenCode Zen. Set the OPENCODE_ZEN_API_KEY or OPENCODE_API_KEY environment variable.",
      baseUrl: options?.baseUrl ?? process.env.OPENCODE_ZEN_BASE_URL ?? DEFAULT_BASE_URL,
    });
  }
}
