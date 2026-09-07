/**
 * Tests for the OpenAI Responses-API provider, using a stubbed fetch.
 * Focus: metadata replay stays consistent with message content even when a
 * stream ends before emitting response.output_item.done for a function call.
 * Run with: npm test
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "module";
import type { ProviderMessage, ToolDefinition } from "@pace/llm";

// @pace/llm compiles to CommonJS without named ESM exports; use createRequire
// for the runtime class (type-only imports from the same package are fine).
const require = createRequire(import.meta.url);
const { OpenAIProvider } = require("@pace/llm/providers/openai") as {
  OpenAIProvider: new (opts?: { apiKey?: string }) => TestProvider;
};

interface TestProvider {
  stream(req: {
    model: string;
    system: string;
    messages: ProviderMessage[];
    tools: ToolDefinition[];
    maxTokens: number;
  }): Promise<{
    [Symbol.asyncIterator](): AsyncIterator<unknown>;
    finalMessage(): Promise<{
      content: Array<{ type: string; id?: string; name?: string }>;
      providerMetadata?: { outputItems: Array<{ type: string; call_id?: string }> };
    }>;
  }>;
}

function sse(events: Array<{ event: string; data: unknown }>): string {
  return events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join("");
}

/**
 * Stub global fetch. `responses` are served in order; captured request bodies
 * are pushed into `bodies`. Each response is an SSE event list.
 */
function captureFetch(bodies: unknown[], responses: string[]) {
  const originalFetch = globalThis.fetch;
  let call = 0;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(init?.body as string));
    const body = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

function makeProvider(): TestProvider {
  return new OpenAIProvider({ apiKey: "test-key" });
}

const tools: ToolDefinition[] = [
  {
    name: "write",
    description: "write a file",
    inputSchema: { type: "object", properties: { path: { type: "string" } } },
  },
];

test("incomplete stream still yields a tool_use and consistent replay metadata", async () => {
  const bodies: unknown[] = [];
  const restore = captureFetch(bodies, [
    // Stream starts a function call, streams arguments, then dies without
    // response.output_item.done or response.completed.
    sse([
      {
        event: "response.output_item.added",
        data: {
          type: "response.output_item.added",
          output_index: 0,
          item: { type: "function_call", id: "fc_1", call_id: "call_abc", name: "write", arguments: "" },
        },
      },
      {
        event: "response.function_call_arguments.delta",
        data: {
          type: "response.function_call_arguments.delta",
          item_id: "fc_1",
          output_index: 0,
          delta: '{"path":"x"}',
        },
      },
    ]),
  ]);

  try {
    const provider = makeProvider();
    const stream = await provider.stream({
      model: "gpt-test",
      system: "s",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      tools,
      maxTokens: 100,
    });
    for await (const _event of stream) {
      // drain
    }
    const message = await stream.finalMessage();

    // The tool call is surfaced via the completed-tool-calls fallback…
    const toolUse = message.content.find((b) => b.type === "tool_use");
    assert.ok(toolUse, "expected a tool_use content block");
    assert.equal(toolUse.id, "call_abc");

    // …and the replay metadata contains a matching function_call item.
    const metadataItems = message.providerMetadata?.outputItems ?? [];
    const functionCall = metadataItems.find((i) => i.type === "function_call");
    assert.ok(functionCall, "expected a function_call output item in metadata");
    assert.equal(functionCall.call_id, "call_abc");
  } finally {
    restore();
  }
});

test("replay synthesizes function_call items missing from persisted metadata", async () => {
  const bodies: unknown[] = [];
  const restore = captureFetch(bodies, [
    // Empty stream; we only care about the captured request body.
    sse([]),
  ]);

  try {
    const provider = makeProvider();
    // Simulate a session persisted before the stream adapter kept metadata
    // consistent: content has the tool_use, metadata lacks the function_call.
    const messages: ProviderMessage[] = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call_abc", name: "write", input: { path: "x" } }],
        providerMetadata: { provider: "openai", outputItems: [] },
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_abc", content: [{ type: "text", text: "done" }] },
        ],
      },
    ];

    const stream = await provider.stream({
      model: "gpt-test",
      system: "s",
      messages,
      tools,
      maxTokens: 100,
    });
    for await (const _event of stream) {
      // drain
    }
    await stream.finalMessage();

    const input = (bodies[0] as { input: Array<{ type: string; call_id?: string }> }).input;
    const callIds = input.filter((i) => i.type === "function_call").map((i) => i.call_id);
    assert.deepEqual(callIds, ["call_abc"], "expected a synthesized function_call before the output");

    const outputIndex = input.findIndex((i) => i.type === "function_call_output");
    const callIndex = input.findIndex((i) => i.type === "function_call");
    assert.ok(callIndex < outputIndex, "function_call must precede its function_call_output");
  } finally {
    restore();
  }
});
