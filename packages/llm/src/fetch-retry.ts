/**
 * Shared fetch helper with automatic retry on rate-limit (429) responses.
 */

import { emitEvent } from "./events";

const MAX_RETRIES = 6;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30000;

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}

export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<Response> {
  let attempt = 0;
  while (true) {
    const response = await fetch(url, { ...init, signal });

    if (response.status !== 429) {
      return response;
    }

    if (attempt >= MAX_RETRIES) {
      throw new Error(
        `Rate limit (429) persisted after ${MAX_RETRIES} retries with exponential backoff. ` +
        `The server is still too busy — try again in a moment.`,
      );
    }

    // Honor Retry-After if present (seconds); otherwise exponential backoff + jitter.
    const retryAfter = response.headers.get("retry-after");
    let waitMs = retryAfter
      ? parseInt(retryAfter, 10) * 1000
      : Math.min(MAX_DELAY_MS, BASE_DELAY_MS * Math.pow(2, attempt));
    waitMs += Math.random() * 1000; // jitter

    emitEvent("rate-limit-retry", {
      url,
      attempt: attempt + 1,
      maxRetries: MAX_RETRIES,
      waitMs,
    });
    await delay(waitMs, signal);
    attempt++;
  }
}
