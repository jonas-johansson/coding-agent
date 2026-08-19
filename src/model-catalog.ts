/**
 * Dynamic model catalog loading from models.dev.
 *
 * The built-in catalog in models.ts remains the offline fallback and source of
 * truth for curated Pace variants. Remote metadata only adds models that Pace
 * does not already know about.
 */

import { createHash } from "crypto";
import { mkdir, readFile, stat, writeFile } from "fs/promises";
import { homedir } from "os";
import { dirname, join } from "path";
import { z } from "zod";
import {
  applyRemoteModelMetadata,
  type ModelMetadata,
  type ModelVariant,
  type PricingConfig,
  type ProviderId,
} from "./models";

const DEFAULT_MODELS_URL = "https://models.dev";
const CACHE_TTL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;
const REMOTE_PROVIDER_ID_MAP: Record<string, ProviderId> = {
  anthropic: "anthropic",
  opencode: "opencode",
  openai: "openai",
  "fireworks-ai": "fireworks",
  lmstudio: "lmstudio",
};

const costSchema = z.object({
  input: z.number(),
  output: z.number(),
  cache_read: z.number().optional(),
  cache_write: z.number().optional(),
  context_over_200k: z.object({
    input: z.number(),
    output: z.number(),
    cache_read: z.number().optional(),
    cache_write: z.number().optional(),
  }).optional(),
});

const reasoningOptionSchema = z.object({
  type: z.string(),
  values: z.array(z.unknown()).optional(),
}).passthrough();

const modelSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  family: z.string().optional(),
  release_date: z.string().optional(),
  attachment: z.boolean().optional(),
  reasoning: z.boolean().optional(),
  reasoning_options: z.array(reasoningOptionSchema).optional(),
  temperature: z.boolean().optional(),
  tool_call: z.boolean().optional(),
  cost: costSchema.optional(),
  limit: z.object({
    context: z.number(),
    input: z.number().optional(),
    output: z.number(),
  }),
  modalities: z.object({
    input: z.array(z.string()),
    output: z.array(z.string()),
  }).optional(),
  experimental: z.unknown().optional(),
  status: z.string().optional(),
  options: z.record(z.string(), z.unknown()).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  variants: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
}).passthrough();

const providerSchema = z.object({
  api: z.string().optional(),
  name: z.string(),
  env: z.array(z.string()).optional(),
  id: z.string(),
  npm: z.string().optional(),
  models: z.record(z.string(), modelSchema),
}).passthrough();

const catalogSchema = z.record(z.string(), providerSchema);

type ModelsDevCatalog = z.infer<typeof catalogSchema>;
type ModelsDevCost = z.infer<typeof costSchema>;
type ModelCatalogLoadResult = {
  addedModelIds: string[];
  totalModelCount: number;
};

function modelsSourceUrl(): string {
  return (process.env.PACE_MODELS_URL || DEFAULT_MODELS_URL).replace(/\/+$/, "");
}

function modelFetchDisabled(): boolean {
  const value = process.env.PACE_DISABLE_MODELS_FETCH;
  return value === "1" || value === "true" || value === "yes";
}

function cachePath(): string {
  if (process.env.PACE_MODELS_PATH) return process.env.PACE_MODELS_PATH;

  const source = modelsSourceUrl();
  const filename = source === DEFAULT_MODELS_URL
    ? "models.json"
    : `models-${createHash("sha256").update(source).digest("hex").slice(0, 16)}.json`;
  return join(homedir(), ".cache", "pace", filename);
}

function toPricing(cost: ModelsDevCost | undefined): PricingConfig {
  return {
    inputPerMTok: cost?.input ?? 0,
    cacheWritePerMTok: cost?.cache_write ?? 0,
    cacheReadPerMTok: cost?.cache_read ?? 0,
    outputPerMTok: cost?.output ?? 0,
  };
}

