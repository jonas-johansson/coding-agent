/**
 * Persisted user preferences for Pace.
 *
 * Stored separately from the user-authored config at
 * ~/.config/pace/preferences.json. This file captures runtime state that
 * should survive across launches:
 *   - the set of models in the Tab cycle
 *   - the selected variant per model
 *   - the current active model selection (used on a fresh launch; resuming a
 *     session instead restores that session's last-used model)
 *   - MCP server enable/disable overrides (the mcp.json file itself is
 *     user-authored and never modified)
 *
 * Loading is tolerant: malformed JSON or entries that reference models or
 * variants no longer present in the catalog are dropped rather than throwing,
 * so a stale preferences file never blocks startup.
 */

import { mkdir, readFile, rename, unlink, writeFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import { z } from "zod";

// ── Types ────────────────────────────────────────────────────────────────────

export type UserPreferences = {
  /** Models in the Tab cycle, as formatModelSelection strings. */
  cycleModels?: string[];
  /** Selected variant id per model id. */
  variantByModel?: Record<string, string>;
  /** Current active model selection (formatModelSelection string). */
  currentModel?: string;
  /**
   * MCP server enable/disable overrides, keyed by server name. This is
   * Pace-owned runtime state; the user-authored mcp.json is never modified.
   */
  mcpEnabled?: Record<string, boolean>;
};

// ── Schema ───────────────────────────────────────────────────────────────────

const userPreferencesSchema = z.object({
  cycleModels: z.array(z.string()).optional(),
  variantByModel: z.record(z.string(), z.string()).optional(),
  currentModel: z.string().optional(),
  mcpEnabled: z.record(z.string(), z.boolean()).optional(),
});

// ── Paths ────────────────────────────────────────────────────────────────────

const PREFERENCES_DIR = join(homedir(), ".config", "pace");
const PREFERENCES_PATH = join(PREFERENCES_DIR, "prefs.json");

// ── Loading ──────────────────────────────────────────────────────────────────

/**
 * Load persisted preferences. Returns an empty object when the file is
 * missing or cannot be parsed; never throws for recoverable problems.
 */
export async function loadPreferences(): Promise<UserPreferences> {
  let raw: string;
  try {
    raw = await readFile(PREFERENCES_PATH, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }

  try {
    const parsed = userPreferencesSchema.parse(JSON.parse(raw));
    return parsed;
  } catch {
    // Malformed or schema-invalid preferences are non-fatal: ignore them.
    return {};
  }
}

// ── Saving ───────────────────────────────────────────────────────────────────

/** Atomically write preferences (temp file + rename), mirroring session writes. */
export async function savePreferences(preferences: UserPreferences): Promise<void> {
  const tempPath = join(PREFERENCES_DIR, `preferences.${process.pid}.${randomUUID()}.tmp`);

  await mkdir(PREFERENCES_DIR, { recursive: true });

  try {
    await writeFile(tempPath, `${JSON.stringify(preferences, null, 2)}\n`, "utf8");
    await rename(tempPath, PREFERENCES_PATH);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}
