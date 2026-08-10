/**
 * Lightweight, local "command classifier" for the bash tool.
 *
 * Pace runs commands with no approval gate, so this is a cheap, client-side
 * guard that blocks clearly destructive commands before they ever spawn a
 * shell.
 *
 * It is intentionally pattern-based (fast, no network, no model call) so it
 * does not hurt Pace's fast startup. It errs toward precision: it only blocks
 * things that are almost certainly destructive, and merely flags the rest as
 * "suspicious" so the model still sees the result.
 *
 * Set PACE_DISABLE_COMMAND_GUARD=1 to turn the guard off entirely.
 */

export type CommandVerdict = "safe" | "suspicious" | "dangerous";

export type CommandSafetyResult = {
  verdict: CommandVerdict;
  /** Human-readable reason for a non-safe verdict. */
  reason?: string;
  /** Which rules fired. */
  matches: string[];
};

type Rule = {
  name: string;
  reason: string;
  test: (command: string) => boolean;
};

// Paths that should never be the target of a recursive delete.
const CRITICAL_PATHS = [
  "/",
  "/usr",
  "/bin",
  "/etc",
  "/var",
  "/home",
  "/boot",
  "/dev",
  "/proc",
  "/sys",
  "/root",
  "/sbin",
  "/lib",
  "/lib64",
  "~",
  "$HOME",
];

function rmRecursiveTargetsCriticalPath(command: string): boolean {
  // Match `rm` invocations carrying -r and/or -f, capturing everything after
  // the flags as the target list. Handles an optional leading `sudo`.
  const rmRe = /(^|[;&|]\s*)(?:sudo\s+)?rm\s+(-[a-zA-Z0-9]*[rf][a-zA-Z0-9]*\s+)+([^;&|]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = rmRe.exec(command))) {
    const targets = m[3].trim();
    for (const raw of targets.split(/\s+/)) {
      const target = raw.replace(/^["']|["']$/g, "");
      if (!target) continue;
      if (target === "~" || target === "$HOME" || target === "*" || target === "." || target === "..") {
        return true;
      }
      if (CRITICAL_PATHS.includes(target)) return true;
      // Covers /usr/*, /etc/*, etc.
      if (/^\/(usr|bin|etc|var|home|boot|dev|proc|sys|root|sbin|lib|lib64)(\/|$)/.test(target)) return true;
    }
  }
  return false;
}

// Rules that block the command outright.
const DANGEROUS_RULES: Rule[] = [
  {
    name: "rm-critical-path",
    reason: "Recursive delete targeting a critical path",
    test: rmRecursiveTargetsCriticalPath,
  },
  {
    name: "pipe-to-shell",
    reason: "Downloaded script piped directly to a shell",
    test: (cmd) => /(curl|wget)\s+[^;&|]*\s*\|\s*(sudo\s+)?(ba)?sh\b/i.test(cmd),
  },
  {
    name: "disk-format",
    reason: "Formatting or writing directly to a block device",
    test: (cmd) =>
      /(^|[;&|]\s*)(mkfs(\.\w+)?|fdisk\b|dd\s+.*\bof=\/dev\/)/i.test(cmd),
  },
  {
    name: "shutdown",
    reason: "System shutdown, reboot, or poweroff",
    test: (cmd) => /(^|[;&|]\s*)(reboot|poweroff|halt)\b/i.test(cmd),
  },
  {
    name: "fork-bomb",
    reason: "Looks like a fork bomb",
    test: (cmd) => /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/i.test(cmd),
  },
];

// Rules that are flagged but allowed to run.
const SUSPICIOUS_RULES: Rule[] = [
  {
    name: "sudo",
    reason: "Runs with elevated privileges",
    test: (cmd) => /(^|[;&|]\s*)sudo\b/i.test(cmd),
  },
  {
    name: "git-force-push",
    reason: "Force push to a git remote",
    test: (cmd) => /git\s+push\s+[^|;&]*--force(-with-lease)?\b/i.test(cmd),
  },
  {
    name: "destructive-sql",
    reason: "Destructive SQL statement",
    test: (cmd) => /\b(DROP|TRUNCATE)\s+(TABLE|DATABASE|SCHEMA)\b/i.test(cmd),
  },
  {
    name: "kill-processes",
    reason: "Kills running processes",
    test: (cmd) => /(^|[;&|]\s*)(kill|pkill|killall)\b/i.test(cmd),
  },
  {
    name: "chmod-recursive",
    reason: "Recursive permission change",
    test: (cmd) => /chmod\s+-[a-zA-Z]*R[a-zA-Z]*\s+/i.test(cmd),
  },
];

export function checkCommandSafety(command: string): CommandSafetyResult {
  const matches: string[] = [];

  for (const rule of DANGEROUS_RULES) {
    if (rule.test(command)) {
      matches.push(rule.name);
    }
  }
  if (matches.length > 0) {
    const rule = DANGEROUS_RULES.find((r) => r.name === matches[0])!;
    return { verdict: "dangerous", reason: rule.reason, matches };
  }

  for (const rule of SUSPICIOUS_RULES) {
    if (rule.test(command)) {
      matches.push(rule.name);
    }
  }
  if (matches.length > 0) {
    const rule = SUSPICIOUS_RULES.find((r) => r.name === matches[0])!;
    return { verdict: "suspicious", reason: rule.reason, matches };
  }

  return { verdict: "safe", matches };
}

export function isCommandGuardEnabled(): boolean {
  const value = process.env.PACE_DISABLE_COMMAND_GUARD;
  return !(value === "1" || value === "true" || value === "yes");
}
