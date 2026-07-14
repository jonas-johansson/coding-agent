/**
 * Model metadata and provider-qualified model id helpers.
 */

export type ProviderId = "anthropic" | "opencode" | "openai" | "fireworks" | "lmstudio";

export type PricingConfig = {
  inputPerMTok: number;
  cacheWritePerMTok: number;
  cacheReadPerMTok: number;
  outputPerMTok: number;
};

export type ModelVariant = {
  id: string;
  /** Human-readable provider-native wording, e.g. "reasoning effort: high". */
  label?: string;
  description?: string;
  /** Provider-native request options applied when this variant is selected. */
  providerOptions: Record<string, unknown>;
};

export type ModelMetadata = {
  contextWindow: number;
  maxOutputTokens: number;
  supportsImages: boolean;
  pricing: PricingConfig;
  /** Provider API model id when it differs from the user-facing model id. */
  providerModel?: string;
  /** Provider-native request options always applied for this model. */
  providerOptions?: Record<string, unknown>;
  longContextPricing?: {
    inputTokenThreshold: number;
    pricing: PricingConfig;
  };
  variants?: Record<string, ModelVariant>;
};

export type ModelConfig = ModelMetadata & {
  /** Full user-facing model id: provider/model. */
  id: string;
  /** Provider id parsed from the full model id. */
  provider: ProviderId;
  /** Model id sent to the provider API. */
  providerModel: string;
};

const ZERO_PRICING: PricingConfig = {
  inputPerMTok: 0,
  cacheWritePerMTok: 0,
  cacheReadPerMTok: 0,
  outputPerMTok: 0,
};

const OPENAI_ENCRYPTED_REASONING_INCLUDE = ["reasoning.encrypted_content"];

function openAIReasoningEffortVariant(effort: "none" | "low" | "medium" | "high" | "xhigh"): ModelVariant {
  return {
    id: effort,
    label: `reasoning effort: ${effort}`,
    providerOptions: {
      reasoning: { effort, summary: "auto" },
      include: OPENAI_ENCRYPTED_REASONING_INCLUDE,
    },
  };
}

const GPT_5_5_REASONING_VARIANTS: Record<string, ModelVariant> = {
  none: openAIReasoningEffortVariant("none"),
  low: openAIReasoningEffortVariant("low"),
  medium: openAIReasoningEffortVariant("medium"),
  high: openAIReasoningEffortVariant("high"),
  xhigh: openAIReasoningEffortVariant("xhigh"),
};

function anthropicAdaptiveThinkingVariant(effort: "low" | "medium" | "high" | "xhigh" | "max"): ModelVariant {
  return {
    id: effort,
    label: `adaptive thinking effort: ${effort}`,
    providerOptions: {
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort },
    },
  };
}

const ANTHROPIC_NOTHINK_VARIANT: ModelVariant = {
  id: "nothink",
  label: "thinking: disabled",
  providerOptions: { thinking: { type: "disabled" } },
};

const ANTHROPIC_ADAPTIVE_THINKING_VARIANTS: Record<string, ModelVariant> = {
  nothink: ANTHROPIC_NOTHINK_VARIANT,
  adaptive: {
    id: "adaptive",
    label: "adaptive thinking",
    providerOptions: { thinking: { type: "adaptive", display: "summarized" } },
  },
  low: anthropicAdaptiveThinkingVariant("low"),
  medium: anthropicAdaptiveThinkingVariant("medium"),
  high: anthropicAdaptiveThinkingVariant("high"),
  xhigh: anthropicAdaptiveThinkingVariant("xhigh"),
  max: anthropicAdaptiveThinkingVariant("max"),
};

const KIMI_VARIANTS: Record<string, ModelVariant> = {
  think: {
    id: "think",
    label: "thinking: preserved",
    providerOptions: { thinking: { type: "enabled", keep: "all" } },
  },
  nothink: {
    id: "nothink",
    label: "thinking: disabled",
    providerOptions: { thinking: { type: "disabled" } },
  },
};

