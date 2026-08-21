/**
 * terminal-utils.ts — Synchronous terminal background colour detection.
 *
 * Detects whether the terminal background is light or dark by checking
 * terminal-emulator config files, environment variables, and OS settings.
 * All I/O is synchronous (existsSync, readFileSync, execSync).
 */

import { existsSync, readFileSync } from "fs";
import { execSync } from "child_process";
import { homedir } from "os";
import { join as pathJoin } from "path";

// ── Colour / luminance helpers ───────────────────────────────────────────────

/** sRGB 0–255 → WCAG relative luminance. */
function luminance(r: number, g: number, b: number): number {
  const f = (c: number): number => {
    c /= 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** Return "light" / "dark" for a given RGB triplet (0–255). */
function classify(r: number, g: number, b: number, threshold = 0.5): "light" | "dark" {
  return luminance(r, g, b) > threshold ? "light" : "dark";
}

/** Parse "#RRGGBB" (with or without #) → [R, G, B] or null. */
function parseHex(hex: string): [number, number, number] | null {
  const m = hex.replace(/^#/, "").match(/^([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/);
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : null;
}

// ── Terminal-emulator config files ───────────────────────────────────────────

function fromTerminalConfig(): "light" | "dark" | null {
  const home = homedir();
  const xdg = process.env.XDG_CONFIG_HOME ?? pathJoin(home, ".config");

  // ── omarchy theme (takes precedence — it's the active theme source) ──
  try {
    const omarchyTheme = pathJoin(xdg, "omarchy", "current", "theme", "colors.toml");
    if (existsSync(omarchyTheme)) {
      const content = readFileSync(omarchyTheme, "utf-8");
      const m = content.match(
        /^\s*background\s*=\s*"#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})"/m,
      );
      if (m) return classify(parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16));
    }
  } catch {
    // ignore
  }

  // ── Alacritty ────────────────────────────────────────────────────
  for (const configPath of [
    pathJoin(xdg, "alacritty", "alacritty.toml"),
    pathJoin(xdg, "alacritty", "alacritty.yml"),
    pathJoin(home, ".alacritty.toml"),
  ]) {
    try {
      if (!existsSync(configPath)) continue;
      const content = readFileSync(configPath, "utf-8");

      const importMatch = content.match(/^\s*general\.import\s*=\s*\[([^\]]+)\]/m);
      if (importMatch) {
        const imported = importMatch[1]
          .split(/[,\n]/)
          .map((s) => s.trim().replace(/^"|"$/g, "").replace(/^~/, home))
          .filter(Boolean);
        for (const imp of imported) {
          try {
            const impPath = imp.startsWith("/") ? imp : pathJoin(configPath, "..", imp);
            if (existsSync(impPath)) {
              const impContent = readFileSync(impPath, "utf-8");
              const m = impContent.match(
                /^\s*background\s*=\s*"#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})"/m,
              );
              if (m) return classify(parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16));
            }
          } catch {
            // ignore
          }
        }
      }

      const m = content.match(
        /^\s*background\s*=\s*"#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})"/m,
      );
      if (m) return classify(parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16));
    } catch {
      // ignore
    }
  }

  // ── Kitty ────────────────────────────────────────────────────────
  try {
    for (const kp of [
      pathJoin(xdg, "kitty", "kitty.conf"),
      pathJoin(home, ".config", "kitty", "kitty.conf"),
    ]) {
      if (!existsSync(kp)) continue;
      const content = readFileSync(kp, "utf-8");
      const m = content.match(
        /^\s*background\s+#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})\s*$/m,
      );
      if (m) return classify(parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16));
    }
  } catch {
    // ignore
  }

  // ── Ghostty ──────────────────────────────────────────────────────
  try {
    for (const gp of [
      pathJoin(xdg, "ghostty", "config"),
      pathJoin(home, ".config", "ghostty", "config"),
    ]) {
      if (!existsSync(gp)) continue;
      const content = readFileSync(gp, "utf-8");
      const m = content.match(
        /^\s*background\s*=\s*#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})\s*$/m,
      );
      if (m) return classify(parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16));
    }
  } catch {
    // ignore
  }

  // ── foot ─────────────────────────────────────────────────────────
  try {
    for (const fp of [
      pathJoin(xdg, "foot", "foot.ini"),
      pathJoin(home, ".config", "foot", "foot.ini"),
    ]) {
      if (!existsSync(fp)) continue;
      const content = readFileSync(fp, "utf-8");
      const inColors = content.match(/^\[colors\]\s*$/m);
      if (inColors && inColors.index !== undefined) {
        const section = content.slice(inColors.index);
        const m = section.match(
          /^\s*background\s*=\s*([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})\s*$/m,
        );
        if (m) return classify(parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16));
      }
    }
  } catch {
    // ignore
  }

  // ── WezTerm ──────────────────────────────────────────────────────
  try {
    for (const wp of [
      pathJoin(xdg, "wezterm", "wezterm.lua"),
      pathJoin(home, ".config", "wezterm", "wezterm.lua"),
      pathJoin(home, ".wezterm.lua"),
    ]) {
      if (!existsSync(wp)) continue;
      const content = readFileSync(wp, "utf-8");
      const m = content.match(
        /["']background["']\s*=\s*["']#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})["']/,
      );
      if (m) return classify(parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16));
    }
  } catch {
    // ignore
  }

  return null;
}

// ── Environment variable checks ──────────────────────────────────────────────

function fromBackgroundEnv(): "light" | "dark" | null {
  if (!process.env.BACKGROUND) return null;
  const rgb = parseHex(process.env.BACKGROUND);
  return rgb ? classify(rgb[0], rgb[1], rgb[2]) : null;
}

// ── GNOME Terminal (Linux) ───────────────────────────────────────────────────

