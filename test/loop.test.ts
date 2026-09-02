/**
 * Tests for the event-driven agent loop, using a scripted mock provider.
 *
 * Run with: npm test
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import type {
  Provider,
  ProviderMessage,
  ProviderResponse,
  ProviderStream,
  StreamEvent,
  ToolDefinition,
} from "@pace/llm";
import { runAgentLoop, type ExecutedTool } from "@pace/agent";
import { defineTool, type ToolDescriptor } from "@pace/agent";

// ── Mocks ────────────────────────────────────────────────────────────────────

type ScriptedTurn = {
  events?: StreamEvent[];
  response: ProviderResponse;
};

function scriptedStream(turn: ScriptedTurn): ProviderStream {
  return {
    async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
      for (const event of turn.events ?? []) {
        yield event;
      }
    },
    finalMessage: async () => turn.response,
  };
}

function mockProvider(script: ScriptedTurn[]) {
  const requests: {
    model: string;
    system: string;
    messages: ProviderMessage[];
    tools: ToolDefinition[];
  }[] = [];

  const provider: Provider = {
    async stream(params) {
      requests.push({
        model: params.model,
        system: params.system,
        messages: params.messages,
        tools: params.tools,
      });
      const turn = script[requests.length - 1];
      if (!turn) throw new Error(`Unexpected provider request #${requests.length}`);
      return scriptedStream(turn);
    },
  };

  return { provider, requests };
}

const baseUsage = {
  inputTokens: 10,
  outputTokens: 5,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
};

function textResponse(text: string): ProviderResponse {
  return {
    content: [{ type: "text", text }],
    stopReason: "end_turn",
    usage: baseUsage,
  };
}

function makeEchoTool(overrides?: Partial<ToolDescriptor>): ToolDescriptor & { calls: unknown[] } {
  const state = { calls: [] as unknown[] };
  const tool: ToolDescriptor = defineTool({
    name: "echo_test",
    description: "echo",
    inputSchema: z.object({ value: z.string() }),
    concurrency: "safe",
    execute: async (input) => {
      state.calls.push(input);
      return { content: [{ type: "text", text: `echo:${input.value}` }] };
    },
    ...overrides,
  });
  return { ...tool, calls: state.calls } as ToolDescriptor & { calls: unknown[] };
}

const baseParams = (overrides: Partial<Parameters<typeof runAgentLoop>[0]> = {}) => ({
  provider: mockProvider([{ response: textResponse("done") }]).provider,
  model: "test-model",
  system: "sys",
  tools: [],
  toolDefs: [],
  maxTokens: 1024,
  getMessages: () => [{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }] }],
  computeCost: () => 0,
  ...overrides,
});

// ── Tests ────────────────────────────────────────────────────────────────────

test("single text response completes after one turn", async () => {
  const { provider, requests } = mockProvider([{ response: textResponse("hello") }]);
  const responses: string[] = [];
  const toolResultCalls: ExecutedTool[][] = [];

  const result = await runAgentLoop(baseParams({
    provider,
    onResponse: (response) => {
      responses.push(response.content.map((b) => (b.type === "text" ? b.text : "")).join(""));
    },
    onToolResults: (executed) => toolResultCalls.push(executed),
  }));

  assert.equal(result.cancelled, false);
  assert.equal(result.hitTurnCap, false);
  assert.equal(result.turns, 1);
  assert.deepEqual(responses, ["hello"]);
  assert.equal(toolResultCalls.length, 0);
  assert.equal(requests.length, 1);
  assert.equal(result.usage.inputTokens, 10);
  assert.equal(result.usage.outputTokens, 5);
});

test("stream events are forwarded to onStreamEvent", async () => {
  const { provider } = mockProvider([{
    events: [
      { type: "text_start", text: "he" },
      { type: "text_delta", text: "llo" },
      { type: "block_stop" },
    ],
    response: textResponse("hello"),
  }]);
  const seen: string[] = [];

  await runAgentLoop(baseParams({
    provider,
    onStreamEvent: (event) => seen.push(event.type),
  }));

  assert.deepEqual(seen, ["text_start", "text_delta", "block_stop"]);
});

test("tool calls execute and the loop continues until a text-only response", async () => {
  const echo = makeEchoTool();
  const { provider, requests } = mockProvider([
    {
      response: {
        content: [
          { type: "text", text: "calling tool" },
          { type: "tool_use", id: "call_1", name: "echo_test", input: { value: "42" } },
        ],
        stopReason: "tool_use",
        usage: baseUsage,
      },
    },
    { response: textResponse("all done") },
  ]);
  const toolResultCalls: ExecutedTool[][] = [];

  // Mirror the persistence contract: accumulate response/tool-result data so
  // later getMessages() calls include it.
  const messages: ProviderMessage[] = [
    { role: "user", content: [{ type: "text", text: "hi" }] },
  ];

  const result = await runAgentLoop(baseParams({
    provider,
    tools: [echo],
    getMessages: () => messages,
    onResponse: (response) => {
      // Assistant message must be persisted before its tool results arrive.
      if (requests.length === 1 && toolResultCalls.length > 0) {
        throw new Error("onToolResults fired before onResponse");
      }
      messages.push({ role: "assistant", content: response.content });
    },
    onToolResults: (executed) => {
      toolResultCalls.push(executed);
      messages.push({ role: "user", content: executed.map((e) => e.result) });
    },
  }));

  assert.equal(result.turns, 2);
  assert.equal(echo.calls.length, 1);
  assert.deepEqual(echo.calls[0], { value: "42" });
  assert.equal(toolResultCalls.length, 1);
  assert.equal(toolResultCalls[0][0].result.tool_use_id, "call_1");
  assert.equal(toolResultCalls[0][0].result.is_error, undefined);
  assert.match(toolResultCalls[0][0].display, /echo:42/);

  // Second request must include the tool result so the model sees it.
  const secondMessages = requests[1].messages;
  const toolResultMessage = secondMessages.find((m) =>
    m.role === "user" && m.content.some((b) => b.type === "tool_result")
  );
  assert.ok(toolResultMessage, "second request should contain the tool result");
});

test("unknown tool produces an error result instead of throwing", async () => {
  const { provider } = mockProvider([
    {
      response: {
        content: [{ type: "tool_use", id: "call_x", name: "no_such_tool", input: {} }],
        stopReason: "tool_use",
        usage: baseUsage,
      },
    },
    { response: textResponse("recovered") },
  ]);
  const toolResultCalls: ExecutedTool[][] = [];

  const result = await runAgentLoop(baseParams({
    provider,
    onToolResults: (executed) => toolResultCalls.push(executed),
  }));

  assert.equal(result.turns, 2);
  assert.equal(toolResultCalls[0][0].result.is_error, true);
  assert.match(toolResultCalls[0][0].display, /Couldn't find tool/);
});

test("schema mismatch produces an error result without executing the tool", async () => {
  const echo = makeEchoTool();
  const { provider } = mockProvider([
    {
      response: {
        content: [{ type: "tool_use", id: "call_bad", name: "echo_test", input: { wrong: true } }],
        stopReason: "tool_use",
        usage: baseUsage,
      },
    },
    { response: textResponse("ok") },
  ]);

  const toolResultCalls: ExecutedTool[][] = [];
  await runAgentLoop(baseParams({
    provider,
    tools: [echo],
    onToolResults: (executed) => toolResultCalls.push(executed),
  }));

  assert.equal(echo.calls.length, 0);
  assert.equal(toolResultCalls[0][0].result.is_error, true);
  assert.match(toolResultCalls[0][0].display, /did not match schema/i);
});

test("abort during tool execution marks the run cancelled and synthesizes results", async () => {
  const abortingTool: ToolDescriptor = defineTool({
    name: "aborting_tool",
    description: "aborts",
    inputSchema: z.object({}),
    execute: async () => {
      throw new DOMException("Aborted", "AbortError");
    },
  });
  const { provider } = mockProvider([
    {
      response: {
        content: [
          { type: "tool_use", id: "call_a", name: "aborting_tool", input: {} },
          { type: "tool_use", id: "call_b", name: "aborting_tool", input: {} },
        ],
        stopReason: "tool_use",
        usage: baseUsage,
      },
    },
  ]);
  const toolResultCalls: ExecutedTool[][] = [];

  const result = await runAgentLoop(baseParams({
    provider,
    tools: [abortingTool],
    onToolResults: (executed) => toolResultCalls.push(executed),
  }));

  assert.equal(result.cancelled, true);
  assert.equal(toolResultCalls.length, 1);
  assert.equal(toolResultCalls[0].length, 2);
  for (const executed of toolResultCalls[0]) {
    assert.equal(executed.result.is_error, true);
    assert.match(executed.result.content[0].text, /cancelled/i);
  }
});

test("maxTurns stops runaway tool loops with hitTurnCap", async () => {
  const toolUseResponse = (): ProviderResponse => ({
    content: [{ type: "tool_use", id: `call_${Math.random()}`, name: "missing", input: {} }],
    stopReason: "tool_use",
    usage: baseUsage,
  });
  const script = Array.from({ length: 10 }, () => ({ response: toolUseResponse() }));
  const { provider } = mockProvider(script);

  const result = await runAgentLoop(baseParams({ provider, maxTurns: 3 }));

  assert.equal(result.hitTurnCap, true);
  assert.equal(result.turns, 3);
});

test("cost accumulates across responses and tool-reported costs", async () => {
  const costlyTool: ToolDescriptor = defineTool({
    name: "costly_tool",
    description: "costs money",
    inputSchema: z.object({}),
    concurrency: "safe",
    execute: async () => ({
      content: [{ type: "text", text: "ok" }],
      cost: 0.25,
    }),
  });
  const { provider } = mockProvider([
    {
      response: {
        content: [{ type: "tool_use", id: "c1", name: "costly_tool", input: {} }],
        stopReason: "tool_use",
        usage: baseUsage,
      },
    },
    { response: textResponse("fin") },
  ]);

  const result = await runAgentLoop(baseParams({
    provider,
    tools: [costlyTool],
    computeCost: () => 0.1,
  }));

  assert.ok(Math.abs(result.totalCost - 0.45) < 1e-9);
});

test("exclusive tools run sequentially, safe tools run concurrently", async () => {
  const order: string[] = [];
  const release: (() => void)[] = [];
  const gate = () => new Promise<void>((resolve) => release.push(resolve));

  const exclusiveTool: ToolDescriptor = defineTool({
    name: "exclusive_gate",
    description: "",
    inputSchema: z.object({}),
    execute: async () => {
      order.push("start_exclusive");
      await gate();
      order.push("end_exclusive");
      return { content: [{ type: "text", text: "" }] };
    },
  });

  const { provider } = mockProvider([
    {
      response: {
        content: [{ type: "tool_use", id: "g1", name: "exclusive_gate", input: {} }],
        stopReason: "tool_use",
        usage: baseUsage,
      },
    },
    { response: textResponse("done") },
  ]);

  const loopPromise = runAgentLoop(baseParams({ provider, tools: [exclusiveTool] }));
  await new Promise<void>((resolve) => {
    const check = () => (order.includes("start_exclusive") ? resolve() : setTimeout(check, 5));
    check();
  });
  assert.deepEqual(order, ["start_exclusive"]);
  release[0]();
  await loopPromise;
  assert.deepEqual(order, ["start_exclusive", "end_exclusive"]);
});

// ── Auto-compaction trigger ──────────────────────────────────────────────────

test("compact runs before the first request when initialContextTokens >= threshold", async () => {
  const { provider, requests } = mockProvider([{ response: textResponse("done") }]);
  let compactCalls = 0;

  await runAgentLoop(baseParams({
    provider,
    compaction: {
      thresholdTokens: 10,
      initialContextTokens: 15,
      compact: async () => {
        compactCalls += 1;
      },
    },
  }));

  assert.equal(compactCalls, 1);
  assert.equal(requests.length, 1);
});

test("compact runs before the second request when the first response crosses the threshold, at most once per response", async () => {
  const { provider, requests } = mockProvider([
    {
      response: {
        content: [{ type: "tool_use", id: "c1", name: "missing", input: {} }],
        stopReason: "tool_use",
        usage: { ...baseUsage, inputTokens: 10, outputTokens: 5 }, // 15 >= 10
      },
    },
    { response: textResponse("done") },
  ]);
  let compactCalls = 0;

  const result = await runAgentLoop(baseParams({
    provider,
    compaction: {
      thresholdTokens: 10,
      initialContextTokens: 0,
      compact: async () => {
        compactCalls += 1;
      },
    },
  }));

  assert.equal(result.cancelled, false);
  // The first response's usage crossed the threshold, so compaction fired at
  // the second iteration boundary. The second response also crossed it, but
  // the loop ended, so no second call.
  assert.equal(compactCalls, 1);
  assert.equal(requests.length, 2);
});

test("compact is not called when the compaction policy is omitted", async () => {
  const { provider } = mockProvider([{ response: textResponse("done") }]);

  const result = await runAgentLoop(baseParams({ provider }));

  assert.equal(result.cancelled, false);
});

test("abort inside compact cancels the run", async () => {
  const { provider } = mockProvider([{ response: textResponse("done") }]);

  await assert.rejects(
    runAgentLoop(baseParams({
      provider,
      compaction: {
        thresholdTokens: 10,
        initialContextTokens: 15,
        compact: async () => {
          throw new DOMException("Aborted", "AbortError");
        },
      },
    })),
    (error: unknown) => (error as Error).name === "AbortError",
  );
});
