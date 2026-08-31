/**
 * Tests for the headless runner (`pace run`), using a scripted mock provider.
 *
 * Run with: npm test (build first: npm run build)
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir, readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { PassThrough } from "stream";
import type {
  Provider,
  ProviderResponse,
  ProviderStream,
  StreamEvent,
  ToolDefinition,
} from "@pace/llm";
import { parseHeadlessArgs, runHeadless } from "../apps/pace/dist/headless.js";
import { createProjectKey } from "@pace/agent";

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
    system: string;
    messages: { role: string; content: unknown[] }[];
    tools: ToolDefinition[];
  }[] = [];

  const provider: Provider = {
    async stream(params) {
      requests.push({
        system: params.system,
        messages: params.messages.map((m) => ({ role: m.role, content: m.content as unknown[] })),
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
  return { content: [{ type: "text", text }], stopReason: "end_turn", usage: baseUsage };
}

function toolUseResponse(name: string, input: Record<string, unknown>, id: string): ProviderResponse {
  return {
    content: [{ type: "tool_use", id, name, input }],
    stopReason: "tool_use",
    usage: baseUsage,
  };
}

// ── Arg parsing ──────────────────────────────────────────────────────────────

test("parseHeadlessArgs parses flags, = values, and a positional prompt", () => {
  const args = parseHeadlessArgs([
    "do the thing",
    "--output-format=stream-json",
    "--model", "fireworks/glm-5.3:max",
    "--max-turns", "5",
    "-p", "override",
  ]);
  assert.equal(args.outputFormat, "stream-json");
  assert.equal(args.model, "fireworks/glm-5.3:max");
  assert.equal(args.maxTurns, 5);
  assert.equal(args.promptText, "override");
  assert.deepEqual(args.positional, ["do the thing"]);
});

test("parseHeadlessArgs rejects --session with --continue", () => {
  assert.throws(() => parseHeadlessArgs(["--session", "abc", "--continue"]));
});

test("parseHeadlessArgs rejects invalid output format", () => {
  assert.throws(() => parseHeadlessArgs(["--output-format", "yaml"]));
});

test("parseHeadlessArgs rejects unknown options and missing values", () => {
  assert.throws(() => parseHeadlessArgs(["--nope"]));
  assert.throws(() => parseHeadlessArgs(["--model"]));
});

test("parseHeadlessArgs rejects multiple positional prompts", () => {
  assert.throws(() => parseHeadlessArgs(["one", "two"]));
});

// ── Headless runs ────────────────────────────────────────────────────────────

// Redirect HOME so session writes land in a temp dir instead of ~/.pace.
let fakeHome: string;
const realHome = process.env.HOME;

beforeEach(async () => {
  fakeHome = await mkdtemp(join(tmpdir(), "pace-headless-test-"));
  process.env.HOME = fakeHome;
});

afterEach(async () => {
  if (realHome !== undefined) process.env.HOME = realHome;
  await rm(fakeHome, { recursive: true, force: true });
});

type Io = {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
  provider: Provider;
};

function makeIo(provider: Provider): Io {
  return {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    provider,
  };
}

async function collectOutput(stream: PassThrough): Promise<string> {
  const chunks: Buffer[] = [];
  stream.on("data", (chunk) => chunks.push(chunk));
  await new Promise((resolve) => stream.on("end", resolve) as unknown as never);
  // Give pending 'data' handlers a tick to flush.
  await new Promise((resolve) => setImmediate(resolve));
  return Buffer.concat(chunks).toString("utf8");
}

function startCollecting(stream: PassThrough): () => Promise<string> {
  const chunks: Buffer[] = [];
  stream.on("data", (chunk) => chunks.push(chunk));
  return async () => {
    stream.end();
    await new Promise((resolve) => setImmediate(resolve));
    return Buffer.concat(chunks).toString("utf8");
  };
}

async function readSessionFile(sessionId: string): Promise<Record<string, unknown>> {
  const projectDir = join(fakeHome, ".pace", "sessions", createProjectKey(process.cwd()));
  const raw = await readFile(join(projectDir, `${sessionId}.json`), "utf8");
  return JSON.parse(raw) as Record<string, unknown>;
}

test("text output prints the assistant text and saves the session", async () => {
  const { provider } = mockProvider([
    {
      events: [
        { type: "text_start", text: "Hel" },
        { type: "text_delta", text: "lo " },
        { type: "text_delta", text: "world" },
      ],
      response: textResponse("Hello world"),
    },
  ]);
  const io = makeIo(provider);
  const readStdout = startCollecting(io.stdout);
  const code = await runHeadless(["--output-format", "text", "Say hi"], io);
  assert.equal(code, 0);
  const out = await readStdout();
  assert.equal(out, "Hello world\n");
});

test("stream-json emits system, deltas, usage, and result events", async () => {
  const { provider } = mockProvider([
    {
      events: [
        { type: "text_start", text: "H" },
        { type: "text_delta", text: "i" },
      ],
      response: textResponse("Hi"),
    },
  ]);
  const io = makeIo(provider);
  const readStdout = startCollecting(io.stdout);
  const code = await runHeadless(["--output-format", "stream-json", "Say hi"], io);
  assert.equal(code, 0);

  const lines = (await readStdout()).trim().split("\n").map((line) => JSON.parse(line) as { type: string });
  assert.deepEqual(lines.map((l) => l.type), ["system", "text_delta", "text_delta", "usage", "result"]);

  const result = lines.at(-1) as { text: string; turns: number; stopReason: string; session: string };
  assert.equal(result.text, "Hi");
  assert.equal(result.turns, 1);
  assert.equal(result.stopReason, "end");

  // The session file must exist with the user + assistant entries.
  const session = await readSessionFile(result.session);
  const entries = session.entries as Array<{ type: string }>;
  assert.deepEqual(entries.map((e) => e.type), ["user", "assistant"]);
});

test("json output emits a single result object", async () => {
  const { provider } = mockProvider([{ response: textResponse("done") }]);
  const io = makeIo(provider);
  const readStdout = startCollecting(io.stdout);
  const code = await runHeadless(["--output-format", "json", "work"], io);
  assert.equal(code, 0);
  const parsed = JSON.parse(await readStdout()) as { text: string; stopReason: string };
  assert.equal(parsed.text, "done");
  assert.equal(parsed.stopReason, "end");
});

test("tool calls emit tool events and persist tool results", async () => {
  const { provider, requests } = mockProvider([
    {
      events: [
        { type: "tool_use_start", id: "tool-1", name: "read" },
        { type: "tool_input_delta", id: "tool-1", partialJson: '{"path":"README.md"}' },
        { type: "block_stop", id: "tool-1" },
      ],
      response: toolUseResponse("read", { path: "README.md" }, "tool-1"),
    },
    { response: textResponse("read it") },
  ]);
  const io = makeIo(provider);
  const readStdout = startCollecting(io.stdout);
  const code = await runHeadless(["--output-format", "stream-json", "read the readme"], io);
  assert.equal(code, 0);

  const lines = (await readStdout()).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  const types = lines.map((l) => l.type);
  assert.ok(types.includes("tool_start"));
  assert.ok(types.includes("tool_input"));
  assert.ok(types.includes("tool_end"));
  const toolInput = lines.find((l) => l.type === "tool_input") as { input: { path: string } };
  assert.equal(toolInput.input.path, "README.md");

  // The second provider request must contain the tool result message.
  assert.equal(requests.length, 2);
  const secondRequestMessages = requests[1].messages;
  const toolResultMessage = secondRequestMessages.find((m) => m.role === "user" && Array.isArray(m.content)
    && m.content.some((b) => (b as { type?: string }).type === "tool_result"));
  assert.ok(toolResultMessage, "tool result message missing from follow-up request");

  const result = lines.at(-1) as { session: string };
  const session = await readSessionFile(result.session);
  const entryTypes = (session.entries as Array<{ type: string }>).map((e) => e.type);
  assert.deepEqual(entryTypes, ["user", "assistant", "tool_result", "assistant"]);
});

test("--session continues an existing session with full history", async () => {
  const first = mockProvider([{ response: textResponse("first answer") }]);
  const io1 = makeIo(first.provider);
  const read1 = startCollecting(io1.stdout);
  await runHeadless(["--output-format", "json", "first question"], io1);
  const result1 = JSON.parse(await read1()) as { session: string };

  const second = mockProvider([{ response: textResponse("second answer") }]);
  const io2 = makeIo(second.provider);
  const read2 = startCollecting(io2.stdout);
  const code = await runHeadless(["--output-format", "json", "--session", result1.session, "second question"], io2);
  assert.equal(code, 0);
  const result2 = JSON.parse(await read2()) as { session: string; text: string };
  assert.equal(result2.session, result1.session);
  assert.equal(result2.text, "second answer");

  // The second run's provider request must include the first exchange.
  const roles = second.requests[0].messages.map((m) => m.role);
  assert.deepEqual(roles, ["user", "assistant", "user"]);

  const session = await readSessionFile(result1.session);
  const entryTypes = (session.entries as Array<{ type: string }>).map((e) => e.type);
  assert.deepEqual(entryTypes, ["user", "assistant", "user", "assistant"]);
});

test("--max-turns reports turn cap with exit code 2", async () => {
  const { provider } = mockProvider([
    { response: toolUseResponse("read", { path: "a" }, "t1") },
    { response: toolUseResponse("read", { path: "b" }, "t2") },
  ]);
  const io = makeIo(provider);
  const readStdout = startCollecting(io.stdout);
  const code = await runHeadless(["--output-format", "json", "--max-turns", "1", "loop forever"], io);
  assert.equal(code, 2);
  const result = JSON.parse(await readStdout()) as { stopReason: string };
  assert.equal(result.stopReason, "turn_cap");
});

test("--append-system appends extra system text", async () => {
  const { provider, requests } = mockProvider([{ response: textResponse("ok") }]);
  const io = makeIo(provider);
  await runHeadless(["--append-system", "Always reply in pirate speak.", "hi"], io);
  assert.ok(requests[0].system.includes("Always reply in pirate speak."));
  assert.ok(requests[0].system.includes("You are Pace"));
});

test("missing prompt fails with exit code 1", async () => {
  const { provider } = mockProvider([]);
  const io = makeIo(provider);
  // TTY stdin so no piped prompt is detected.
  (io.stdin as unknown as { isTTY: boolean }).isTTY = true;
  const readStderr = startCollecting(io.stderr);
  const code = await runHeadless([], io);
  assert.equal(code, 1);
  assert.ok((await readStderr()).includes("no prompt provided"));
});

test("unknown model fails with exit code 1", async () => {
  const { provider } = mockProvider([]);
  const io = makeIo(provider);
  const readStderr = startCollecting(io.stderr);
  const code = await runHeadless(["--model", "nope/does-not-exist", "hi"], io);
  assert.equal(code, 1);
  assert.ok((await readStderr()).includes("unknown model"));
});

test("--steering-stdin injects steering between turns", async () => {
  const { provider, requests } = mockProvider([
    { response: toolUseResponse("read", { path: "a" }, "t1") },
    { response: textResponse("steered") },
  ]);
  const io = makeIo(provider);
  const readStdout = startCollecting(io.stdout);

  // Queue a steering message while the first turn runs.
  const run = runHeadless(
    ["--output-format", "stream-json", "--steering-stdin", "start"],
    io,
  );
  io.stdin.write(`${JSON.stringify({ type: "steer", text: "use the other file" })}\n`);
  const code = await run;
  assert.equal(code, 0);
  await readStdout();

  // The second provider request must include the steering user message.
  const secondMessages = requests[1].messages;
  const hasSteering = secondMessages.some(
    (m) => m.role === "user" && Array.isArray(m.content)
      && m.content.some((b) => (b as { type?: string; text?: string }).type === "text"
        && (b as { text?: string }).text === "use the other file"),
  );
  assert.ok(hasSteering, "steering message missing from second request");
});

test("sessions are stored under the project key for the cwd", async () => {
  const { provider } = mockProvider([{ response: textResponse("ok") }]);
  const io = makeIo(provider);
  const readStdout = startCollecting(io.stdout);
  await runHeadless(["--output-format", "json", "hi"], io);
  const result = JSON.parse(await readStdout()) as { session: string };

  const sessionsDir = join(fakeHome, ".pace", "sessions", createProjectKey(process.cwd()));
  const files = await readdir(sessionsDir);
  assert.ok(files.includes(`${result.session}.json`));
});