const DEEPSEEK_VARIANTS: Record<string, ModelVariant> = {
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
  max: {
    id: "max",
    label: "reasoning effort: max",
    providerOptions: { thinking: { type: "enabled" }, reasoning_effort: "max" },
  },
};

const GLM_5_2_REASONING_VARIANTS: Record<string, ModelVariant> = {
  high: {
    id: "high",
    label: "reasoning effort: high",
    providerOptions: { reasoning_effort: "high" },
  },
  max: {
    id: "max",
    label: "reasoning effort: max",
    providerOptions: { reasoning_effort: "max" },
  },
};

const FABLE_5_EFFORT_VARIANTS: Record<string, ModelVariant> = {
  low: {
    id: "low",
    label: "effort: low",
    providerOptions: {
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "low" },
    },
  },
  medium: {
    id: "medium",
    label: "effort: medium",
    providerOptions: {
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "medium" },
    },
  },
  high: {
    id: "high",
    label: "effort: high",
    providerOptions: {
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "high" },
    },
  },
  xhigh: {
    id: "xhigh",
    label: "effort: xhigh",
    providerOptions: {
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "xhigh" },
    },
  },
  max: {
    id: "max",
    label: "effort: max",
    providerOptions: {
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "max" },
    },
  },
};

const ANTHROPIC_BUDGET_THINKING_VARIANTS: Record<string, ModelVariant> = {
  nothink: ANTHROPIC_NOTHINK_VARIANT,
  "thinking-8k": {
    id: "thinking-8k",
    label: "thinking budget: 8k",
    providerOptions: { thinking: { type: "enabled", budget_tokens: 8_192, display: "summarized" } },
  },
  "thinking-max": {
    id: "thinking-max",
    label: "thinking budget: max",
    providerOptions: { thinking: { type: "enabled", budget_tokens: 15_999, display: "summarized" } },
  },
};

