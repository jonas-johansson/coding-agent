/**
 * Headless (non-interactive) runner: `pace run`.
 *
 * Runs one or more agent turns without the TUI, reusing the exact same
 * wiring as the interactive app: AGENTS.md + skills + MCP system prompt,
 * tool registry, subagent runtime, and session persistence. Output goes to
 * stdout as plain text, a final JSON object, or a stream of NDJSON events.
 *
 * This is the automation surface used by scripts, CI, and orchestrators
 * such as `flow`.
 */

import { readFile } from "fs/promises";
import { createInterface } from "readline";
import type { Readable, Writable } from "stream";
import {
  appendTurnDraftEntry,
  commitTurnDraft,
  createProjectKey,
  createSession,
  createAssistantEntry,
  createToolResultEntry,
  createTurnDraft,
  createUserEntry,
  discoverAgents,
  discoverSkills,
  formatSkillsSystemPromptBlock,
  getActivePath,
  getConnectedMcpServers,
  initMcpServers,
  isAbortError,
  listSessions,
  loadSession,
  runAgentLoop,
  saveSession,
  sessionToProviderMessages,
  setCurrentAgents,
  setCurrentSkills,
  setAgentRuntime,
  shutdownMcpServers,
  tools,
  getProviderToolDefinitions,
  isTurnDraftEmpty,
  type Session,
  type ThinkingBlock,
} from "@pace/agent";
import {
  DEFAULT_MODEL_ID,
  getModelConfig,
  getModelVariant,
  getModels,
  loadCachedModelCatalog,
  parseModelSelection,
  resolveProvider,
  type ModelConfig,
  type ModelVariant,
  type Provider,
  type StreamEvent,
} from "@pace/llm";
import { loadPreferences } from "./preferences";
import { loadPaceConfig } from "./config";
import {
  assembleSystemText,
  computeCallCost,
  makeSubagentRuntime,
  loadAgentsFile,
  loadGlobalAgentsFile,
} from "./agent-context";
import {
  MAX_REQUEST_BYTES,
  REQUEST_IMAGE_PAYLOAD_WARNING_RATIO,
  capProviderMessageImages,
} from "./image-cap";

// ── CLI surface ──────────────────────────────────────────────────────────────

export const HEADLESS_USAGE = `Usage: pace run [prompt] [options]

Runs the Pace agent non-interactively. The prompt comes from a positional
argument, --prompt, --prompt-file, or piped stdin.

Options:
  -p, --prompt <text>       Prompt text
  --prompt-file <path>      Read the prompt from a file
  --session <id>            Continue an existing session
  --continue                Continue the most recent session for this project
  --model <id[:variant]>    Model selection, e.g. fireworks/glm-5.3:max
  --output-format <format>  text | json | stream-json   (default: text)
  --max-turns <n>           Cap the number of assistant turns
  --append-system <text>    Append extra system text (or @file to read a file)
  --steering-stdin          Read NDJSON steering messages from stdin while
                            running: {"type":"steer","text":"..."}
  -h, --help                Show this help

Exit codes: 0 finished, 1 error, 2 turn cap reached, 130 cancelled.`;

type OutputFormat = "text" | "json" | "stream-json";

export type HeadlessArgs = {
  promptText?: string;
  promptFile?: string;
  sessionId?: string;
  continueLatest: boolean;
  model?: string;
  outputFormat: OutputFormat;
  maxTurns?: number;
  appendSystem?: string;
  steeringStdin: boolean;
  help: boolean;
  positional: string[];
};

