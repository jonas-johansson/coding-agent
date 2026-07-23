/**
 * git.ts — Fast git branch detection via direct .git file reads.
 *
 * Resolves the current branch by reading .git/HEAD instead of spawning a
 * git process, keeping startup and per-tool-call refreshes effectively free.
 * All I/O is synchronous and fails quietly (returns undefined) when the
 * directory is not inside a git work tree.
 */

import { readFileSync, statSync } from "fs";
import { dirname, isAbsolute, join as pathJoin, resolve as pathResolve } from "path";

const HEAD_REF_PREFIX = "ref: refs/heads/";
const DETACHED_SHORT_SHA_LENGTH = 7;

/** Locate the git dir for a work tree by walking up from `startDir`. */
function findGitDir(startDir: string): string | undefined {
  let dir = startDir;
  for (;;) {
    const dotGit = pathJoin(dir, ".git");
    let stat;
    try {
      stat = statSync(dotGit);
    } catch {
      stat = undefined;
    }
    if (stat?.isDirectory()) return dotGit;
    if (stat?.isFile()) {
      // Worktree or submodule: .git is a file containing "gitdir: <path>".
      try {
        const pointer = readFileSync(dotGit, "utf8").trim();
        const match = /^gitdir:\s*(.+)$/.exec(pointer);
        if (match) {
          const target = match[1].trim();
          return isAbsolute(target) ? target : pathResolve(dir, target);
        }
      } catch {
        return undefined;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Return the current branch name for the repo containing `cwd`, the short
 * SHA when HEAD is detached, or undefined when not inside a git work tree.
 */
export function getGitBranch(cwd: string): string | undefined {
  const gitDir = findGitDir(cwd);
  if (!gitDir) return undefined;
  let head: string;
  try {
    head = readFileSync(pathJoin(gitDir, "HEAD"), "utf8").trim();
  } catch {
    return undefined;
  }
  if (head.startsWith(HEAD_REF_PREFIX)) {
    const branch = head.slice(HEAD_REF_PREFIX.length);
    return branch.length > 0 ? branch : undefined;
  }
  if (/^[0-9a-f]{7,40}$/i.test(head)) return head.slice(0, DETACHED_SHORT_SHA_LENGTH);
  return undefined;
}
