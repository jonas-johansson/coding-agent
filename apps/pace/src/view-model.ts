/**
 * View-model types and pure formatting helpers shared by the TUI renderer
 * and session replay. This module must stay UI-framework-free and must not
 * import from tui.ts — the dependency direction is view-model → consumers.
 */

import type { BlockRole } from "./themes";
import { DEFAULT_COST_DISPLAY_CONFIG, type CostDisplayConfig } from "./config";

export type BlockState = "running" | "done" | "error";

export type RenderBlock = {
  id: number;
  key?: string;
  role: BlockRole;
  title?: string;
  content: string;
  collapsed?: boolean;
  state?: BlockState;
};

export type BlockPatch = Partial<Pick<RenderBlock, "title" | "content" | "state" | "collapsed">>;

export type ContextInfo = {
  usedTokens: number;
  contextWindow: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  /** True when usedTokens is an estimate (e.g. right after a compaction). */
  estimated?: boolean;
};

export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) {
    const value = tokens / 1_000_000;
    return value % 1 === 0 ? `${value}M` : `${value.toFixed(1)}M`;
  }
  if (tokens >= 1_000) {
    const value = tokens / 1_000;
    return value % 1 === 0 ? `${value}k` : `${value.toFixed(1)}k`;
  }
  return `${tokens}`;
}

export function formatCost(cost: number, config: CostDisplayConfig): string {
  const convertedCost = cost * config.conversionRate;
  const amount = formatCostAmount(convertedCost, config.fractionDigits);
  return config.format.replaceAll("{amount}", amount);
}

/** Format a cost for display in session listings, always rounded to 3 decimals. */
export function formatSessionCost(cost: number, config: CostDisplayConfig): string {
  const convertedCost = cost * config.conversionRate;
  const amount = convertedCost.toFixed(3);
  return config.format.replaceAll("{amount}", amount);
}

export function formatCostAmount(cost: number, fractionDigits: number | undefined): string {
  if (fractionDigits !== undefined) {
    return cost.toFixed(fractionDigits);
  }
  if (cost < 0.01) {
    // Show sub-cent costs with more precision
    return cost.toFixed(4);
  }
  if (cost < 1) {
    return cost.toFixed(3);
  }
  return cost.toFixed(2);
}

// Re-exported so consumers of the formatters get the config default too.
export { DEFAULT_COST_DISPLAY_CONFIG };
