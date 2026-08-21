/**
 * Fireworks AI provider — OpenAI-compatible Chat Completions API.
 *
 * Uses raw fetch() + SSE parsing to stream responses from
 * https://api.fireworks.ai/inference/v1/chat/completions
 */

import { OpenAiCompatibleProvider } from "./openai-compatible";

const DEFAULT_BASE_URL = "https://api.fireworks.ai/inference/v1";

/**
 * Maps curated provider model ID aliases to the Fireworks API model
 * identifiers. Fully-qualified Fireworks paths ("accounts/...") — e.g. models
 * surfaced by the dynamic model catalog — pass through without an entry here.
 */
const FIREWORKS_MODEL_MAP: Record<string, string> = {
  "kimi-k2.6": "accounts/fireworks/models/kimi-k2p6",
  "kimi-k2.7-code": "accounts/fireworks/models/kimi-k2p7-code",
};

export class FireworksProvider extends OpenAiCompatibleProvider {
  constructor() {
    super({
      providerId: "fireworks",
      displayName: "Fireworks AI",
      apiKey: process.env.FIREWORKS_API_KEY,
      missingKeyMessage:
        "Missing API key for Fireworks AI. Set the FIREWORKS_API_KEY environment variable.",
      baseUrl: process.env.FIREWORKS_BASE_URL ?? DEFAULT_BASE_URL,
      mapModel: (model) => {
        const mapped = FIREWORKS_MODEL_MAP[model]
          ?? (model.startsWith("accounts/") ? model : undefined);
        if (!mapped) {
          throw new Error(
            `Unknown Fireworks model mapping for "${model}". ` +
            `Add it to FIREWORKS_MODEL_MAP in providers/fireworks.ts.`,
          );
        }
        return mapped;
      },
      defaultBody: {
        temperature: 0.6,
        top_p: 1,
        top_k: 40,
        presence_penalty: 0,
        frequency_penalty: 0,
      },
      useFetchRetry: true,
      extraHeaders: { Accept: "application/json" },
    });
  }
}
