/**
 * Pace configuration loading and validation.
 *
 * Supports global config at ~/.config/pace/config.json
 */

import { readFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { z } from "zod";

// ── Types ────────────────────────────────────────────────────────────────────

export type CostDisplayConfig = {
  conversionRate: number;
  format: string;
  fractionDigits?: number;
};

export type CompactionConfig = {
  auto: boolean;
  thresholdTokens: number;
  keepRecentTokens: number;
  model?: string;
};

export type PaceConfig = {
  cost: CostDisplayConfig;
  compaction: CompactionConfig;
  defaultModel?: string;
  cycleModels?: string[];
  sessionTitleModel?: string;
};

// ── Defaults ─────────────────────────────────────────────────────────────────

export const DEFAULT_COST_DISPLAY_CONFIG: CostDisplayConfig = {
  conversionRate: 1,
  format: "${amount}",
};

export const DEFAULT_COMPACTION_CONFIG: CompactionConfig = {
  auto: true,
  thresholdTokens: 150_000,
  keepRecentTokens: 20_000,
};

export const DEFAULT_PACE_CONFIG: PaceConfig = {
  cost: DEFAULT_COST_DISPLAY_CONFIG,
  compaction: DEFAULT_COMPACTION_CONFIG,
};

// ── Schema ───────────────────────────────────────────────────────────────────

const costDisplayConfigSchema = z.object({
  conversionRate: z.number().positive().finite().default(DEFAULT_COST_DISPLAY_CONFIG.conversionRate),
  format: z.string().refine((value) => value.includes("{amount}"), {
    message: "Cost format must include {amount}",
  }).default(DEFAULT_COST_DISPLAY_CONFIG.format),
  fractionDigits: z.number().int().min(0).max(20).optional(),
});

const compactionConfigSchema = z.object({
  auto: z.boolean().default(DEFAULT_COMPACTION_CONFIG.auto),
  thresholdTokens: z.number().int().positive().default(DEFAULT_COMPACTION_CONFIG.thresholdTokens),
  keepRecentTokens: z.number().int().positive().default(DEFAULT_COMPACTION_CONFIG.keepRecentTokens),
  model: z.string().optional(),
});

const paceConfigSchema = z.object({
  cost: costDisplayConfigSchema.optional(),
  compaction: compactionConfigSchema.optional(),
  defaultModel: z.string().optional(),
  cycleModels: z.array(z.string()).min(1).optional(),
  sessionTitleModel: z.string().optional(),
}).transform((config) => ({
  cost: config.cost ?? DEFAULT_COST_DISPLAY_CONFIG,
  compaction: config.compaction ?? DEFAULT_COMPACTION_CONFIG,
  ...(config.defaultModel !== undefined && { defaultModel: config.defaultModel }),
  ...(config.cycleModels !== undefined && { cycleModels: config.cycleModels }),
  ...(config.sessionTitleModel !== undefined && { sessionTitleModel: config.sessionTitleModel }),
}));

// ── Loading ──────────────────────────────────────────────────────────────────

/** Resolved at call time so tests can redirect HOME via the environment. */
function configPath(): string {
  return join(homedir(), ".config", "pace", "config.json");
}

export async function loadPaceConfig(): Promise<PaceConfig> {
  try {
    const raw = await readFile(configPath(), "utf-8");
    const parsed = JSON.parse(raw);
    return paceConfigSchema.parse(parsed);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return DEFAULT_PACE_CONFIG;
    }
    throw error;
  }
}