function hasImageInput(model: ModelsDevCatalog[string]["models"][string]): boolean {
  return model.attachment === true || model.modalities?.input.includes("image") === true;
}

function hasTextOutput(model: ModelsDevCatalog[string]["models"][string]): boolean {
  return model.modalities ? model.modalities.output.includes("text") : true;
}

function isTextGenerationModel(model: ModelsDevCatalog[string]["models"][string]): boolean {
  const searchable = [model.id, model.name, model.family].filter(Boolean).join(" ").toLowerCase();
  const unsupportedFamilies = [
    "audio",
    "embedding",
    "image",
    "moderation",
    "realtime",
    "rerank",
    "speech",
    "transcribe",
    "tts",
  ];

  return model.limit.context > 0
    && model.limit.output > 0
    && hasTextOutput(model)
    && !unsupportedFamilies.some((family) => searchable.includes(family));
}

function toVariants(variants: Record<string, Record<string, unknown>> | undefined): Record<string, ModelVariant> | undefined {
  if (!variants) return undefined;

  const entries = Object.entries(variants).map(([id, providerOptions]) => [
    id,
    {
      id,
      label: id,
      providerOptions,
    },
  ] satisfies [string, ModelVariant]);

  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/**
 * The payload style for reasoning variants must match the API that serves the
 * model, which is not always implied by the provider id. OpenCode Zen serves
 * claude-* models via the Anthropic Messages API and gpt-* models via the
 * OpenAI Responses API (see getProvider in app.ts). Sending the generic
 * `thinking: { type: "enabled" }` shape to a Claude model fails upstream
 * because the Anthropic API requires `budget_tokens` (min 1024) for that
 * thinking type.
 */
type ReasoningApiStyle = "anthropic" | "openai" | "generic";

function reasoningApiStyle(providerId: ProviderId, providerModelId: string): ReasoningApiStyle {
  if (providerId === "anthropic") return "anthropic";
  if (providerId === "openai") return "openai";
  if (providerId === "opencode") {
    if (providerModelId.startsWith("claude-")) return "anthropic";
    if (providerModelId.startsWith("gpt-")) return "openai";
  }
  return "generic";
}

function reasoningEffortVariant(style: ReasoningApiStyle, effort: string): ModelVariant {
  if (style === "anthropic") {
    return {
      id: effort,
      label: `adaptive thinking effort: ${effort}`,
      providerOptions: {
        thinking: { type: "adaptive", display: "summarized" },
        output_config: { effort },
      },
    };
  }

  if (style === "openai") {
    return {
      id: effort,
      label: `reasoning effort: ${effort}`,
      providerOptions: {
        reasoning: { effort, summary: "auto" },
        include: ["reasoning.encrypted_content"],
      },
    };
  }

  return {
    id: effort,
    label: `reasoning effort: ${effort}`,
    providerOptions: {
      thinking: { type: "enabled" },
      reasoning_effort: effort,
    },
  };
}

function reasoningToggleVariants(style: ReasoningApiStyle): Record<string, ModelVariant> {
  if (style === "anthropic") {
    return {
      nothink: {
        id: "nothink",
        label: "thinking: disabled",
        providerOptions: { thinking: { type: "disabled" } },
      },
      adaptive: {
        id: "adaptive",
        label: "adaptive thinking",
        providerOptions: { thinking: { type: "adaptive", display: "summarized" } },
      },
    };
  }

  return {
    think: {
      id: "think",
      label: "thinking: enabled",
      providerOptions: { thinking: { type: "enabled" } },
    },
    nothink: {
      id: "nothink",
      label: "thinking: disabled",
      providerOptions: { thinking: { type: "disabled" } },
    },
  };
}

function toReasoningVariants(
  providerId: ProviderId,
  providerModelId: string,
  model: ModelsDevCatalog[string]["models"][string],
): Record<string, ModelVariant> | undefined {
  if (model.reasoning !== true) return undefined;

  const style = reasoningApiStyle(providerId, providerModelId);
  const variants: Record<string, ModelVariant> = {};
  for (const option of model.reasoning_options ?? []) {
    if (option.type === "toggle") {
      Object.assign(variants, reasoningToggleVariants(style));
    } else if (option.type === "effort") {
      for (const effort of (option.values ?? []).filter((value): value is string => typeof value === "string")) {
        variants[effort] = reasoningEffortVariant(style, effort);
      }
    }
  }

  return Object.keys(variants).length > 0 ? variants : undefined;
}

function userFacingModelId(providerId: ProviderId, providerModelId: string): string {
  if (providerId === "fireworks" && providerModelId.startsWith("accounts/fireworks/")) {
    return providerModelId.split("/").at(-1) ?? providerModelId;
  }

  return providerModelId;
}

function toRemoteMetadata(catalog: ModelsDevCatalog): Record<string, ModelMetadata> {
  const metadata: Record<string, ModelMetadata> = {};

  for (const provider of Object.values(catalog)) {
    const providerId = REMOTE_PROVIDER_ID_MAP[provider.id];
    if (!providerId) continue;

    for (const [modelId, model] of Object.entries(provider.models)) {
      if (model.status === "deprecated" || !isTextGenerationModel(model)) continue;

      const providerModelId = model.id || modelId;
      const userModelId = userFacingModelId(providerId, providerModelId);
      const id = `${providerId}/${userModelId}`;
      const providerOptions = model.options && Object.keys(model.options).length > 0
        ? model.options
        : undefined;
      const variants = {
        ...(toReasoningVariants(providerId, providerModelId, model) ?? {}),
        ...(toVariants(model.variants) ?? {}),
      };
      const longContextPricing = model.cost?.context_over_200k
        ? {
            inputTokenThreshold: 200_000,
            pricing: toPricing(model.cost.context_over_200k),
          }
        : undefined;

      metadata[id] = {
        contextWindow: model.limit.context,
        maxOutputTokens: model.limit.output,
        supportsImages: hasImageInput(model),
        pricing: toPricing(model.cost),
        ...(providerModelId !== userModelId && { providerModel: providerModelId }),
        ...(providerOptions && { providerOptions }),
        ...(longContextPricing && { longContextPricing }),
        ...(Object.keys(variants).length > 0 && { variants }),
      };
    }
  }

  return metadata;
}

async function readCatalogFile(path: string): Promise<ModelsDevCatalog | undefined> {
  const raw = await readFile(path, "utf8").catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!raw) return undefined;
  return catalogSchema.parse(JSON.parse(raw));
}

