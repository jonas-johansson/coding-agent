import { spawn } from "child_process";

/**
 * Fires a non-blocking Ubuntu desktop notification via notify-send.
 * Silently does nothing if notify-send is unavailable or the call fails.
 */
export function sendDesktopNotification(summary: string, body?: string): void {
  const args = [summary];
  if (body) args.push(body);
  try {
    const child = spawn("notify-send", args, {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } catch {
    // notify-send not installed or failed — ignore silently
  }
}
