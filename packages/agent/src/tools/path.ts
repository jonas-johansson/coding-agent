import { homedir } from "os";
import { resolve, relative } from "path";

/**
 * Expand leading `~` in paths the same way users expect from shells.
 * Node's fs APIs do not do this automatically, so without this helper a path
 * like `~/Downloads/file.md` would create a local `~` directory under cwd.
 */
export function expandHomePath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return path;
}

/**
 * Normalize a file path for display: expand `~`, resolve it against cwd, then
 * make it relative so that both `./tool.ts` and `/home/user/project/tool.ts`
 * are displayed as `tool.ts`.
 */
export function normalizePath(path: string): string {
  return relative(process.cwd(), resolve(expandHomePath(path))) || ".";
}