export function parseHeadlessArgs(argv: string[]): HeadlessArgs {
  const args: HeadlessArgs = {
    continueLatest: false,
    outputFormat: "text",
    steeringStdin: false,
    help: false,
    positional: [],
  };

  // Normalize `--flag=value` into `--flag value` pairs.
  const normalized: string[] = [];
  for (const arg of argv) {
    if (arg.startsWith("--") && arg.includes("=")) {
      const equalsIndex = arg.indexOf("=");
      normalized.push(arg.slice(0, equalsIndex), arg.slice(equalsIndex + 1));
    } else {
      normalized.push(arg);
    }
  }

  let i = 0;
  while (i < normalized.length) {
    const arg = normalized[i];
    const next = (): string => {
      const value = normalized[i + 1];
      if (value === undefined) {
        throw new Error(`Missing value for ${arg}`);
      }
      i += 1;
      return value;
    };

    if (arg === "-p" || arg === "--prompt") {
      args.promptText = next();
    } else if (arg === "--prompt-file") {
      args.promptFile = next();
    } else if (arg === "--session") {
      args.sessionId = next();
    } else if (arg === "--continue") {
      args.continueLatest = true;
    } else if (arg === "--model") {
      args.model = next();
    } else if (arg === "--output-format") {
      const value = next();
      if (value !== "text" && value !== "json" && value !== "stream-json") {
        throw new Error(`Invalid --output-format "${value}" (expected text, json, or stream-json)`);
      }
      args.outputFormat = value;
    } else if (arg === "--max-turns") {
      const value = Number.parseInt(next(), 10);
      if (!Number.isFinite(value) || value < 1) {
        throw new Error("--max-turns must be a positive integer");
      }
      args.maxTurns = value;
    } else if (arg === "--append-system") {
      args.appendSystem = next();
    } else if (arg === "--steering-stdin") {
      args.steeringStdin = true;
    } else if (arg === "-h" || arg === "--help") {
      args.help = true;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option ${arg}`);
    } else {
      args.positional.push(arg);
    }

    i += 1;
  }

  if (args.positional.length > 1) {
    throw new Error("Only one positional prompt argument is allowed");
  }

  if (args.sessionId !== undefined && args.continueLatest) {
    throw new Error("--session and --continue are mutually exclusive");
  }

  return args;
}

// ── Types ────────────────────────────────────────────────────────────────────

export type HeadlessIo = {
  stdout?: Writable;
  stderr?: Writable;
  stdin?: Readable;
  /** Test hook: inject a provider instead of resolving one from the model. */
  provider?: Provider;
};

type ResolvedVariant = ModelVariant & { id: string };

// ── Helpers ──────────────────────────────────────────────────────────────────

function isStreamEvent(value: unknown): value is StreamEvent {
  return typeof value === "object" && value !== null && "type" in value;
}

/** Parse a complete tool input JSON string, tolerating partial JSON. */
function parseToolInputJson(raw: string): unknown {
  if (raw === "") return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

async function readAllStdin(stdin: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** True when the stream is an interactive terminal (no piped prompt). */
function stdinIsTty(stdin: Readable): boolean {
  return (stdin as { isTTY?: boolean }).isTTY === true;
}

/** Wait until a stream has flushed its buffered writes. */
function flush(stream: Writable): Promise<void> {
  return new Promise((resolve) => {
    stream.write("", () => resolve());
  });
}

// ── Runner ───────────────────────────────────────────────────────────────────

/**
 * Run `pace run` with the given argv. Returns the process exit code.
 */
export async function runHeadless(argv: string[], io: HeadlessIo = {}): Promise<number> {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const stdin = io.stdin ?? process.stdin;

  const emit = (event: Record<string, unknown>) => {
    stdout.write(`${JSON.stringify(event)}\n`);
  };

  const fail = (message: string): number => {
    stderr.write(`pace run: ${message}\n`);
    return 1;
  };

  let args: HeadlessArgs;
  try {
    args = parseHeadlessArgs(argv);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }

  if (args.help) {
    stdout.write(`${HEADLESS_USAGE}\n`);
    return 0;
  }

  // ── Resolve the prompt ──
  let promptText: string | undefined = args.promptText ?? args.positional[0];
  if (promptText === undefined && args.promptFile !== undefined) {
    try {
      promptText = await readFile(args.promptFile, "utf8");
    } catch (error) {
      return fail(`cannot read --prompt-file: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (promptText === undefined && !stdinIsTty(stdin)) {
    // Piped stdin: consume it fully. Note: this consumes stdin, so
    // --steering-stdin cannot be combined with a piped prompt.
    promptText = await readAllStdin(stdin);
  }
  promptText = promptText?.trim();
  if (!promptText) {
    return fail(
      "no prompt provided. Pass a prompt argument, --prompt, --prompt-file, or pipe it via stdin.",
    );
  }

  // ── Resolve the model ──
  try {
    await loadCachedModelCatalog();
  } catch {
    // Best-effort: built-in catalog still works.
  }

  let modelSelectionInput = args.model;
  if (modelSelectionInput === undefined) {
    try {
      modelSelectionInput = (await loadPaceConfig()).defaultModel;
    } catch {
      // Ignore config errors; fall back to the default model.
    }
  }

  let modelConfig: ModelConfig;
  let modelVariant: ResolvedVariant | undefined;
  if (modelSelectionInput !== undefined) {
    const selection = parseModelSelection(modelSelectionInput);
    if (selection === undefined) {
      return fail(`unknown model "${modelSelectionInput}"`);
    }
    const config = getModelConfig(selection.modelId);
    if (config === undefined) {
      return fail(`unknown model "${selection.modelId}"`);
    }
    modelConfig = config;
    const variant = getModelVariant(selection.modelId, selection.variantId);
    modelVariant = variant && selection.variantId ? { ...variant, id: selection.variantId } : undefined;
  } else {
    modelConfig = getModelConfig(DEFAULT_MODEL_ID) ?? getModels()[DEFAULT_MODEL_ID];
  }
  const modelLabel = modelVariant ? `${modelConfig.id}:${modelVariant.id}` : modelConfig.id;

  // ── Session ──
  const cwd = process.cwd();
  const projectKey = createProjectKey(cwd);
  let session: Session;
  if (args.sessionId !== undefined) {
    try {
      session = await loadSession(projectKey, args.sessionId);
    } catch {
      return fail(`session ${args.sessionId} not found for this project`);
    }
  } else if (args.continueLatest) {
    const sessions = await listSessions(cwd);
    if (sessions.length === 0) {
      return fail("no sessions found for this project");
    }
    session = await loadSession(projectKey, sessions[0].id);
  } else {
    session = createSession(cwd, modelConfig.id, modelVariant?.id);
  }

  // ── Agent context (AGENTS.md, skills, agents, MCP) ──
  const [globalAgentsFileContents, agentsFileContents, skills, agents] = await Promise.all([
    loadGlobalAgentsFile(),
    loadAgentsFile(),
    discoverSkills(),
    discoverAgents(),
  ]);
  setCurrentSkills(skills);
  setCurrentAgents(agents);
  const skillsSection = formatSkillsSystemPromptBlock(skills);

  let mcpEnabledOverrides: Record<string, boolean> = {};
  try {
    mcpEnabledOverrides = (await loadPreferences()).mcpEnabled ?? {};
  } catch {
    // Preferences are optional.
  }
  try {
    await initMcpServers(mcpEnabledOverrides);
  } catch (error) {
    stderr.write(
      `pace run: MCP init failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }

  let appendSystem: string | undefined;
  if (args.appendSystem !== undefined) {
    if (args.appendSystem.startsWith("@")) {
      try {
        appendSystem = await readFile(args.appendSystem.slice(1), "utf8");
      } catch (error) {
        return fail(`cannot read --append-system file: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      appendSystem = args.appendSystem;
    }
  }

  const systemText = assembleSystemText({
    cwd,
    skillsSection: skillsSection || undefined,
    mcpServers: getConnectedMcpServers(),
    globalAgentsFileContents,
    agentsFileContents,
    appendSystem,
  });

  setAgentRuntime(
    makeSubagentRuntime(
      {
        resolveModelConfig: (modelId) =>
          (modelId !== undefined ? getModelConfig(modelId) : undefined) ?? modelConfig,
      },
      { skillsSection, globalAgentsFileContents, agentsFileContents },
    ),
  );

  // ── Steering via stdin ──
  const steeringQueue: string[] = [];
  let steeringReader: ReturnType<typeof createInterface> | undefined;
  if (args.steeringStdin) {
    steeringReader = createInterface({ input: stdin });
    steeringReader.on("line", (line) => {
      const trimmed = line.trim();
      if (trimmed === "") return;
      try {
        const parsed = JSON.parse(trimmed) as { type?: unknown; text?: unknown };
        // Only steering messages are consumed; other NDJSON object types are
        // ignored (forward compatibility).
        if (parsed.type === "steer" && typeof parsed.text === "string") {
          steeringQueue.push(parsed.text);
        }
      } catch {
        // Non-JSON lines are ignored; steering must be NDJSON.
      }
    });
  }

  // ── Run the loop ──
  const abortController = new AbortController();
  let sigintCount = 0;
  const onSigint = () => {
    sigintCount += 1;
    if (sigintCount === 1) {
      abortController.abort();
    } else {
      process.exit(130);
    }
  };
  process.on("SIGINT", onSigint);

  const turnDraft = createTurnDraft(session);
  appendTurnDraftEntry(turnDraft, createUserEntry({
    content: [{ type: "text", text: promptText }],
  }));

  const reasoningBlocks: ThinkingBlock[] = [];
  const toolNames = new Map<string, string>();
  const toolStartTimes = new Map<string, number>();
  const toolInputJson = new Map<string, string>();
  let lastText = "";
  let streamedText = false;

  const textEnabled = args.outputFormat === "text";
  const streamEnabled = args.outputFormat === "stream-json";

  const exitCode = await (async (): Promise<number> => {
    try {
      if (streamEnabled) {
        emit({
          type: "system",
          session: session.id,
          model: modelLabel,
          provider: modelConfig.provider,
          cwd,
        });
      }

      const provider = io.provider ?? await resolveProvider(modelConfig);
      const result = await runAgentLoop({
        provider,
        model: modelConfig.providerModel,
        system: systemText,
        tools,
        toolDefs: getProviderToolDefinitions(),
        maxTokens: modelConfig.maxOutputTokens,
        providerOptions: {
          ...(modelConfig.providerOptions ?? {}),
          ...(modelVariant?.providerOptions ?? {}),
          ...((modelConfig.provider === "opencode" || modelConfig.provider === "fireworks"
            || modelConfig.provider === "friendli")
            && { supportsImages: modelConfig.supportsImages }),
        },
        signal: abortController.signal,
        maxTurns: args.maxTurns,

        takeSteeringMessages: () => {
          const messages = steeringQueue.splice(0);
          for (const text of messages) {
            appendTurnDraftEntry(turnDraft, createUserEntry({
              content: [{ type: "text", text }],
              steering: true,
            }));
          }
          return messages;
        },

        getMessages: () => {
          // Reasoning blocks are scoped to a single provider request.
          reasoningBlocks.length = 0;
          return capProviderMessageImages(
            sessionToProviderMessages(session, turnDraft),
            MAX_REQUEST_BYTES * REQUEST_IMAGE_PAYLOAD_WARNING_RATIO,
          ).messages;
        },

        computeCost: (usage) => computeCallCost(
          modelConfig,
          usage.inputTokens,
          usage.inputTokens - usage.cacheCreationTokens - usage.cacheReadTokens,
          usage.cacheCreationTokens,
          usage.cacheReadTokens,
          usage.outputTokens,
        ),

        onStreamEvent: (event) => {
          if (!isStreamEvent(event)) return;
          switch (event.type) {
            case "text_start": {
              // Providers may deliver the first chunk on text_start.
              if (textEnabled) {
                stdout.write(event.text);
                streamedText = true;
              } else if (streamEnabled) {
                emit({ type: "text_delta", text: event.text });
              }
              break;
            }
            case "text_delta": {
              if (textEnabled) {
                stdout.write(event.text);
                streamedText = true;
              } else if (streamEnabled) {
                emit({ type: "text_delta", text: event.text });
              }
              break;
            }
            case "reasoning_start": {
              if (streamEnabled) {
                emit({ type: "reasoning_delta", text: event.text });
              }
              break;
            }
            case "reasoning_delta": {
              if (streamEnabled) {
                emit({ type: "reasoning_delta", text: event.text });
              }
              break;
            }
            case "tool_use_start": {
              toolNames.set(event.id, event.name);
              toolStartTimes.set(event.id, performance.now());
              toolInputJson.set(event.id, "");
              if (streamEnabled) {
                emit({ type: "tool_start", id: event.id, name: event.name });
              }
              break;
            }
            case "tool_input_delta": {
              toolInputJson.set(event.id, (toolInputJson.get(event.id) ?? "") + event.partialJson);
              break;
            }
            case "block_stop": {
              if (event.id && streamEnabled) {
                const input = parseToolInputJson(toolInputJson.get(event.id) ?? "");
                if (input !== undefined) {
                  emit({ type: "tool_input", id: event.id, input });
                }
              }
              break;
            }
            default:
              break;
          }
        },

        onToolOutput: (toolUseId, chunk) => {
          if (streamEnabled) {
            emit({ type: "tool_output", id: toolUseId, chunk });
          }
        },

        onToolContent: (toolUseId, content) => {
          if (streamEnabled) {
            emit({ type: "tool_content", id: toolUseId, content });
          }
        },

        onResponse: (response, meta) => {
          const text = response.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("\n");
          if (text) lastText = text;

          appendTurnDraftEntry(turnDraft, createAssistantEntry({
            content: [...reasoningBlocks, ...response.content],
            provider: modelConfig.provider,
            modelId: modelConfig.id,
            ...(modelVariant?.id !== undefined && { modelVariant: modelVariant.id }),
            tokensIn: response.usage.inputTokens,
            tokensOut: response.usage.outputTokens,
            cacheReadTokens: response.usage.cacheReadTokens,
            cacheCreationTokens: response.usage.cacheCreationTokens,
            cost: meta.cost,
            streamDurationMs: meta.streamDurationMs,
            ...(response.providerMetadata !== undefined && { providerMetadata: response.providerMetadata }),
          }));

          if (streamEnabled) {
            emit({
              type: "usage",
              model: modelLabel,
              inputTokens: response.usage.inputTokens,
              outputTokens: response.usage.outputTokens,
              cacheReadTokens: response.usage.cacheReadTokens,
              cacheCreationTokens: response.usage.cacheCreationTokens,
              cost: meta.cost,
            });
          }
        },

        onToolResult: (executed) => {
          if (streamEnabled) {
            const id = executed.result.tool_use_id;
            const startedAt = toolStartTimes.get(id);
            emit({
              type: "tool_end",
              id,
              name: toolNames.get(id) ?? "unknown",
              isError: executed.result.is_error === true,
              ...(startedAt !== undefined && { durationMs: Math.round(performance.now() - startedAt) }),
              ...(executed.display !== "" && { display: executed.display }),
            });
          }
        },

        onToolResults: (executedTools) => {
          for (const executed of executedTools) {
            appendTurnDraftEntry(turnDraft, createToolResultEntry({
              toolUseId: executed.result.tool_use_id,
              content: executed.result.content,
              ...(executed.result.is_error && { isError: true }),
              ...(executed.cost !== undefined && { cost: executed.cost }),
              ...(executed.display !== undefined && { display: executed.display }),
            }));
          }
        },
      });

      session = commitTurnDraft(session, turnDraft);
      session = {
        ...session,
        currentModelId: modelConfig.id,
        ...(modelVariant?.id !== undefined && { currentModelVariant: modelVariant.id }),
        updatedAt: new Date().toISOString(),
      };
      await saveSession(session);

      const stopReason = result.cancelled
        ? "cancelled"
        : result.hitTurnCap
          ? "turn_cap"
          : "end";
      const resultPayload = {
        session: session.id,
        model: modelLabel,
        text: lastText,
        turns: result.turns,
        stopReason,
        usage: result.usage,
        cost: result.totalCost,
      };

      if (textEnabled) {
        if (streamedText && !lastText.endsWith("\n")) {
          stdout.write("\n");
        }
      } else if (args.outputFormat === "json") {
        stdout.write(`${JSON.stringify(resultPayload, null, 2)}\n`);
      } else {
        emit({ type: "result", ...resultPayload });
      }

      if (result.cancelled) return 130;
      if (result.hitTurnCap) return 2;
      return 0;
    } catch (error) {
      // Persist whatever completed before the failure, like the TUI does.
      if (!isTurnDraftEmpty(turnDraft)) {
        try {
          session = commitTurnDraft(session, turnDraft);
          await saveSession(session);
        } catch {
          // Persistence failure must not mask the original error.
        }
      }
      if (isAbortError(error)) {
        return 130;
      }
      stderr.write(`pace run: ${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  })();

  process.off("SIGINT", onSigint);
  steeringReader?.close();
  await shutdownMcpServers().catch(() => undefined);
  await flush(stdout);
  return exitCode;
}
