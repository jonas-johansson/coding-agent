/**
 * LM Studio provider — OpenAI-compatible Chat Completions API.
 *
 * Uses raw fetch() + SSE parsing to stream responses from a local
 * LM Studio server (default: http://localhost:1234/v1/chat/completions).
 */

import { OpenAiCompatibleProvider } from "./openai-compatible";

const DEFAULT_BASE_URL = "http://localhost:1234/v1";

export class LmStudioProvider extends OpenAiCompatibleProvider {
  constructor() {
    super({
      providerId: "lmstudio",
      displayName: "LM Studio",
      apiKey: process.env.LMSTUDIO_API_KEY,
      baseUrl: process.env.LMSTUDIO_BASE_URL ?? DEFAULT_BASE_URL,
      mapModel: (model) => process.env.LMSTUDIO_MODEL ?? model,
    });
  }
}
