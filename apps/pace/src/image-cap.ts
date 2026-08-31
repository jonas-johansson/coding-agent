/**
 * Provider-request image budgeting, shared by the TUI and headless runners.
 *
 * Keeps the newest images within a base64 byte budget and replaces older
 * images with text placeholders. Non-destructive: saved session history
 * keeps the original image data, while outbound provider requests avoid
 * accumulating screenshots forever.
 */

import type { ImageBlock, ProviderMessage } from "@pace/llm";

/** Anthropic total request limit in bytes. */
export const MAX_REQUEST_BYTES = 10 * 1024 * 1024;
export const REQUEST_IMAGE_PAYLOAD_WARNING_RATIO = 0.8;

const OMITTED_IMAGE_PLACEHOLDER = "[older image omitted to keep the provider request under the size limit]";

export type ImageCapResult = {
  messages: ProviderMessage[];
  droppedImages: number;
  droppedBytes: number;
};

export function estimateBase64Size(rawBytes: number): number {
  return Math.ceil(rawBytes / 3) * 4;
}

export function capProviderMessageImages(
  messages: readonly ProviderMessage[],
  budgetBytes: number,
): ImageCapResult {
  const imagesToDrop = new Set<ImageBlock>();
  let keptBytes = 0;
  let droppedBytes = 0;

  for (let msgIndex = messages.length - 1; msgIndex >= 0; msgIndex--) {
    const msg = messages[msgIndex];
    if (msg.role !== "user") {
      continue;
    }

    for (let blockIndex = msg.content.length - 1; blockIndex >= 0; blockIndex--) {
      const block = msg.content[blockIndex];
      if (block.type === "image") {
        if (keptBytes + block.data.length <= budgetBytes) {
          keptBytes += block.data.length;
        } else {
          imagesToDrop.add(block);
          droppedBytes += block.data.length;
        }
      } else if (block.type === "tool_result") {
        for (let partIndex = block.content.length - 1; partIndex >= 0; partIndex--) {
          const part = block.content[partIndex];
          if (part.type !== "image") {
            continue;
          }
          if (keptBytes + part.data.length <= budgetBytes) {
            keptBytes += part.data.length;
          } else {
            imagesToDrop.add(part);
            droppedBytes += part.data.length;
          }
        }
      }
    }
  }

  if (imagesToDrop.size === 0) {
    return { messages: [...messages], droppedImages: 0, droppedBytes: 0 };
  }

  const cappedMessages = messages.map((msg): ProviderMessage => {
    if (msg.role !== "user") {
      return msg;
    }

    let changed = false;
    const content = msg.content.map((block) => {
      if (block.type === "image" && imagesToDrop.has(block)) {
        changed = true;
        return { type: "text" as const, text: OMITTED_IMAGE_PLACEHOLDER };
      }

      if (block.type === "tool_result") {
        let toolResultChanged = false;
        const toolResultContent = block.content.map((part) => {
          if (part.type === "image" && imagesToDrop.has(part)) {
            toolResultChanged = true;
            return { type: "text" as const, text: OMITTED_IMAGE_PLACEHOLDER };
          }
          return part;
        });

        if (toolResultChanged) {
          changed = true;
          return { ...block, content: toolResultContent };
        }
      }

      return block;
    });

    return changed ? { ...msg, content } : msg;
  });

  return { messages: cappedMessages, droppedImages: imagesToDrop.size, droppedBytes };
}
