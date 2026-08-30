import { z } from "zod";
import { delay, emitEvent, fetchWithRetry } from "@pace/llm";
import { defineTool, throwIfAborted, type ToolOutput } from "./core";

// ─── Web Search ─────────────────────────────────────────────────────────────

const EXA_MCP_URL = "https://mcp.exa.ai/mcp";
const MAX_RETRIES = 6;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30000;

// Exa reports rate limits as JSON-RPC errors inside a 200 response, so the
// HTTP-level 429 retry in fetchWithRetry never triggers for those. We detect
// rate-limit errors in the MCP payload (or a non-429 "429" status string) and
// retry the whole request ourselves.
function isRateLimitError(data: unknown): boolean {
  const message =
    (data as { error?: { message?: string } } | null)?.error?.message ?? "";
  return /rate.?limit|too many requests|\b429\b/i.test(message);
}

function parseSsePayload(text: string): unknown {
  const payloads = text
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice(6).trim())
    .filter((line) => line.length > 0 && line !== "[DONE]")
    .map((line) => JSON.parse(line));

  if (payloads.length === 0) {
    throw new Error("No data in Exa MCP response");
  }

  return payloads.at(-1);
}

export const webSearchTool = defineTool({
  name: "websearch",
  concurrency: "safe",
  description:
    "Search the web for current information, news, facts, or any topic.",
  inputSchema: z.object({
    query: z.string().describe("The search query"),
    numResults: z
      .number()
      .int()
      .positive()
      .optional()
      .default(5)
      .describe("Number of results to return (default 5)"),
  }),
  truncateOutput: false,
  showContent: false,
  titleFormatter: (input) => `websearch: ${input.query ?? ""}`,
  execute: async (input, signal): Promise<ToolOutput> => {
    throwIfAborted(signal);
    const { query, numResults } = input;

    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "web_search_exa",
        arguments: { query, numResults },
      },
    });

    let attempt = 0;
    while (true) {
      const response = await fetchWithRetry(
        EXA_MCP_URL,
        {
          method: "POST",
          signal,
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
          },
          body,
        },
        signal,
      );

      const text = await response.text();

      if (!response.ok) {
        throw new Error(
          `Exa MCP request failed with status ${response.status}: ${text.slice(0, 500)}`,
        );
      }

      const data = parseSsePayload(text) as {
        error?: { message?: string };
        result?: { content?: Array<{ text?: string }> };
      };

      if (data.error && !isRateLimitError(data)) {
        throw new Error(data.error.message ?? "Exa MCP request failed");
      }

      if (data.error && attempt >= MAX_RETRIES) {
        throw new Error(
          `Exa rate limit persisted after ${MAX_RETRIES} retries with exponential backoff: ` +
            (data.error.message ?? "rate limited") +
            " — try again in a moment.",
        );
      }

      if (data.error) {
        const waitMs =
          Math.min(MAX_DELAY_MS, BASE_DELAY_MS * Math.pow(2, attempt)) +
          Math.random() * 1000;
        emitEvent("rate-limit-retry", {
          url: EXA_MCP_URL,
          attempt: attempt + 1,
          maxRetries: MAX_RETRIES,
          waitMs,
        });
        await delay(waitMs, signal);
        attempt++;
        continue;
      }

      const output =
        typeof data.result?.content?.[0]?.text === "string"
          ? data.result.content[0].text
          : JSON.stringify(data, null, 2);

      return { content: [{ type: "text", text: output }] };
    }
  },
});
