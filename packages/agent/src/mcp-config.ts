/**
 * MCP server configuration loading and validation.
 *
 * Supports global config at ~/.config/pace/mcp.json
 */

import { readFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { z } from "zod";

// ── Schema ───────────────────────────────────────────────────────────────────

const mcpLocalConfigSchema = z.object({
  type: z.literal("local"),
  command: z.array(z.string()).min(1),
  environment: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().optional().default(true),
  timeout: z.number().int().positive().optional().default(5000),
});

const mcpRemoteConfigSchema = z.object({
  type: z.literal("remote"),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().optional().default(true),
  timeout: z.number().int().positive().optional().default(5000),
});

const mcpServerConfigSchema = z.union([mcpLocalConfigSchema, mcpRemoteConfigSchema]);

const mcpConfigSchema = z.record(z.string(), mcpServerConfigSchema);

export type McpLocalConfig = z.infer<typeof mcpLocalConfigSchema>;
export type McpRemoteConfig = z.infer<typeof mcpRemoteConfigSchema>;
export type McpServerConfig = z.infer<typeof mcpServerConfigSchema>;
export type McpConfig = z.infer<typeof mcpConfigSchema>;

// ── Loading ──────────────────────────────────────────────────────────────────

const CONFIG_PATH = join(homedir(), ".config", "pace", "mcp.json");

export async function loadMcpConfig(): Promise<McpConfig> {
  try {
    const raw = await readFile(CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    return mcpConfigSchema.parse(parsed);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

/**
 * Return the servers that should be connected.
 *
 * `enabledOverrides` carries Pace-owned runtime state (from prefs.json) and
 * wins over the user-authored `enabled` field in mcp.json when present.
 */
export function getEnabledServers(
  config: McpConfig,
  enabledOverrides?: Record<string, boolean>,
): Array<{ name: string; config: McpServerConfig }> {
  const entries: Array<{ name: string; config: McpServerConfig }> = [];
  for (const [name, serverConfig] of Object.entries(config)) {
    const enabled = enabledOverrides?.[name] ?? serverConfig.enabled !== false;
    if (enabled) {
      entries.push({ name, config: serverConfig });
    }
  }
  return entries;
}
