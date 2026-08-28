/**
 * Friendli AI provider — OpenAI-compatible Chat Completions API.
 *
 * Uses raw fetch() + SSE parsing to stream responses from
 * https://api.friendli.ai/serverless/v1/chat/completions
 */

import { OpenAiCompatibleProvider } from "./openai-compatible";

const DEFAULT_BASE_URL = "https://api.friendli.ai/serverless/v1";

/**
 * Maps curated provider model ID aliases to the Friendli API model
 * identifiers (org-qualified repo names). Unknown ids pass through as-is.
 */
const FRIENDLI_MODEL_MAP: Record<string, string> = {
  "glm-5.3-flash": "zai-org/GLM-5.3-Flash",
};

export class FriendliProvider extends OpenAiCompatibleProvider {
  constructor() {
    super({
      providerId: "friendli",
      displayName: "Friendli AI",
      apiKey: process.env.FRIENDLI_API_KEY,
      missingKeyMessage:
        "Missing API key for Friendli AI. Set the FRIENDLI_API_KEY environment variable.",
      baseUrl: process.env.FRIENDLI_BASE_URL ?? DEFAULT_BASE_URL,
      mapModel: (model) => FRIENDLI_MODEL_MAP[model] ?? model,
      // Friendli separates reasoning from answer text into
      // `reasoning_content` when parsing is enabled.
      defaultBody: {
        parse_reasoning: true,
        include_reasoning: true,
      },
      useFetchRetry: true,
    });
  }
}