async function cacheFresh(path: string): Promise<boolean> {
  const info = await stat(path).catch(() => undefined);
  if (!info) return false;
  return Date.now() - info.mtimeMs < CACHE_TTL_MS;
}

async function writeCatalogCache(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, "utf8");
}

async function fetchCatalogText(): Promise<string | undefined> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(`${modelsSourceUrl()}/api.json`, {
      headers: { "User-Agent": "Pace" },
      signal: controller.signal,
    });
    if (!response.ok) return undefined;
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

export async function loadCachedModelCatalog(): Promise<ModelCatalogLoadResult | undefined> {
  const catalog = await readCatalogFile(cachePath());
  if (!catalog) return undefined;
  return applyRemoteModelMetadata(toRemoteMetadata(catalog));
}

export async function refreshModelCatalog(options: { force?: boolean } = {}): Promise<ModelCatalogLoadResult | undefined> {
  if (modelFetchDisabled()) return undefined;

  const path = cachePath();
  if (!options.force && await cacheFresh(path)) {
    return loadCachedModelCatalog();
  }

  const text = await fetchCatalogText();
  if (!text) return undefined;

  const catalog = catalogSchema.parse(JSON.parse(text));
  await writeCatalogCache(path, text).catch(() => undefined);
  return applyRemoteModelMetadata(toRemoteMetadata(catalog));
}
