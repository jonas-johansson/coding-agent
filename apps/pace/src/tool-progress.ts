/**
 * Streaming tool-call progress: while a tool call's arguments stream in from
 * the model (e.g. the content of a large `write`), append the number of bytes
 * received so far to the live tool title so the spinner shows progress.
 */

import { visualizeToolPartialTitle } from "@pace/agent";

/** Minimum interval between live title updates while arguments stream (ms). */
export const STREAM_TITLE_UPDATE_MS = 33;

export type StreamingToolTitleInput = {
  name: string;
  inputJson: string;
  inputBytes: number;
  showBytes: boolean;
};

/**
 * Live title for a tool call whose arguments are still streaming. Extends the
 * partial title with the streamed byte count.
 */
export function streamingToolTitle(input: StreamingToolTitleInput): string {
  const base = visualizeToolPartialTitle(input.name, input.inputJson);
  if (!input.showBytes) {
    return base;
  }
  return `${base} · ${input.inputBytes} B`;
}
