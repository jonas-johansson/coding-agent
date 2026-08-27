/**
 * Provider registry and routing.
 *
 * Maps a model's provider/providerModel pair onto a concrete Provider
 * instance. Providers are instantiated lazily (and their SDK modules loaded
 * via dynamic import) so startup cost stays low.
 */

import type { ModelConfig } from "./models";
import type { Provider } from "./provider";

// ── Provider instances (lazily created) ──────────────────────────────────────

let anthropicProvider: Provider | undefined;
let openCodeZenProvider: Provider | undefined;
let openCodeGoProvider: Provider | undefined;
let openCodeZenAnthropicProvider: Provider | undefined;
let openCodeZenOpenAIProvider: Provider | undefined;
let openAIProvider: Provider | undefined;
let fireworksProvider: Provider | undefined;
let lmStudioProvider: Provider | undefined;

async function getOpenCodeGoProvider(): Promise<Provider> {
  if (!openCodeGoProvider) {
    const apiKey = process.env.OPENCODE_GO_API_KEY ?? process.env.OPENCODE_ZEN_API_KEY ?? process.env.OPENCODE_API_KEY;
    if (!apiKey) {
      throw new Error(
        "Missing API key for OpenCode Go. Set the OPENCODE_GO_API_KEY, OPENCODE_ZEN_API_KEY, or OPENCODE_API_KEY environment variable.",
      );
    }
    const { OpenCodeZenProvider } = await import("./providers/opencode-zen");
    openCodeGoProvider = new OpenCodeZenProvider({
      apiKey,
      baseUrl: process.env.OPENCODE_GO_BASE_URL ?? "https://opencode.ai/zen/go/v1",
    });
  }
  return openCodeGoProvider;
}

export async function resolveProvider(config: ModelConfig): Promise<Provider> {
  switch (config.provider) {
    case "anthropic": {
      if (!anthropicProvider) {
        const { AnthropicProvider } = await import("./providers/anthropic");
        anthropicProvider = new AnthropicProvider();
      }
      return anthropicProvider;
    }
    case "opencode": {
      if (config.providerModel.startsWith("claude-")) {
        if (!openCodeZenAnthropicProvider) {
          const apiKey = process.env.OPENCODE_ZEN_API_KEY ?? process.env.OPENCODE_API_KEY;
          if (!apiKey) {
            throw new Error(
              "Missing API key for OpenCode Zen. Set the OPENCODE_ZEN_API_KEY or OPENCODE_API_KEY environment variable.",
            );
          }
          const { AnthropicProvider } = await import("./providers/anthropic");
          openCodeZenAnthropicProvider = new AnthropicProvider({
            apiKey,
            baseURL: process.env.OPENCODE_ZEN_ANTHROPIC_BASE_URL ?? "https://opencode.ai/zen",
          });
        }
        return openCodeZenAnthropicProvider;
      }
      if (config.providerModel.startsWith("gpt-")) {
        // GPT-5.x models on OpenCode Zen are served via the OpenAI Responses
        // API (not Chat Completions), which is required to surface reasoning.
        // Reuse the OpenAIProvider pointed at the Zen base URL.
        if (!openCodeZenOpenAIProvider) {
          const apiKey = process.env.OPENCODE_ZEN_API_KEY ?? process.env.OPENCODE_API_KEY;
          if (!apiKey) {
            throw new Error(
              "Missing API key for OpenCode Zen. Set the OPENCODE_ZEN_API_KEY or OPENCODE_API_KEY environment variable.",
            );
          }
          const { OpenAIProvider } = await import("./providers/openai");
          openCodeZenOpenAIProvider = new OpenAIProvider({
            apiKey,
            baseURL: process.env.OPENCODE_ZEN_BASE_URL ?? "https://opencode.ai/zen/v1",
          });
        }
        return openCodeZenOpenAIProvider;
      }
      if (
        config.providerModel.startsWith("deepseek-v4-") &&
        !config.providerModel.endsWith("-free") &&
        (process.env.OPENCODE_GO_API_KEY ?? process.env.OPENCODE_GO_BASE_URL)
      ) {
        // DeepSeek V4 paid models are served by the regular Zen Chat
        // Completions endpoint. The OpenCode Go endpoint hosts them in China
        // and requires explicit workspace opt-in, so it is only used when Go
        // is explicitly configured via OPENCODE_GO_API_KEY or
        // OPENCODE_GO_BASE_URL. Free variants always use the Zen endpoint.
        return getOpenCodeGoProvider();
      }
      if (config.providerModel === "kimi-k3") {
        // Kimi K3 is served by the OpenCode Go Chat Completions endpoint,
        // not the regular Zen endpoint.
        return getOpenCodeGoProvider();
      }
      if (config.providerModel.startsWith("glm-5.3")) {
        // GLM-5.3 models are served by the OpenCode Go Chat Completions
        // endpoint, not the regular Zen endpoint.
        return getOpenCodeGoProvider();
      }
      if (!openCodeZenProvider) {
        const { OpenCodeZenProvider } = await import("./providers/opencode-zen");
        openCodeZenProvider = new OpenCodeZenProvider();
      }
      return openCodeZenProvider;
    }
    case "openai": {
      if (!openAIProvider) {
        const { OpenAIProvider } = await import("./providers/openai");
        openAIProvider = new OpenAIProvider();
      }
      return openAIProvider;
    }
    case "fireworks": {
      if (!fireworksProvider) {
        const { FireworksProvider } = await import("./providers/fireworks");
        fireworksProvider = new FireworksProvider();
      }
      return fireworksProvider;
    }
    case "lmstudio": {
      if (!lmStudioProvider) {
        const { LmStudioProvider } = await import("./providers/lmstudio");
        lmStudioProvider = new LmStudioProvider();
      }
      return lmStudioProvider;
    }
  }
}