export const MODEL_METADATA: Record<string, ModelMetadata> = {
  "anthropic/claude-haiku-4-5": {
    contextWindow: 200_000,
    maxOutputTokens: 16_000,
    supportsImages: true,
    variants: ANTHROPIC_BUDGET_THINKING_VARIANTS,
    pricing: {
      inputPerMTok: 1,
      cacheWritePerMTok: 1.25,
      cacheReadPerMTok: 0.10,
      outputPerMTok: 5,
    },
  },
  "anthropic/claude-sonnet-4-6": {
    contextWindow: 1_000_000,
    maxOutputTokens: 16_000,
    supportsImages: true,
    variants: ANTHROPIC_ADAPTIVE_THINKING_VARIANTS,
    pricing: {
      inputPerMTok: 3,
      cacheWritePerMTok: 3.75,
      cacheReadPerMTok: 0.30,
      outputPerMTok: 15,
    },
  },
  "anthropic/claude-opus-4-6": {
    contextWindow: 1_000_000,
    maxOutputTokens: 16_000,
    supportsImages: true,
    variants: ANTHROPIC_ADAPTIVE_THINKING_VARIANTS,
    pricing: {
      inputPerMTok: 5,
      cacheWritePerMTok: 6.25,
      cacheReadPerMTok: 0.50,
      outputPerMTok: 25,
    },
  },
  "anthropic/claude-opus-4-7": {
    contextWindow: 1_000_000,
    maxOutputTokens: 16_000,
    supportsImages: true,
    variants: ANTHROPIC_ADAPTIVE_THINKING_VARIANTS,
    pricing: {
      inputPerMTok: 5,
      cacheWritePerMTok: 6.25,
      cacheReadPerMTok: 0.50,
      outputPerMTok: 25,
    },
  },
  "anthropic/claude-opus-4-8": {
    contextWindow: 1_000_000,
    maxOutputTokens: 16_000,
    supportsImages: true,
    variants: ANTHROPIC_ADAPTIVE_THINKING_VARIANTS,
    pricing: {
      inputPerMTok: 5,
      cacheWritePerMTok: 6.25,
      cacheReadPerMTok: 0.50,
      outputPerMTok: 25,
    },
  },
  "opencode/claude-haiku-4-5": {
    contextWindow: 200_000,
    maxOutputTokens: 16_000,
    supportsImages: true,
    variants: ANTHROPIC_BUDGET_THINKING_VARIANTS,
    pricing: {
      inputPerMTok: 1,
      cacheWritePerMTok: 1.25,
      cacheReadPerMTok: 0.10,
      outputPerMTok: 5,
    },
  },
  "opencode/claude-sonnet-4-6": {
    contextWindow: 1_000_000,
    maxOutputTokens: 16_000,
    supportsImages: true,
    variants: ANTHROPIC_ADAPTIVE_THINKING_VARIANTS,
    pricing: {
      inputPerMTok: 3,
      cacheWritePerMTok: 3.75,
      cacheReadPerMTok: 0.30,
      outputPerMTok: 15,
    },
  },
  "opencode/claude-opus-4-6": {
    contextWindow: 1_000_000,
    maxOutputTokens: 16_000,
    supportsImages: true,
    variants: ANTHROPIC_ADAPTIVE_THINKING_VARIANTS,
    pricing: {
      inputPerMTok: 5,
      cacheWritePerMTok: 6.25,
      cacheReadPerMTok: 0.50,
      outputPerMTok: 25,
    },
  },
  "opencode/claude-opus-4-7": {
    contextWindow: 1_000_000,
    maxOutputTokens: 16_000,
    supportsImages: true,
    variants: ANTHROPIC_ADAPTIVE_THINKING_VARIANTS,
    pricing: {
      inputPerMTok: 5,
      cacheWritePerMTok: 6.25,
      cacheReadPerMTok: 0.50,
      outputPerMTok: 25,
    },
  },
  "opencode/claude-opus-4-8": {
    contextWindow: 1_000_000,
    maxOutputTokens: 16_000,
    supportsImages: true,
    variants: ANTHROPIC_ADAPTIVE_THINKING_VARIANTS,
    pricing: {
      inputPerMTok: 5,
      cacheWritePerMTok: 6.25,
      cacheReadPerMTok: 0.50,
      outputPerMTok: 25,
    },
  },
  "opencode/claude-fable-5": {
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    supportsImages: true,
    providerOptions: { thinking: { type: "adaptive", display: "summarized" } },
    variants: FABLE_5_EFFORT_VARIANTS,
    pricing: {
      inputPerMTok: 10.00,
      cacheWritePerMTok: 12.50,
      cacheReadPerMTok: 1.00,
      outputPerMTok: 50.00,
    },
  },
  "opencode/kimi-k2.6": {
    contextWindow: 262_144,
    maxOutputTokens: 32_000,
    supportsImages: true,
    variants: KIMI_VARIANTS,
    pricing: {
      inputPerMTok: 0.95,
      cacheWritePerMTok: 0,
      cacheReadPerMTok: 0.16,
      outputPerMTok: 4.00,
    },
  },
  "opencode/kimi-k2.7-code": {
    contextWindow: 262_144,
    maxOutputTokens: 32_000,
    supportsImages: true,
    pricing: {
      inputPerMTok: 0.95,
      cacheWritePerMTok: 0,
      cacheReadPerMTok: 0.19,
      outputPerMTok: 4.00,
    },
  },
  "opencode/deepseek-v4-pro": {
    contextWindow: 1_000_000,
    maxOutputTokens: 384_000,
    supportsImages: false,
    variants: DEEPSEEK_VARIANTS,
    pricing: {
      inputPerMTok: 1.74,
      cacheWritePerMTok: 0,
      cacheReadPerMTok: 0.0145,
      outputPerMTok: 3.48,
    },
  },
  "opencode/deepseek-v4-flash": {
    contextWindow: 1_000_000,
    maxOutputTokens: 384_000,
    supportsImages: false,
    variants: DEEPSEEK_VARIANTS,
    pricing: {
      inputPerMTok: 0.14,
      cacheWritePerMTok: 0,
      cacheReadPerMTok: 0.0028,
      outputPerMTok: 0.28,
    },
  },
  "opencode/deepseek-v4-flash-free": {
    contextWindow: 1_000_000,
    maxOutputTokens: 384_000,
    supportsImages: false,
    variants: DEEPSEEK_VARIANTS,
    pricing: ZERO_PRICING,
  },
  "opencode/glm-5.2": {
    contextWindow: 1_000_000,
    maxOutputTokens: 131_072,
    supportsImages: false,
    variants: GLM_5_2_REASONING_VARIANTS,
    pricing: {
      inputPerMTok: 1.40,
      cacheWritePerMTok: 0,
      cacheReadPerMTok: 0.26,
      outputPerMTok: 4.40,
    },
  },
  "fireworks/kimi-k2.6": {
    contextWindow: 262_144,
    maxOutputTokens: 32_000,
    supportsImages: true,
    variants: KIMI_VARIANTS,
    pricing: {
      inputPerMTok: 0.95,
      cacheWritePerMTok: 0,
      cacheReadPerMTok: 0.16,
      outputPerMTok: 4.00,
    },
  },
  "fireworks/kimi-k2.7-code": {
    contextWindow: 262_144,
    maxOutputTokens: 32_000,
    supportsImages: true,
    pricing: {
      inputPerMTok: 0.95,
      cacheWritePerMTok: 0,
      cacheReadPerMTok: 0.19,
      outputPerMTok: 4.00,
    },
  },
  "opencode/gpt-5.5": {
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    supportsImages: true,
    variants: GPT_5_5_REASONING_VARIANTS,
    pricing: {
      inputPerMTok: 5.00,
      cacheWritePerMTok: 0,
      cacheReadPerMTok: 0.50,
      outputPerMTok: 30.00,
    },
    longContextPricing: {
      inputTokenThreshold: 272_000,
      pricing: {
        inputPerMTok: 10.00,
        cacheWritePerMTok: 0,
        cacheReadPerMTok: 1.00,
        outputPerMTok: 45.00,
      },
    },
  },
  "openai/gpt-5.5": {
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    supportsImages: true,
    variants: GPT_5_5_REASONING_VARIANTS,
    pricing: {
      inputPerMTok: 5.00,
      cacheWritePerMTok: 0,
      cacheReadPerMTok: 0.50,
      outputPerMTok: 30.00,
    },
    longContextPricing: {
      inputTokenThreshold: 272_000,
      pricing: {
        inputPerMTok: 10.00,
        cacheWritePerMTok: 0,
        cacheReadPerMTok: 1.00,
        outputPerMTok: 45.00,
      },
    },
  },
  "lmstudio/google/gemma-4-12b": {
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    supportsImages: true,
    pricing: ZERO_PRICING,
  },
  // "lmstudio/google/gemma-4-26b-a4b": {
  //   contextWindow: 32_768,
  //   maxOutputTokens: 8_192,
  //   supportsImages: true,
  //   pricing: ZERO_PRICING,
  // },
  // "lmstudio/qwen/qwen3.6-35b-a3b": {
  //   contextWindow: 32_768,
  //   maxOutputTokens: 8_192,
  //   supportsImages: true,
  //   pricing: ZERO_PRICING,
  // },
};

