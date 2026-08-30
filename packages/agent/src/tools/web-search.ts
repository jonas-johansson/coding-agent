import { z } from "zod";
import { delay, emitEvent, fetchWithRetry } from "@pace/llm";
import { defineTool, throwIfAborted, type ToolOutput } from "./core";

// ─── Web Search ─────────────────────────────────────────────────────────────

const EXA_MCP_URL = "https://mcp.exa.ai/mcp";
const MAX_RETRIES = 6;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30000;

// Exa reports rate limits either as JSON-RPC errors inside a 200 response or,
// worse, as a *successful* MCP result whose content text says the free MCP
// rate limit was hit. The HTTP-level 429 retry in fetchWithRetry never
// triggers for either, so we detect both shapes and retry the whole request.
function rateLimitMessage(data: {
  error?: { message?: string };
  result?: { content?: Array<{ text?: string }> };
}): string | null {
  const error = data.error?.message ?? "";
  if (error && /rate.?limit|too many requests|\b429\b/i.test(error)) {
    return error;
  }
  const content = data.result?.content?.[0]?.text ?? "";
  if (/rate.?limit|too many requests|\b429\b/i.test(content)) {
    return content;
  }
  return null;
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

      const rateLimitMsg = rateLimitMessage(data);

      if (data.error && !rateLimitMsg) {
        throw new Error(data.error.message ?? "Exa MCP request failed");
      }

      if (rateLimitMsg && attempt >= MAX_RETRIES) {
        throw new Error(
          `Exa rate limit persisted after ${MAX_RETRIES} retries with exponential backoff: ` +
            rateLimitMsg.slice(0, 200) +
            " — try again in a moment.",
        );
      }

      if (rateLimitMsg) {
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