function fromGnomeSettings(): "light" | "dark" | null {
  if (process.platform !== "linux") return null;

  try {
    const profile = execSync(
      "gsettings get org.gnome.Terminal.ProfilesList default 2>/dev/null || true",
      { timeout: 2000, encoding: "utf-8" },
    )
      .trim()
      .replace(/^'|'$/g, "");

    if (profile) {
      const bg = execSync(
        `gsettings get org.gnome.Terminal.Legacy.Profile:/org/gnome/terminal/legacy/profiles:/:${profile}/ background-color 2>/dev/null || true`,
        { timeout: 2000, encoding: "utf-8" },
      )
        .trim()
        .replace(/^'|'$/g, "");

      if (bg && bg !== "default") {
        const rgb = parseHex(bg);
        if (rgb) return classify(rgb[0], rgb[1], rgb[2]);
      }

      const useTheme = execSync(
        `gsettings get org.gnome.Terminal.Legacy.Profile:/org/gnome/terminal/legacy/profiles:/:${profile}/ use-theme-colors 2>/dev/null || true`,
        { timeout: 2000, encoding: "utf-8" },
      ).trim();

      if (useTheme === "true") {
        const gtkTheme = process.env.GTK_THEME;
        if (gtkTheme) {
          const t = gtkTheme.toLowerCase();
          if (t.includes("light")) return "light";
          if (t.includes("dark")) return "dark";
        }
      }
    }
  } catch {
    // ignore
  }

  return null;
}

// ── macOS iTerm2 / Terminal.app ──────────────────────────────────────────────

function fromMacDefaults(): "light" | "dark" | null {
  if (process.platform !== "darwin") return null;

  try {
    const out = execSync(
      'defaults read com.googlecode.iterm2 "New Bookmarks" 2>/dev/null || true',
      { timeout: 2000, encoding: "utf-8", maxBuffer: 1024 * 1024 },
    );
    const blocks = out.match(/"Background Color"\s*=\s*\{([^}]+)\}/g);
    if (blocks) {
      for (const block of blocks) {
        const nums = block.match(/(\d+(?:\.\d+)?)/g);
        if (nums && nums.length >= 3) {
          const [r, g, b] = nums.map(Number);
          if (r + g + b > 0) {
            return classify(r * 255, g * 255, b * 255);
          }
        }
      }
    }
  } catch {
    // ignore
  }

  try {
    const out = execSync(
      "defaults read -app Terminal 2>/dev/null || true",
      { timeout: 2000, encoding: "utf-8" },
    );
    const m = out.match(/BackgroundColor\s*=\s*"([^"]+)"/);
    if (m) {
      const parts = m[1].split(/\s+/).map(Number);
      if (parts.length >= 3 && parts[0] + parts[1] + parts[2] > 0) {
        return classify(parts[0] * 255, parts[1] * 255, parts[2] * 255);
      }
    }
  } catch {
    // ignore
  }

  return null;
}

// ── KDE Konsole config (Linux) ───────────────────────────────────────────────

function fromKonsoleConfig(): "light" | "dark" | null {
  if (process.platform !== "linux") return null;

  try {
    const configDir =
      process.env.XDG_CONFIG_HOME ?? pathJoin(process.env.HOME ?? "/tmp", ".config");
    const konsoleDir = pathJoin(configDir, "konsole");
    const profileFile = process.env.KONSOLE_PROFILE_NAME;
    if (!profileFile) return null;

    const profilePath = pathJoin(konsoleDir, `${profileFile}.profile`);
    if (!existsSync(profilePath)) return null;

    const content = readFileSync(profilePath, "utf-8");
    const bgMatch = content.match(/^BackgroundColor\s*=\s*(\d+),\s*(\d+),\s*(\d+)/m);
    if (bgMatch) {
      return classify(Number(bgMatch[1]), Number(bgMatch[2]), Number(bgMatch[3]));
    }
  } catch {
    // ignore
  }

  return null;
}

// ── Other environment variables ──────────────────────────────────────────────

function fromOtherEnv(): "light" | "dark" | null {
  if (process.env.COLORFGBG) {
    const parts = process.env.COLORFGBG.split(";");
    const bg = parseInt(parts[parts.length - 1], 10);
    if (!Number.isNaN(bg)) {
      return bg === 7 || bg === 15 ? "light" : "dark";
    }
  }

  if (process.env.GTK_THEME) {
    const t = process.env.GTK_THEME.toLowerCase();
    if (t.includes("light") || t.includes("-lite") || t.includes("day")) return "light";
    if (t.includes("dark") || t.includes("black") || t.includes("night")) return "dark";
  }

  if (process.env.WT_THEME) {
    const t = process.env.WT_THEME.toLowerCase();
    if (t === "light" || t === "dark") return t;
  }

  return null;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Detect whether the terminal background is light or dark.
 * Synchronous — no escape-sequence queries, no async I/O.
 *
 * Checks (in order):
 *   1. Terminal-emulator config files (omarchy, Alacritty, Kitty, Ghostty, foot, WezTerm)
 *   2. $BACKGROUND env var
 *   3. GNOME Terminal gsettings (Linux)
 *   4. macOS iTerm2 / Terminal.app profiles
 *   5. KDE Konsole config
 *   6. $COLORFGBG, $GTK_THEME, $WT_THEME env vars
 *
 * @returns {"light"|"dark"} — defaults to "dark" when detection fails.
 */
export function detectTerminalBackground(): "light" | "dark" {
  const result =
    fromTerminalConfig() ??
    fromBackgroundEnv() ??
    fromGnomeSettings() ??
    fromMacDefaults() ??
    fromKonsoleConfig() ??
    fromOtherEnv();

  return result ?? "dark";
}
