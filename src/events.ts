/**
 * Typed application event bus.
 *
 * Components emit events instead of writing to stderr so the TUI can
 * surface them in the status bar or as user-visible notifications.
 */

export type EventMap = {
  "rate-limit-retry": {
    url: string;
    attempt: number;
    maxRetries: number;
    waitMs: number;
  };
  "stream-retry": {
    attempt: number;
    maxRetries: number;
    waitMs: number;
    reason: string;
  };
};

// Stored loosely so different event payloads can share the map; the public
// API (onEvent/emitEvent) keeps payloads fully typed.
type AnyEventListener = (payload: any) => void;

const listeners: {
  [K in keyof EventMap]?: Set<AnyEventListener>;
} = {};

export function onEvent<K extends keyof EventMap>(
  type: K,
  listener: (payload: EventMap[K]) => void,
): () => void {
  const set = (listeners[type] ??= new Set());
  set.add(listener);
  return () => set.delete(listener);
}

export function emitEvent<K extends keyof EventMap>(
  type: K,
  payload: EventMap[K],
): void {
  const set = listeners[type];
  if (!set) return;
  for (const listener of set) {
    listener(payload);
  }
}