const PROVIDER_IDS = new Set<ProviderId>([
  "anthropic",
  "opencode",
  "openai",
  "fireworks",
  "lmstudio",
]);

export function parseModelId(id: string): { id: string; provider: ProviderId; providerModel: string } | undefined {
  const slashIndex = id.indexOf("/");
  if (slashIndex <= 0 || slashIndex === id.length - 1) return undefined;

  const provider = id.slice(0, slashIndex);
  if (!PROVIDER_IDS.has(provider as ProviderId)) return undefined;

  return {
    id,
    provider: provider as ProviderId,
    providerModel: id.slice(slashIndex + 1),
  };
}

const DEFAULT_MODEL_METADATA_BY_PROVIDER: Record<ProviderId, ModelMetadata> = {
  anthropic: {
    contextWindow: 200_000,
    maxOutputTokens: 16_000,
    supportsImages: true,
    pricing: ZERO_PRICING,
  },
  opencode: {
    contextWindow: 128_000,
    maxOutputTokens: 16_000,
    supportsImages: true,
    pricing: ZERO_PRICING,
  },
  openai: {
    contextWindow: 128_000,
    maxOutputTokens: 16_000,
    supportsImages: true,
    pricing: ZERO_PRICING,
  },
  fireworks: {
    contextWindow: 128_000,
    maxOutputTokens: 16_000,
    supportsImages: true,
    pricing: ZERO_PRICING,
  },
  lmstudio: {
    contextWindow: 32_768,
    maxOutputTokens: 8_192,
    supportsImages: true,
    pricing: ZERO_PRICING,
  },
};

