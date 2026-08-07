import { z } from "zod";
import { fetchWithRetry } from "../fetch-retry";
import { defineTool, throwIfAborted, type ToolOutput } from "./core";

// ─── Web Search ─────────────────────────────────────────────────────────────

const EXA_MCP_URL = "https://mcp.exa.ai/mcp";

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

    const response = await fetchWithRetry(
      EXA_MCP_URL,
      {
        method: "POST",
        signal,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "web_search_exa",
            arguments: { query, numResults },
          },
        }),
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

    if (data.error) {
      throw new Error(data.error.message ?? "Exa MCP request failed");
    }

    const output =
      typeof data.result?.content?.[0]?.text === "string"
        ? data.result.content[0].text
        : JSON.stringify(data, null, 2);

    return { content: [{ type: "text", text: output }] };
  },
});