export function getModelConfig(id: string): ModelConfig | undefined {
  const parsed = parseModelId(id);
  if (!parsed) return undefined;

  const metadata = runtimeModelMetadata[id] ?? DEFAULT_MODEL_METADATA_BY_PROVIDER[parsed.provider];
  return { ...metadata, ...parsed, providerModel: metadata.providerModel ?? parsed.providerModel };
}

export type ModelSelection = {
  modelId: string;
  variantId?: string;
};

export function getModelVariant(modelId: string, variantId: string | undefined): ModelVariant | undefined {
  if (!variantId) return undefined;
  return getModelConfig(modelId)?.variants?.[variantId];
}

export function formatModelSelection(selection: ModelSelection): string {
  return selection.variantId ? `${selection.modelId}:${selection.variantId}` : selection.modelId;
}

export function parseModelSelection(input: string): ModelSelection | undefined {
  // Try the "modelId:variantId" form first. The exact-match fallback below is
  // lenient for known providers (it accepts arbitrary model names via default
  // metadata), so it would otherwise swallow a valid variant suffix and treat
  // e.g. "opencode/gpt-5.5:xhigh" as a whole model id with no variant.
  const lastColonIndex = input.lastIndexOf(":");
  if (lastColonIndex !== -1) {
    const modelId = input.slice(0, lastColonIndex);
    const variantId = input.slice(lastColonIndex + 1);
    const model = getModelConfig(modelId);
    if (model && variantId && model.variants?.[variantId]) {
      return { modelId: model.id, variantId };
    }
  }

  const exactModel = getModelConfig(input);
  if (exactModel) return { modelId: exactModel.id };

  return undefined;
}

let runtimeModelMetadata: Record<string, ModelMetadata> = { ...MODEL_METADATA };

function createModels(metadata: Record<string, ModelMetadata> = runtimeModelMetadata): Record<string, ModelConfig> {
  return Object.fromEntries(
    Object.keys(metadata).map((id) => {
      const config = getModelConfig(id);
      if (!config) {
        throw new Error(`Invalid model id: ${id}`);
      }
      return [id, config];
    }),
  );
}

let runtimeModels: Record<string, ModelConfig> = createModels();

export const DEFAULT_MODEL_ID = "opencode/kimi-k2.6";

/**
 * Replace the remote portion of the runtime catalog. Built-in model metadata is
 * always retained and wins over remote metadata for known ids.
 */
export function applyRemoteModelMetadata(remoteMetadata: Record<string, ModelMetadata>): { addedModelIds: string[]; totalModelCount: number } {
  const previousIds = new Set(Object.keys(runtimeModelMetadata));
  const nextMetadata: Record<string, ModelMetadata> = { ...MODEL_METADATA };

  for (const [id, metadata] of Object.entries(remoteMetadata)) {
    if (MODEL_METADATA[id]) continue;
    nextMetadata[id] = metadata;
  }

  runtimeModelMetadata = nextMetadata;
  runtimeModels = createModels();

  const addedModelIds = Object.keys(runtimeModelMetadata).filter((id) => !previousIds.has(id));
  return { addedModelIds, totalModelCount: Object.keys(runtimeModelMetadata).length };
}

export function getModels(): Record<string, ModelConfig> {
  return runtimeModels;
}

export function getAvailableModelIds(): string[] {
  return Object.keys(runtimeModels);
}
