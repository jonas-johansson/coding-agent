import { readFile, stat } from "fs/promises";
import { existsSync } from "fs";
import { homedir } from "os";
import { join, resolve, extname } from "path";
import { Tui } from "./tui";
import { formatSessionCost, formatTokenCount } from "./view-model";
import { getGitBranch } from "./git.js";
import {
  formatTurnSummary,
  getTurnSummary,
  sessionToRenderBlocks,
  sessionToTreeOverlayEntries,
} from "./session-view";
import { reasoningDisplayContent, reasoningDisplayTitle, reasoningTitle } from "./reasoning";
import {
  appendEntries,
  appendTurnDraftEntry,
  commitTurnDraft,
  createAssistantEntry,
  createCompactionEntry,
  createProjectKey,
  createSession,
  createToolResultEntry,
  createTurnDraft,
  createUserEntry,
  getActivePath,
  isTurnDraftEmpty,
  listSessions,
  loadSession,
  planCompaction,
  saveSession,
  sessionToProviderMessages,
  setActiveEntryId,
  summarizeForCompaction,
  undoLastUserTurn,
  type CompactionEntry,
  type ContentBlock as SessionContentBlock,
  type Session,
  type SessionListItem,
  type TextBlock,
  type ThinkingBlock,
  type TurnDraft,
} from "@pace/agent";
import { initHighlighter } from "./syntax";
import {
  tools,
  visualizeToolTitle,
  visualizeToolPartialTitle,
  formatToolResultBody,
  truncateToolOutputIfNeeded,
  isAbortError,
  getProviderToolDefinitions,
  setCurrentSkills,
  setCurrentAgents,
  setAgentRuntime,
} from "@pace/agent";
import {
  discoverSkills,
  findSkill,
  loadSkillContent,
  formatSkillsSystemPromptBlock,
  formatSkillsListing,
} from "@pace/agent";
import {
  discoverAgents,
  formatAgentsListing,
} from "@pace/agent";
import { runAgentLoop } from "@pace/agent";
import type {
  ProviderStream,
  ContentBlock as ProviderContentBlock,
  ToolUseBlock,
  ToolResultContent,
  ImageBlock,
  ProviderMessage,
} from "@pace/llm";
import {
  DEFAULT_MODEL_ID,
  getAvailableModelIds,
  getModelConfig,
  getModelVariant,
  getModels,
  parseModelSelection,
  formatModelSelection,
  type ModelConfig,
  type ModelSelection,
  type ModelVariant,
} from "@pace/llm";
import { readClipboardImage, type SupportedImageMediaType } from "./clipboard";
import { sendDesktopNotification } from "./notify";
import { onEvent, resolveProvider } from "@pace/llm";
import { loadPaceConfig, DEFAULT_COST_DISPLAY_CONFIG, DEFAULT_COMPACTION_CONFIG, type CostDisplayConfig, type CompactionConfig } from "./config";
import {
  assembleSystemText,
  computeCallCost,
  formatCwd,
  loadAgentsFile,
  loadGlobalAgentsFile,
  makeSubagentRuntime,
} from "./agent-context";
import {
  MAX_REQUEST_BYTES,
  REQUEST_IMAGE_PAYLOAD_WARNING_RATIO,
  capProviderMessageImages,
  estimateBase64Size,
} from "./image-cap";
import { runHeadless } from "./headless";
import { resolveTheme } from "./themes";
import { setTuiTheme } from "./tui";
import { setShikiTheme } from "./syntax";
import { detectTerminalBackground } from "./terminal-utils";
import { loadPreferences, savePreferences } from "./preferences";
import { loadCachedModelCatalog, refreshModelCatalog } from "@pace/llm";
import {
  initMcpServers,
  shutdownMcpServers,
  connectMcpServer,
  disconnectMcpServer,
  listMcpServers,
  formatMcpListing,
  getConnectedMcpServers,
} from "@pace/agent";

async function getProjectFiles(): Promise<string[]> {
  const { exec } = await import("child_process");
  const { promisify } = await import("util");
  const execAsync = promisify(exec);

  try {
    const { stdout } = await execAsync(
      `rg --files --hidden -g '!node_modules/' -g '!.git/' -g '!dist/' -g '!build/' -g '!coverage/' -g '!.next/' -g '!vendor/'`,
      { cwd: process.cwd(), maxBuffer: 10 * 1024 * 1024 },
    );
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

// ── Model state ──────────────────────────────────────────────────────────────

let currentModelId: string = DEFAULT_MODEL_ID;
const lastVariantByModelId = new Map<string, string>();
let cycleModelSelections: ModelSelection[] = [
  { modelId: "opencode/kimi-k3" },
  { modelId: "opencode/kimi-k2.7-code" },
  { modelId: "opencode/kimi-k2.6" },
  { modelId: "opencode/glm-5.3-flash" },
  { modelId: "opencode/claude-fable-5" },
  { modelId: "opencode/claude-opus-4-8" },
];
const DEFAULT_SESSION_TITLE_MODEL = "opencode/deepseek-v4-flash";
const DEFAULT_SESSION_TITLE_MODEL_VARIANT = "nothink";
let sessionTitleModelSelection: ModelSelection = {
  modelId: DEFAULT_SESSION_TITLE_MODEL,
  variantId: DEFAULT_SESSION_TITLE_MODEL_VARIANT,
};
let activeSession = createSession(process.cwd(), currentModelId);

/** Compaction settings from ~/.config/pace/config.json (defaults apply otherwise). */
let compactionConfig: CompactionConfig = DEFAULT_COMPACTION_CONFIG;

/**
 * MCP server enable/disable overrides (Pace-owned runtime state). The
 * user-authored mcp.json is never modified; these win over its `enabled`
 * field and are persisted to prefs.json.
 */
let mcpEnabledOverrides: Record<string, boolean> = {};

type ResolvedModelVariant = ModelVariant & { id: string };

function currentModelConfig(): ModelConfig {
  return getModelConfig(currentModelId) ?? getModels()[DEFAULT_MODEL_ID];
}

function currentModelVariantId(): string | undefined {
  const remembered = lastVariantByModelId.get(currentModelId);
  if (remembered && getModelVariant(currentModelId, remembered)) {
    return remembered;
  }
  return undefined;
}

function currentModelVariant(): ResolvedModelVariant | undefined {
  const variantId = currentModelVariantId();
  const variant = getModelVariant(currentModelId, variantId);
  return variant && variantId ? { ...variant, id: variantId } : undefined;
}

function formatCurrentModelSelection(): string {
  return formatModelSelection({ modelId: currentModelId, variantId: currentModelVariantId() });
}

function updateCurrentModelVariant(variantId: string | undefined) {
  if (variantId) {
    lastVariantByModelId.set(currentModelId, variantId);
  } else {
    lastVariantByModelId.delete(currentModelId);
  }

  activeSession = {
    ...activeSession,
    currentModelId,
    currentModelVariant: variantId,
    updatedAt: new Date().toISOString(),
  };
  tui.setModel(formatCurrentModelSelection());
  schedulePreferenceSave();
}

function selectModel(modelId: string, explicitVariantId?: string) {
  currentModelId = modelId;
  const variants = currentModelConfig().variants ?? {};
  const rememberedVariantId = lastVariantByModelId.get(modelId);
  const nextVariantId = explicitVariantId
    ?? (rememberedVariantId && variants[rememberedVariantId] ? rememberedVariantId : undefined);

  updateCurrentModelVariant(nextVariantId && variants[nextVariantId] ? nextVariantId : undefined);
  updateContextInfo();
}

function selectModelSelection(selection: ModelSelection) {
  selectModel(selection.modelId, selection.variantId);
}

function cancelPrompt() {
  if (!promptRunning || !currentAbortController) return;
  // Restore queued steering messages to the input line so they are not lost.
  if (steeringQueue.length > 0) {
    tui.prependInput(steeringQueue.splice(0).join("\n"));
    tui.setSteeringQueueCount(0);
  }
  currentAbortController.abort();
}

function queueSteeringMessage(text: string) {
  if (text.startsWith("/") || text.startsWith("!")) {
    tui.setStatus("Commands are not available while the agent is running");
    return;
  }

  steeringQueue.push(text);
  tui.setSteeringQueueCount(steeringQueue.length);
  tui.setStatus("Steering queued — delivered after the current step");
}

const tui = new Tui({
  onSubmit: handleUserInput,
  onSteer: queueSteeringMessage,
  onTab: cycleModel,
  onShiftTab: cycleModelReverse,
  onCycleVariant: cycleModelVariant,
  onEscape: cancelPrompt,
  onExit: async () => {
    await flushPreferenceSave();
    await shutdownMcpServers();
  },
  onPasteImage: handlePasteImage,
  slashCommands: () => [
    { label: "/new", detail: "Start a new conversation", kind: "command", insertText: "/new " },
    { label: "/exit", detail: "Exit the application", kind: "command", insertText: "/exit " },
    { label: "/quit", detail: "Exit the application", kind: "command", insertText: "/quit " },
    { label: "/model", detail: "Show or switch model", kind: "command", insertText: "/model " },
    { label: "/models", detail: "Open the model picker (Ctrl+O)", kind: "command", insertText: "/models", executeOnAccept: true },
    { label: "/variant", detail: "Show, switch, or unset model variant", kind: "command", insertText: "/variant " },
    { label: "/variants", detail: "List model variants", kind: "command", insertText: "/variants", executeOnAccept: true },
    { label: "/sessions", detail: "Open the session picker", kind: "command", insertText: "/sessions", executeOnAccept: true },
    { label: "/resume", detail: "Resume a session by id", kind: "command", insertText: "/resume " },
    { label: "/star", detail: "Star or unstar the current session", kind: "command", insertText: "/star" },
    { label: "/tree", detail: "Open the conversation tree (Ctrl+B)", kind: "command", insertText: "/tree", executeOnAccept: true },
    { label: "/undo", detail: "Undo the last user turn", kind: "command", insertText: "/undo" },
    { label: "/compact", detail: "Summarize older context to free up the window", kind: "command", insertText: "/compact " },
    { label: "/skills", detail: "List available skills", kind: "command", insertText: "/skills " },
    { label: "/skill:<name>", detail: "Load and run a skill", kind: "command", insertText: "/skill:" },
    { label: "/agents", detail: "List available agents", kind: "command", insertText: "/agents " },
    { label: "/mcp", detail: "List connected MCP servers and tools", kind: "command", insertText: "/mcp" },
    { label: "/mcps", detail: "Enable or disable MCP servers (Ctrl+E)", kind: "command", insertText: "/mcps", executeOnAccept: true },
    { label: "/theme", detail: "Show or switch theme", kind: "command", insertText: "/theme " },
    { label: "/themes", detail: "List available themes", kind: "command", insertText: "/themes", executeOnAccept: true },
  ],
  fileSuggestions: getProjectFiles,
  modelOverlay: {
    list: () => getAvailableModelIds().map((id) => {
      const config = getModelConfig(id);
      return {
        id,
        contextWindow: config?.contextWindow ?? 0,
        supportsImages: config?.supportsImages ?? false,
        inputPerMTok: config?.pricing.inputPerMTok ?? 0,
        outputPerMTok: config?.pricing.outputPerMTok ?? 0,
      };
    }),
    initialSelected: () => Array.from(new Set(cycleModelSelections.map((selection) => selection.modelId))),
    onPick: (id) => selectModel(id),
    onCycleChange: (ids) => {
      cycleModelSelections = (ids.length > 0 ? ids : getAvailableModelIds()).map((modelId) => ({ modelId }));
      schedulePreferenceSave();
    },
  },
  mcpOverlay: {
    list: () => listMcpServers(mcpEnabledOverrides),
    onToggle: async (name, enabled) => {
      mcpEnabledOverrides[name] = enabled;
      schedulePreferenceSave();
      if (enabled) {
        const error = await connectMcpServer(name);
        if (error) {
          delete mcpEnabledOverrides[name];
          schedulePreferenceSave();
          tui.setStatus(`MCP: ${name} — ${error.error}`);
          return;
        }
      } else {
        await disconnectMcpServer(name);
      }
      tui.setStatus(`MCP: ${name} ${enabled ? "enabled" : "disabled"}`);
    },
  },
  sessionOverlay: {
    onPick: (id) => {
      void resumeSessionById(id);
    },
  },
  treeOverlay: {
    onPick: (id) => {
      void navigateToEntry(id);
    },
    onOpen: () => {
      const items = sessionToTreeOverlayEntries(activeSession);
      if (items.length === 0) {
        tui.addBlock({ role: "assistant", title: "Tree", content: "The current session is empty." });
        return;
      }
      tui.openTreeOverlay(items);
    },
  },
  model: DEFAULT_MODEL_ID,
  cwd: process.cwd(),
  gitBranch: getGitBranch(process.cwd()) ?? "",
});

let costDisplayConfig: CostDisplayConfig = DEFAULT_COST_DISPLAY_CONFIG;

let promptRunning = false;
let currentAbortController: AbortController | null = null;
const steeringQueue: string[] = [];
let lastInputTokens = 0;
let lastOutputTokens = 0;
let lastCacheReadTokens = 0;
let lastCacheCreationTokens = 0;
let accumulatedCost = 0;
/** True while the context meter shows a post-compaction estimate. */
let contextEstimated = false;
/** Consecutive auto-compaction failures (circuit breaker: 3 disables auto). */
let compactionFailures = 0;
let autoCompactionDisabled = false;

// ── Image attachment state ───────────────────────────────────────────────────

type ImageAttachment = {
  mediaType: SupportedImageMediaType;
  data: string; // base64
  rawSize: number; // raw bytes before base64
  label: string; // e.g. "clipboard-1", "screenshot.png"
};

let pendingImages: ImageAttachment[] = [];
let clipboardCounter = 0;
let pasteInFlight = false;

/** Maximum raw bytes per image (Anthropic binding constraint). */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Image file extensions we recognize. */
const IMAGE_EXTENSIONS: Record<string, SupportedImageMediaType> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/** Pattern matching @image(<path>) references in user input. */
const IMAGE_REF_PATTERN = /@image\(([^)]+)\)/g;

/** Pattern matching bare image file paths at word boundaries. */
const BARE_IMAGE_PATH_PATTERN = /(?:^|\s)((?:\.{0,2}\/|~\/)[^\s]+\.(?:jpg|jpeg|png|gif|webp))(?=\s|$)/gi;

/** Pattern matching @filename references (e.g. @file.txt, @src/foo.ts). */
const FILE_REF_PATTERN = /@([\w./\-]+\.\w+)/g;

function expandHomePath(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    return join(homedir(), p.slice(1));
  }
  return p;
}

/** Estimate total pending + new image payload in base64 bytes. */
function estimatePendingImagePayload(): number {
  let total = 0;
  for (const img of pendingImages) {
    total += estimateBase64Size(img.rawSize);
  }
  return total;
}

function mimeFromExtension(filePath: string): SupportedImageMediaType | null {
  const ext = extname(filePath).toLowerCase();
  return IMAGE_EXTENSIONS[ext] ?? null;
}

function updateContextInfo() {
  const config = currentModelConfig();
  const usedTokens = lastInputTokens + lastOutputTokens;
  tui.setContextInfo({
    usedTokens,
    contextWindow: config.contextWindow,
    cacheReadTokens: lastCacheReadTokens,
    cacheCreationTokens: lastCacheCreationTokens,
    ...(contextEstimated && { estimated: true }),
  });
  tui.setCost(accumulatedCost);
}

function refreshSessionStatsFromSession() {
  const activePath = getActivePath(activeSession);
  let lastAssistantEntry;

  for (let i = activePath.length - 1; i >= 0; i -= 1) {
    const entry = activePath[i];
    if (entry.type === "assistant") {
      lastAssistantEntry = entry;
      break;
    }
  }

  // A compaction as the newest entry means the meter shows its estimate
  // until the next real response usage arrives.
  const newestEntry = activePath[activePath.length - 1];
  if (newestEntry?.type === "compaction") {
    lastInputTokens = newestEntry.tokensAfter;
    lastOutputTokens = 0;
    lastCacheReadTokens = 0;
    lastCacheCreationTokens = 0;
    contextEstimated = true;
  } else {
    lastInputTokens = lastAssistantEntry?.tokensIn ?? 0;
    lastOutputTokens = lastAssistantEntry?.tokensOut ?? 0;
    lastCacheReadTokens = lastAssistantEntry?.cacheReadTokens ?? 0;
    lastCacheCreationTokens = lastAssistantEntry?.cacheCreationTokens ?? 0;
    contextEstimated = false;
  }
  accumulatedCost = activeSession.entries.reduce(
    (sum, entry) => sum + (entry.type === "assistant" ? entry.cost : 0)
      + (entry.type === "tool_result" ? (entry.cost ?? 0) : 0)
      + (entry.type === "compaction" ? entry.cost : 0),
    0,
  );
  updateContextInfo();
}

async function navigateToEntry(entryId: string) {
  const targetEntry = activeSession.entries.find((entry) => entry.id === entryId);
  if (!targetEntry) {
    tui.addBlock({ role: "error", title: "Error", content: `Entry ${entryId} not found in the current session.` });
    return;
  }

  try {
    let newActiveEntryId: string | null = entryId;
    let inputText = "";

    if (targetEntry.type === "user") {
      const texts = targetEntry.content
        .filter((block): block is TextBlock => block.type === "text")
        .map((block) => block.text);
      inputText = texts.join("");

      // Move the leaf to the parent of the selected user message so that
      // resubmitting creates a sibling branch, not a child.
      const entriesById = new Map(activeSession.entries.map((entry) => [entry.id, entry]));
      let parentId: string | null = targetEntry.parentId;
      while (parentId !== null) {
        const parent = entriesById.get(parentId);
        if (!parent) {
          parentId = null;
          break;
        }
        if (parent.type === "user" || parent.type === "assistant" || parent.type === "compaction") {
          break;
        }
        parentId = parent.parentId;
      }
      newActiveEntryId = parentId;
    }

    activeSession = setActiveEntryId(activeSession, newActiveEntryId);
    await saveSession(activeSession);
    rebuildTuiFromSession();
    refreshSessionStatsFromSession();

    if (targetEntry.type === "user") {
      tui.setInput(inputText);
      tui.setStatus("Jumped to parent of user message — edit and submit to branch");
    } else {
      tui.setStatus("Jumped to assistant message — next message will branch from here");
    }
  } catch (error) {
    tui.addBlock({ role: "error", title: "Error", content: formatErrorMessage(error) });
  }
}

function clearPendingInputState() {
  pendingImages = [];
  clipboardCounter = 0;
  tui.setImageCount(0);
}

function activateSession(session: Session) {
  activeSession = session;
  currentModelId = getModelConfig(activeSession.currentModelId) ? activeSession.currentModelId : DEFAULT_MODEL_ID;
  if (getModelVariant(currentModelId, activeSession.currentModelVariant)) {
    lastVariantByModelId.set(currentModelId, activeSession.currentModelVariant as string);
  } else {
    lastVariantByModelId.delete(currentModelId);
  }
  activeSession = { ...activeSession, currentModelId, currentModelVariant: currentModelVariantId() };

  tui.setModel(formatCurrentModelSelection());
  clearPendingInputState();
  rebuildTuiFromSession();
  tui.setSessionTitle(session.title ?? "");
  tui.setSessionStarred(session.starred ?? false);
  tui.setWindowTitle(formatSessionWindowTitle(session.title));
  refreshSessionStatsFromSession();
}

async function resumeSessionById(sessionId: string) {
  const session = await loadSession(createProjectKey(process.cwd()), sessionId);
  activateSession(session);
}

function refreshCwd() {
  tui.setCwd(process.cwd());
  tui.setGitBranch(getGitBranch(process.cwd()) ?? "");
}

function rebuildTuiFromSession() {
  tui.setBlocks(sessionToRenderBlocks(activeSession, { costConfig: costDisplayConfig }));
}

function formatSessionWindowTitle(title: string | undefined) {
  return title || "Pace";
}

function getLastAssistantText(session: Session): string | undefined {
  for (let i = session.entries.length - 1; i >= 0; i -= 1) {
    const entry = session.entries[i];
    if (entry.type === "assistant") {
      const texts = entry.content
        .filter((block): block is { type: "text"; text: string } => block.type === "text")
        .map((block) => block.text);
      if (texts.length > 0) {
        return texts.join("");
      }
    }
  }
  return undefined;
}

function getFirstParagraph(text: string): string | undefined {
  const paragraphs = text.split("\n").map((p) => p.trim()).filter((p) => p.length > 0);
  if (paragraphs.length === 0) return undefined;
  return paragraphs[0].replace(/\*\*/g, "");
}

function sendDoneNotification(session: Session): void {
  const title = session.title ?? "Pace";
  const lastText = getLastAssistantText(session);
  const body = getFirstParagraph(lastText ?? "") ?? "Done";
  sendDesktopNotification(title, body);
}

function formatError(error: unknown) {
  if (!(error instanceof Error)) return String(error);
  let text = error.stack ?? error.message;
  // Surface wrapped root causes — e.g. the OpenAI SDK wraps stream errors in
  // a fresh OpenAIError whose stack points at its own wrapping code, hiding
  // the original error (and its stack) on the `cause` property.
  let cause: unknown = error.cause;
  while (cause instanceof Error) {
    text += `\nCaused by: ${cause.stack ?? cause.message}`;
    cause = cause.cause;
  }
  return text;
}

function formatErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function applyTheme(themeName: string, showStatus = false) {
  const newTheme = resolveTheme(themeName);
  setTuiTheme(newTheme);
  tui.invalidateRenderCache();
  // Fire-and-forget: Shiki theme loading is non-critical for TUI rendering.
  void setShikiTheme(newTheme.shikiTheme);
  if (showStatus) tui.setStatus(`Theme: ${newTheme.name}`);
}

function switchTheme(themeName: string) {
  applyTheme(themeName, true);
}

function syncThemeFromTerminal() {
  applyTheme(detectTerminalBackground());
}

const SESSION_TITLE_SYSTEM_PROMPT = `Generate a short, descriptive session title for a coding assistant conversation.

Rules:
- Return only the title.
- Use 2 to 8 words.
- Do not use quotes.
- Do not end with punctuation or colon.
- If the message is vague, summarize the likely task.
- Do not assume framework or tech stack.

Examples:
- Free memory and storage check
- Multi-select entities
- Latest tech news update
- GTA 6 release date
- Project overview
- Dark/Light theme toggle
`;

function sessionTitlePromptContent(contentBlocks: Array<ImageBlock | { type: "text"; text: string }>): string {
  const parts = contentBlocks.map((block) => block.type === "text" ? block.text : "[Image attached]");
  return parts.join("\n\n").replace(/\s+/g, " ").trim() || "[No text provided]";
}

function sanitizeSessionTitle(raw: string): string | undefined {
  let title = raw
    .replace(/^[\s#*_`~>\-:]+/, "")
    .replace(/\s+/g, " ")
    .trim();

  title = title.replace(/^(?:session\s+title|title)\s*:\s*/i, "").trim();
  title = title.replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, "").trim();
  title = title.replace(/[.!?;:]+$/g, "").trim();

  if (!title || /[\r\n]/.test(title)) {
    return undefined;
  }

  const maxLength = 60;
  if (Array.from(title).length > maxLength) {
    const truncated = Array.from(title).slice(0, maxLength).join("");
    title = truncated.replace(/\s+\S*$/, "").trim() || truncated.trim();
  }

  return title || undefined;
}

function maybeGenerateSessionTitleFromFirstMessage(
  sessionId: string,
  contentBlocks: Array<ImageBlock | { type: "text"; text: string }>,
): void {
  void (async () => {
    try {
      const modelConfig = getModelConfig(sessionTitleModelSelection.modelId);
      if (!modelConfig) {
        return;
      }

      const modelVariant = getModelVariant(modelConfig.id, sessionTitleModelSelection.variantId);
      const provider = await resolveProvider(modelConfig);
      const stream = await provider.stream({
        model: modelConfig.providerModel,
        system: SESSION_TITLE_SYSTEM_PROMPT,
        messages: [{
          role: "user",
          content: [{ type: "text", text: sessionTitlePromptContent(contentBlocks) }],
        }],
        tools: [],
        maxTokens: 32,
        providerOptions: {
          ...(modelConfig.providerOptions ?? {}),
          ...(modelVariant?.providerOptions ?? {}),
        },
      });

      for await (const _event of stream) {
        // Consume the stream so finalMessage() can return the complete response.
      }

      const response = await stream.finalMessage();
      const rawTitle = response.content
        .filter((block): block is { type: "text"; text: string } => block.type === "text")
        .map((block) => block.text)
        .join(" ");
      const title = sanitizeSessionTitle(rawTitle);

      if (!title) {
        if (activeSession.id === sessionId && !activeSession.title) {
          tui.setStatus("Session title failed: title model returned no text");
        }
        return;
      }

      if (activeSession.id !== sessionId || activeSession.title) {
        return;
      }

      activeSession = {
        ...activeSession,
        title,
        updatedAt: new Date().toISOString(),
      };
      tui.setSessionTitle(title);
      tui.setWindowTitle(formatSessionWindowTitle(title));
      await saveSession(activeSession);
    } catch (error) {
      // Session naming is best-effort. Keep the first-message preview fallback.
      if (activeSession.id === sessionId && !activeSession.title) {
        tui.setStatus(`Session title failed: ${formatErrorMessage(error)}`);
      }
    }
  })();
}

// ── Compaction ───────────────────────────────────────────────────────────────

/**
 * Build the agent system text (base → skills → MCP → AGENTS.md) and refresh
 * the skill/agent/subagent runtime. Shared by the main prompt loop and the
 * compaction summarizer so the summarizer request keeps the same cache
 * prefix as the main loop.
 */
async function buildAgentSystemText(): Promise<string> {
  const [globalAgentsFileContents, agentsFileContents, skills, agents] = await Promise.all([
    loadGlobalAgentsFile(),
    loadAgentsFile(),
    discoverSkills(),
    discoverAgents(),
  ]);

  setCurrentSkills(skills);
  setCurrentAgents(agents);

  const skillsSection = formatSkillsSystemPromptBlock(skills);

  setAgentRuntime(makeSubagentRuntime(
    {
      resolveModelConfig: (modelId) =>
        (modelId !== undefined ? getModelConfig(modelId) : undefined) ?? currentModelConfig(),
    },
    { skillsSection, globalAgentsFileContents, agentsFileContents },
  ));

  return assembleSystemText({
    cwd: process.cwd(),
    skillsSection: skillsSection || undefined,
    mcpServers: getConnectedMcpServers(),
    globalAgentsFileContents,
    agentsFileContents,
  });
}

/**
 * Effective auto-compaction threshold: the configured threshold clamped to
 * the model's window, so 128k/32k models compact before overflowing.
 * Disabled (undefined) when auto-compaction is off or the context window is
 * unknown.
 */
function effectiveCompactionThreshold(modelConfig: ModelConfig): number | undefined {
  if (!compactionConfig.auto || modelConfig.contextWindow <= 0) {
    return undefined;
  }
  return Math.min(
    compactionConfig.thresholdTokens,
    modelConfig.contextWindow - modelConfig.maxOutputTokens - 8_000,
  );
}

/**
 * Resolve the summarizer model: `compaction.model` override when set and
 * valid, otherwise the current model (cache sharing with the main loop).
 */
function resolveSummarizerModel(): { config: ModelConfig; variant: ResolvedModelVariant | undefined } {
  if (compactionConfig.model !== undefined) {
    const selection = parseModelSelection(compactionConfig.model);
    const config = selection ? getModelConfig(selection.modelId) : undefined;
    if (selection && config) {
      const variant = selection.variantId
        ? getModelVariant(selection.modelId, selection.variantId)
        : undefined;
      return {
        config,
        variant: variant && selection.variantId ? { ...variant, id: selection.variantId } : undefined,
      };
    }
  }
  return { config: currentModelConfig(), variant: currentModelVariant() };
}

/**
 * Plan and run one compaction: summarize the older context via a one-shot
 * LLM call and append a `compaction` entry to the session (into the turn
 * draft when mid-turn). Updates the token meter and returns the new entry,
 * or null when there is nothing to compact. UI blocks are added by callers.
 */
async function compactContext(opts: {
  trigger: "auto" | "manual";
  focus?: string;
  /** Present when called from the loop mid-turn. */
  draft?: TurnDraft;
  signal?: AbortSignal;
}): Promise<CompactionEntry | null> {
  const entries = [
    ...getActivePath(activeSession),
    ...(opts.draft?.entries ?? []),
  ];
  const plan = planCompaction(entries, {
    keepRecentTokens: compactionConfig.keepRecentTokens,
  });
  if (!plan) {
    return null;
  }

  const { config: modelConfig, variant: modelVariant } = resolveSummarizerModel();
  const provider = await resolveProvider(modelConfig);
  const systemText = await buildAgentSystemText();

  const { summary, usage } = await summarizeForCompaction({
    provider,
    model: modelConfig.providerModel,
    system: systemText,
    toolDefs: getProviderToolDefinitions(),
    providerOptions: {
      ...(modelConfig.providerOptions ?? {}),
      ...(modelVariant?.providerOptions ?? {}),
    },
    maxTokens: Math.min(modelConfig.maxOutputTokens, 16_000),
    messages: plan.messagesToSummarize,
    focus: opts.focus,
    signal: opts.signal,
  });

  const cost = computeCallCost(
    modelConfig,
    usage.inputTokens,
    usage.inputTokens - usage.cacheCreationTokens - usage.cacheReadTokens,
    usage.cacheCreationTokens,
    usage.cacheReadTokens,
    usage.outputTokens,
  );

  const summaryWithFiles = plan.touchedFiles.length > 0
    ? `${summary}\n\n## Files touched\n${plan.touchedFiles.map((file) => `- ${file}`).join("\n")}`
    : summary;

  // Summary message overhead (wrapper text) plus the kept tail estimate.
  const tokensBefore = lastInputTokens + lastOutputTokens > 0
    ? lastInputTokens + lastOutputTokens
    : plan.tokensBeforeEstimate;
  const tokensAfter = plan.tokensKeptEstimate
    + Math.ceil((summaryWithFiles.length + 200) / 4);

  const entry = createCompactionEntry({
    summary: summaryWithFiles,
    firstKeptEntryId: plan.firstKeptEntryId,
    tokensBefore,
    tokensAfter,
    trigger: opts.trigger,
    ...(opts.focus !== undefined && { focus: opts.focus }),
    provider: modelConfig.provider,
    modelId: modelConfig.id,
    tokensIn: usage.inputTokens,
    tokensOut: usage.outputTokens,
    cost,
  });

  if (opts.draft) {
    // Mid-turn: the draft's normal commit path persists the entry.
    appendTurnDraftEntry(opts.draft, entry);
  } else {
    activeSession = appendEntries(activeSession, [entry]);
    await saveSession(activeSession);
  }

  // The next request is much smaller; show an estimate until real usage
  // arrives from the next response.
  lastInputTokens = entry.tokensAfter;
  lastOutputTokens = 0;
  lastCacheReadTokens = 0;
  lastCacheCreationTokens = 0;
  contextEstimated = true;
  accumulatedCost += entry.cost;
  updateContextInfo();

  tui.setStatus(
    `Compacted ${formatTokenCount(entry.tokensBefore)} → ~${formatTokenCount(entry.tokensAfter)} tokens`,
  );

  return entry;
}

// ── Preference persistence ───────────────────────────────────────────────────

function buildPreferences() {
  const variantByModel: Record<string, string> = {};
  for (const [modelId, variantId] of lastVariantByModelId) {
    variantByModel[modelId] = variantId;
  }

  return {
    cycleModels: cycleModelSelections.map(formatModelSelection),
    ...(Object.keys(variantByModel).length > 0 && { variantByModel }),
    ...(Object.keys(mcpEnabledOverrides).length > 0 && { mcpEnabled: mcpEnabledOverrides }),
    currentModel: formatCurrentModelSelection(),
  };
}

let preferenceSaveTimer: NodeJS.Timeout | undefined;
let preferenceSaveInFlight: Promise<void> = Promise.resolve();

/** Persist current preferences, coalescing rapid changes via a short debounce. */
function schedulePreferenceSave() {
  if (preferenceSaveTimer) {
    clearTimeout(preferenceSaveTimer);
  }
  preferenceSaveTimer = setTimeout(() => {
    preferenceSaveTimer = undefined;
    void flushPreferenceSave();
  }, 400);
}

/** Write preferences immediately, cancelling any pending debounced write. */
function flushPreferenceSave(): Promise<void> {
  if (preferenceSaveTimer) {
    clearTimeout(preferenceSaveTimer);
    preferenceSaveTimer = undefined;
  }
  const snapshot = buildPreferences();
  preferenceSaveInFlight = preferenceSaveInFlight
    .catch(() => undefined)
    .then(() => savePreferences(snapshot))
    .catch(() => undefined);
  return preferenceSaveInFlight;
}

function applyStoredPreferences(preferences: {
  cycleModels?: string[];
  variantByModel?: Record<string, string>;
  currentModel?: string;
  mcpEnabled?: Record<string, boolean>;
}) {
  if (preferences.mcpEnabled) {
    mcpEnabledOverrides = { ...preferences.mcpEnabled };
  }

  if (preferences.cycleModels) {
    const restored = preferences.cycleModels
      .map((entry) => parseModelSelection(entry))
      .filter((selection): selection is ModelSelection => selection !== undefined);
    if (restored.length > 0) {
      cycleModelSelections = restored;
    }
  }

  if (preferences.variantByModel) {
    for (const [modelId, variantId] of Object.entries(preferences.variantByModel)) {
      if (getModelVariant(modelId, variantId)) {
        lastVariantByModelId.set(modelId, variantId);
      }
    }
  }

  if (preferences.currentModel) {
    const selection = parseModelSelection(preferences.currentModel);
    if (selection) {
      selectModelSelection(selection);
    }
  }

  if (!cycleModelSelections.some((selection) => selection.modelId === currentModelId)) {
    selectModelSelection(cycleModelSelections[0]);
  }
}

function modelSelectionMatchesCurrent(selection: ModelSelection): boolean {
  return selection.modelId === currentModelId
    && (selection.variantId === undefined || selection.variantId === currentModelVariantId());
}

function cycleModel() {
  const selections = cycleModelSelections;
  const currentIndex = selections.findIndex(modelSelectionMatchesCurrent);
  const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % selections.length;
  selectModelSelection(selections[nextIndex]);
}

function cycleModelReverse() {
  const selections = cycleModelSelections;
  const currentIndex = selections.findIndex(modelSelectionMatchesCurrent);
  const prevIndex = currentIndex === -1 ? selections.length - 1 : (currentIndex - 1 + selections.length) % selections.length;
  selectModelSelection(selections[prevIndex]);
}

function cycleModelVariant() {
  const variants = Object.keys(currentModelConfig().variants ?? {});
  if (variants.length === 0) {
    tui.setStatus(`${currentModelId} has no variants`);
    return;
  }

  const currentVariant = currentModelVariantId();
  const cycle: (string | undefined)[] = [undefined, ...variants];
  const currentIndex = currentVariant ? cycle.indexOf(currentVariant) : 0;
  const nextVariant = cycle[((currentIndex === -1 ? 0 : currentIndex) + 1) % cycle.length];
  updateCurrentModelVariant(nextVariant);
}

function formatModelList() {
  return cycleModelSelections.map(formatModelSelection).join("\n");
}

function formatVariantList() {
  const variants = currentModelConfig().variants ?? {};
  const entries = Object.entries(variants);
  if (entries.length === 0) {
    return `${currentModelId} has no variants.`;
  }

  const currentVariant = currentModelVariantId();
  return [
    `Current model: ${currentModelId}`,
    `Current variant: ${currentVariant ?? "unset"}`,
    "",
    "Available variants:",
    `${currentVariant === undefined ? "*" : "-"} unset — provider default, no explicit options sent`,
    ...entries.map(([id, variant]) => {
      const marker = id === currentVariant ? "*" : "-";
      return `${marker} ${id}${variant.label ? ` — ${variant.label}` : ""}`;
    }),
    "",
    "Usage: /variant <variant|unset>",
  ].join("\n");
}

function applyConfiguredModels(config: { defaultModel?: string; cycleModels?: string[]; sessionTitleModel?: string }) {
  if (config.sessionTitleModel !== undefined) {
    const selection = parseModelSelection(config.sessionTitleModel);
    if (!selection) {
      throw new Error(`Invalid sessionTitleModel. Expected provider/model or provider/model:variant for a supported provider: ${config.sessionTitleModel}`);
    }
    sessionTitleModelSelection = selection;
  }

  if (config.cycleModels) {
    const parsed = config.cycleModels.map((modelSelection) => ({ raw: modelSelection, parsed: parseModelSelection(modelSelection) }));
    const invalid = parsed.filter((entry) => !entry.parsed).map((entry) => entry.raw);
    if (invalid.length > 0) {
      throw new Error(`Invalid cycleModels entries. Expected provider/model or provider/model:variant ids for supported providers: ${invalid.join(", ")}`);
    }
    cycleModelSelections = parsed.map((entry) => entry.parsed as ModelSelection);
  }

  if (config.defaultModel !== undefined) {
    const selection = parseModelSelection(config.defaultModel);
    if (!selection) {
      throw new Error(`Invalid defaultModel. Expected provider/model or provider/model:variant for a supported provider: ${config.defaultModel}`);
    }
    selectModelSelection(selection);
  } else if (!cycleModelSelections.some((selection) => selection.modelId === currentModelId)) {
    selectModelSelection(cycleModelSelections[0]);
  }
}

function formatSessionList(sessions: SessionListItem[]): string {
  if (sessions.length === 0) {
    return `No sessions for ${formatCwd(process.cwd())}.`;
  }

  const rows = sessions.map((session) => {
    const marker = [
      session.starred ? "★" : "",
      session.id === activeSession.id ? "*" : "",
    ].filter(Boolean).join(" ");
    return [
      `\`${session.id}\`${marker ? ` ${marker}` : ""}`,
      formatSessionTimestamp(session.updatedAt),
      String(session.entryCount),
      formatSessionCost(session.cost, DEFAULT_COST_DISPLAY_CONFIG),
      escapeTableCell(session.currentModelId),
      escapeTableCell(session.title ?? ""),
    ];
  });

  return [
    `Project: ${formatCwd(process.cwd())}`,
    "",
    "| Session | Updated | Entries | Cost | Model | Title |",
    "|---|---|---:|---:|---|---|",
    ...rows.map((row) => `| ${row.join(" | ")} |`),
    "",
    "Use `/resume <session-id>` to resume a session. `★` marks a starred session and `*` marks the active session.",
  ].join("\n");
}

function formatSessionTimestamp(timestamp: string): string {
  return timestamp.replace("T", " ").replace(/\.\d{3}Z$/, "Z");
}

function escapeTableCell(value: string): string {
  return value.replaceAll("|", "\\|").replace(/\s+/g, " ").trim();
}

async function handleCommand(command: string): Promise<boolean> {
  const [name, ...args] = command.split(/\s+/);

  switch (name) {
    case "/new":
      activateSession(createSession(process.cwd(), currentModelId, currentModelVariantId()));
      return true;
    case "/exit":
    case "/quit": {
      await flushPreferenceSave();
      await shutdownMcpServers();
      tui.stop();
      process.exit(0);
    }
    case "/model": {
      const requestedModel = args[0];
      if (!requestedModel) {
        tui.addBlock({
          role: "assistant",
          title: "Model",
          content: `Current model: ${formatCurrentModelSelection()}\n\nCycle models:\n${formatModelList()}\n\nUsage: /model <model-id>[:variant]`,
        });
        return true;
      }

      const resolved = parseModelSelection(requestedModel);
      if (!resolved) {
        tui.addBlock({
          role: "error",
          title: "Unknown model",
          content: `Unknown model: ${requestedModel}\n\nUse a full model id in the form provider/model or provider/model:variant.\n\nCycle models:\n${formatModelList()}`,
        });
        return true;
      }

      selectModelSelection(resolved);
      tui.addBlock({ role: "assistant", title: "Model", content: `Model changed to ${formatCurrentModelSelection()}.` });
      return true;
    }
    case "/models": {
      tui.openModelOverlay();
      return true;
    }
    case "/mcps": {
      void tui.openMcpOverlay();
      return true;
    }
    case "/variants":
    case "/variant": {
      const requestedVariant = args[0];
      if (!requestedVariant) {
        tui.addBlock({ role: "assistant", title: "Variants", content: formatVariantList() });
        return true;
      }

      const normalizedVariant = requestedVariant.toLowerCase();
      if (["unset", "none", "default", "clear"].includes(normalizedVariant)) {
        updateCurrentModelVariant(undefined);
        tui.addBlock({ role: "assistant", title: "Variant", content: `Variant changed to ${formatCurrentModelSelection()} (unset).` });
        return true;
      }

      if (!getModelVariant(currentModelId, requestedVariant)) {
        tui.addBlock({
          role: "error",
          title: "Unknown variant",
          content: `Unknown variant for ${currentModelId}: ${requestedVariant}\n\n${formatVariantList()}`,
        });
        return true;
      }

      updateCurrentModelVariant(requestedVariant);
      tui.addBlock({ role: "assistant", title: "Variant", content: `Variant changed to ${formatCurrentModelSelection()}.` });
      return true;
    }
    case "/sessions": {
      const sessions = await listSessions(process.cwd());
      const sortedSessions = sessions.slice().sort((a, b) => {
        if (a.starred && !b.starred) return -1;
        if (!a.starred && b.starred) return 1;
        return b.updatedAt.localeCompare(a.updatedAt);
      });
      tui.openSessionOverlay(sortedSessions.map((session) => ({
        id: session.id,
        updatedAt: session.updatedAt,
        entryCount: session.entryCount,
        currentModelId: session.currentModelId,
        title: session.title,
        starred: session.starred,
        isActive: session.id === activeSession.id,
        cost: session.cost,
      })));
      return true;
    }
    case "/resume": {
      const sessionId = args[0];
      if (!sessionId) {
        tui.addBlock({ role: "error", title: "Error", content: "Usage: /resume <session-id>" });
        return true;
      }

      await resumeSessionById(sessionId);
      return true;
    }
    case "/star": {
      const nextStarred = !activeSession.starred;
      activeSession = {
        ...activeSession,
        starred: nextStarred,
        updatedAt: new Date().toISOString(),
      };
      await saveSession(activeSession);
      tui.setSessionStarred(nextStarred);
      tui.setStatus(nextStarred ? "Session starred" : "Session unstarred");
      return true;
    }
    case "/tree": {
      const items = sessionToTreeOverlayEntries(activeSession);
      if (items.length === 0) {
        tui.addBlock({ role: "assistant", title: "Tree", content: "The current session is empty." });
        return true;
      }
      tui.openTreeOverlay(items);
      return true;
    }
    case "/undo": {
      const path = getActivePath(activeSession);
      let lastUserText = "";
      for (let i = path.length - 1; i >= 0; i -= 1) {
        const entry = path[i];
        if (entry.type === "user") {
          const texts: string[] = [];
          for (const block of entry.content) {
            if (block.type === "text") {
              texts.push(block.text);
            }
          }
          lastUserText = texts.join("");
          break;
        }
      }

      const previousActiveEntryId = activeSession.activeEntryId;
      const nextSession = undoLastUserTurn(activeSession);

      if (nextSession.activeEntryId === previousActiveEntryId) {
        return true;
      }

      activeSession = nextSession;
      await saveSession(activeSession);
      rebuildTuiFromSession();
      refreshSessionStatsFromSession();
      tui.setInput(lastUserText);
      return true;
    }
    case "/compact": {
      const focus = args.join(" ").trim() || undefined;
      if (promptRunning) {
        tui.setStatus("Agent is still running");
        return true;
      }

      const plan = planCompaction(getActivePath(activeSession), {
        keepRecentTokens: compactionConfig.keepRecentTokens,
      });
      if (!plan) {
        tui.addBlock({
          role: "assistant",
          title: "Compact",
          content: `Nothing to compact (context ≈ ${formatTokenCount(lastInputTokens + lastOutputTokens)} tokens).`,
        });
        return true;
      }

      promptRunning = true;
      const abortController = new AbortController();
      currentAbortController = abortController;
      tui.setRunning(true, "Compacting");

      const blockId = tui.addBlock({
        role: "assistant",
        title: "Compacting context…",
        content: "",
        state: "running",
      });

      try {
        const entry = await compactContext({
          trigger: "manual",
          focus,
          signal: abortController.signal,
        });
        if (entry) {
          tui.updateBlock(blockId, {
            title: `Context compacted · ${formatTokenCount(entry.tokensBefore)} → ~${formatTokenCount(entry.tokensAfter)} tokens`,
            content: entry.summary,
            collapsed: true,
            state: "done",
          });
        } else {
          tui.updateBlock(blockId, {
            title: "Compact",
            content: "Nothing to compact.",
            state: "done",
          });
        }
      } catch (error: unknown) {
        if (isAbortError(error)) {
          tui.updateBlock(blockId, { title: "Cancelled", content: "Compaction cancelled.", state: "error" });
        } else {
          tui.updateBlock(blockId, { title: "Compaction failed", content: formatError(error), state: "error" });
        }
      } finally {
        promptRunning = false;
        currentAbortController = null;
        tui.setRunning(false, "idle");
      }
      return true;
    }
    case "/skills": {
      const skills = await discoverSkills();
      tui.addBlock({
        role: "assistant",
        title: "Skills",
        content: formatSkillsListing(skills),
      });
      return true;
    }
    case "/agents": {
      const agents = await discoverAgents();
      tui.addBlock({
        role: "assistant",
        title: "Agents",
        content: formatAgentsListing(agents),
      });
      return true;
    }
    case "/mcp": {
      tui.addBlock({
        role: "assistant",
        title: "MCP Servers",
        content: formatMcpListing(),
      });
      return true;
    }
    case "/themes":
    case "/theme": {
      const requestedTheme = args[0];
      if (!requestedTheme) {
        const allThemes = ["dark", "light"];
        tui.addBlock({
          role: "assistant",
          title: "Themes",
          content: `Available themes:\n${allThemes.map((t) => `- ${t}`).join("\n")}\n\nUsage: /theme dark|light`,
        });
        return true;
      }
      if (requestedTheme !== "dark" && requestedTheme !== "light") {
        tui.addBlock({
          role: "error",
          title: "Unknown theme",
          content: `Unknown theme: ${requestedTheme}\n\nAvailable themes: dark, light`,
        });
        return true;
      }
      switchTheme(requestedTheme);
      return true;
    }
    default: {
      // Handle /skill:<name> [args]
      if (name && name.startsWith("/skill:")) {
        const skillName = name.slice("/skill:".length);
        if (!skillName) {
          tui.addBlock({ role: "error", title: "Error", content: "Usage: /skill:<name> [arguments]" });
          return true;
        }

        const skills = await discoverSkills();
        const skill = findSkill(skills, skillName);
        if (!skill) {
          tui.addBlock({
            role: "error",
            title: "Unknown skill",
            content: `Unknown skill: ${skillName}\n\nUse /skills to see available skills.`,
          });
          return true;
        }

        let content = await loadSkillContent(skill);
        const skillArgs = args.join(" ");
        if (skillArgs) {
          content = content.replaceAll("$ARGUMENTS", skillArgs);
        }

        // Inject the skill content as a user message and prompt
        if (promptRunning) {
          tui.setStatus("Agent is still running");
          return true;
        }

        promptRunning = true;
        tui.setRunning(true, "reasoning");

        try {
          const displayText = skillArgs
            ? `/skill:${skillName} ${skillArgs}`
            : `/skill:${skillName}`;
          await prompt(displayText, [{ type: "text", text: content }]);
        } catch (error: unknown) {
          tui.addBlock({ role: "error", title: "Error", content: formatError(error) });
        } finally {
          promptRunning = false;
          tui.setRunning(false, "idle");
          if (!tui.isFocused) {
            sendDoneNotification(activeSession);
          }
        }

        return true;
      }

      tui.addBlock({ role: "error", title: "Unknown command", content: `Unknown command: ${name}` });
      return true;
    }
  }
}

async function handlePasteImage(): Promise<void> {
  if (pasteInFlight) return;
  pasteInFlight = true;

  try {
    const clipboardImage = await readClipboardImage();
    if (!clipboardImage) {
      // No image on clipboard — do nothing silently
      return;
    }

    if (clipboardImage.data.length > MAX_IMAGE_BYTES) {
      tui.setStatus("Image too large (max 5 MB)");
      return;
    }

    const base64Data = clipboardImage.data.toString("base64");
    const encodedSize = base64Data.length;
    const pendingPayload = estimatePendingImagePayload();

    if (pendingPayload + encodedSize > MAX_REQUEST_BYTES * REQUEST_IMAGE_PAYLOAD_WARNING_RATIO) {
      tui.setStatus("Attached images too large — use fewer/smaller images");
      return;
    }

    clipboardCounter += 1;
    const attachment: ImageAttachment = {
      mediaType: clipboardImage.mediaType,
      data: base64Data,
      rawSize: clipboardImage.data.length,
      label: `clipboard-${clipboardCounter}`,
    };

    pendingImages.push(attachment);
    tui.setImageCount(pendingImages.length);
  } catch {
    // Clipboard subprocess failure — swallow silently
  } finally {
    pasteInFlight = false;
  }
}

type ParsedUserInput = {
  displayText: string;
  contentBlocks: (ImageBlock | { type: "text"; text: string })[];
  error?: string;
};

function stripExistingFileRef(fullMatch: string, rawPath: string): string {
  if (rawPath.startsWith("image(")) return fullMatch;
  const filePath = resolve(expandHomePath(rawPath));
  if (existsSync(filePath)) {
    return rawPath;
  }
  return fullMatch;
}

async function parseUserInput(raw: string): Promise<ParsedUserInput> {
  const images: ImageAttachment[] = [...pendingImages];
  let displayText = raw;
  let modelText = raw;

  // Replace @file references with bare file names if the file exists
  displayText = displayText.replace(/(?<!\S)@([^\s]+)/g, stripExistingFileRef);
  modelText = modelText.replace(/(?<!\S)@([^\s]+)/g, stripExistingFileRef);

  // Process @image(...) references
  const imageRefMatches = Array.from(raw.matchAll(IMAGE_REF_PATTERN));
  for (const match of imageRefMatches) {
    const rawPath = match[1].trim();
    const filePath = resolve(expandHomePath(rawPath));
    const mime = mimeFromExtension(filePath);

    if (!mime) {
      return { displayText: raw, contentBlocks: [], error: `Unsupported image format: ${rawPath}` };
    }

    if (!existsSync(filePath)) {
      return { displayText: raw, contentBlocks: [], error: `Image not found: ${rawPath}` };
    }

    try {
      const fileStat = await stat(filePath);
      if (fileStat.size > MAX_IMAGE_BYTES) {
        return { displayText: raw, contentBlocks: [], error: `Image too large: ${rawPath} (max 5 MB)` };
      }

      const data = await readFile(filePath);
      const label = rawPath.split("/").pop() ?? rawPath;
      images.push({
        mediaType: mime,
        data: data.toString("base64"),
        rawSize: data.length,
        label,
      });

      // Remove @image(...) from model text, replace with label in display
      modelText = modelText.replace(match[0], "");
      displayText = displayText.replace(match[0], `[Image: ${label}]`);
    } catch {
      return { displayText: raw, contentBlocks: [], error: `Failed to read image: ${rawPath}` };
    }
  }

  // Process bare image file paths
  const bareMatches = Array.from(modelText.matchAll(BARE_IMAGE_PATH_PATTERN));
  for (const match of bareMatches) {
    const rawPath = match[1].trim();
    const filePath = resolve(expandHomePath(rawPath));
    const mime = mimeFromExtension(filePath);

    if (!mime || !existsSync(filePath)) {
      continue; // Not a valid image path — leave as text
    }

    try {
      const fileStat = await stat(filePath);
      if (fileStat.size > MAX_IMAGE_BYTES) {
        return { displayText: raw, contentBlocks: [], error: `Image too large: ${rawPath} (max 5 MB)` };
      }

      const data = await readFile(filePath);
      const label = rawPath.split("/").pop() ?? rawPath;
      images.push({
        mediaType: mime,
        data: data.toString("base64"),
        rawSize: data.length,
        label,
      });
      // Bare paths are left in model text — just attach the image in addition
    } catch {
      // Silently skip unreadable bare paths
    }
  }

  // Replace @file.txt mentions with just file.txt when the file exists
  for (const match of Array.from(modelText.matchAll(FILE_REF_PATTERN))) {
    const rawPath = match[1];
    const filePath = resolve(expandHomePath(rawPath));
    if (existsSync(filePath)) {
      modelText = modelText.replace(match[0], rawPath);
      displayText = displayText.replace(match[0], rawPath);
    }
  }

  // Check aggregate size of newly attached images. Older conversation images
  // are capped non-destructively before provider requests are sent.
  let newPayload = 0;
  for (const img of images) {
    newPayload += estimateBase64Size(img.rawSize);
  }
  if (newPayload > MAX_REQUEST_BYTES * REQUEST_IMAGE_PAYLOAD_WARNING_RATIO) {
    return { displayText: raw, contentBlocks: [], error: "Attached images are too large. Use fewer or smaller images." };
  }

  // Build content blocks — images before text (Anthropic recommendation)
  const contentBlocks: (ImageBlock | { type: "text"; text: string })[] = [];

  for (const img of images) {
    contentBlocks.push({
      type: "image" as const,
      mediaType: img.mediaType,
      data: img.data,
    });
  }

  // Add display labels for clipboard images
  for (const img of pendingImages) {
    displayText = `[Image: ${img.label}] ${displayText}`;
  }

  const cleanedModelText = modelText
    .replace(/[ \t]+/g, " ")      // collapse runs of spaces/tabs
    .replace(/ *\n */g, "\n")     // trim spaces around newlines
    .replace(/\n{3,}/g, "\n\n")   // cap consecutive blank lines at 2
    .trim();
  if (cleanedModelText) {
    contentBlocks.push({ type: "text" as const, text: cleanedModelText });
  }

  return { displayText: displayText.trim(), contentBlocks };
}

function ensureToolBlock(
  toolBlocks: Map<string, number>,
  toolUseId: string,
  toolName: string,
): number {
  const existing = toolBlocks.get(toolUseId);
  if (existing !== undefined) {
    return existing;
  }

  const id = tui.addBlock({
    role: "tool",
    title: visualizeToolTitle(toolName, {}),
    content: "",
    state: "running",
  });
  toolBlocks.set(toolUseId, id);
  return id;
}


async function handleUserInput(userMessage: string) {
  if (promptRunning) {
    tui.setStatus("Agent is still running");
    return;
  }

  if (userMessage.startsWith("/")) {
    await handleCommand(userMessage.trim());
    return;
  }

  if (userMessage.startsWith("!")) {
    const command = userMessage.slice(1).trim();
    if (!command) {
      tui.addBlock({ role: "error", title: "Error", content: "No command provided after `!`." });
      return;
    }

    const bashTool = tools.find((t) => t.name === "bash");
    if (!bashTool) {
      tui.addBlock({ role: "error", title: "Error", content: "bash tool not found." });
      return;
    }

    tui.addBlock({ role: "user", content: userMessage });

    const blockId = tui.addBlock({ role: "tool", title: `bash: ${command}`, content: "", state: "running" });

    try {
      let streamedToolContent = "";
      const rawOutput = await bashTool.execute({ command }, undefined, {
        onOutput: (chunk) => {
          streamedToolContent += chunk;
          tui.updateBlock(blockId, { content: streamedToolContent });
        },
      });
      const output = await truncateToolOutputIfNeeded(rawOutput, "bash");
      const content = formatToolResultBody(output);
      tui.updateBlock(blockId, { content, state: output.is_error ? "error" : "done" });
    } catch (error: unknown) {
      tui.updateBlock(blockId, { content: formatError(error), state: "error" });
    } finally {
      refreshCwd();
    }

    return;
  }

  promptRunning = true;
  tui.setRunning(true, "reasoning");

  try {
    // Parse user input for images
    const parsed = await parseUserInput(userMessage);

    if (parsed.error) {
      tui.addBlock({ role: "error", title: "Error", content: parsed.error });
      // Keep pending images so the user can fix text or change model
      promptRunning = false;
      tui.setRunning(false, "idle");
      return;
    }

    const hasImages = parsed.contentBlocks.some((b) => b.type === "image");

    // Check model vision capability
    if (hasImages && !currentModelConfig().supportsImages) {
      tui.addBlock({
        role: "error",
        title: "Error",
        content: `Current model does not support image input: ${currentModelId}`,
      });
      // Keep pending images so the user can switch model
      promptRunning = false;
      tui.setRunning(false, "idle");
      return;
    }

    // Older conversation images are capped non-destructively before provider
    // requests are sent, so text-only turns can continue even after many
    // screenshots have accumulated in saved history.

    // Clear pending images on successful parse
    pendingImages = [];
    tui.setImageCount(0);

    await prompt(parsed.displayText, parsed.contentBlocks);
  } catch (error: unknown) {
    tui.addBlock({ role: "error", title: "Error", content: formatError(error) });
  } finally {
    promptRunning = false;
    tui.setRunning(false, "idle");
    const nextSteering = steeringQueue.shift();
    tui.setSteeringQueueCount(steeringQueue.length);
    if (nextSteering !== undefined) {
      // The turn ended before this steering message could be delivered.
      // Run it as a new prompt instead.
      handleUserInput(nextSteering).catch((error: unknown) => {
        tui.addBlock({ role: "error", title: "Error", content: formatError(error) });
      });
    } else if (!tui.isFocused) {
      sendDoneNotification(activeSession);
    }
  }
}

async function prompt(
  displayText: string,
  contentBlocks?: (ImageBlock | { type: "text"; text: string })[],
) {
  tui.addBlock({ role: "user", content: displayText });
  const shouldGenerateSessionTitle = !activeSession.title
    && !getActivePath(activeSession).some((entry) => entry.type === "user");
  const sessionTitleSessionId = activeSession.id;
  const turnDraft = createTurnDraft(activeSession);
  let turnDraftCommitted = false;

  const commitAndSaveTurnDraft = async () => {
    if (turnDraftCommitted) {
      return;
    }

    activeSession = commitTurnDraft(activeSession, turnDraft);
    turnDraftCommitted = true;
    await saveSession(activeSession);
  };

  const userContentBlocks = contentBlocks && contentBlocks.length > 0
    ? contentBlocks
    : [{ type: "text" as const, text: displayText }];

  appendTurnDraftEntry(turnDraft, createUserEntry({
    content: userContentBlocks,
  }));

  if (shouldGenerateSessionTitle) {
    maybeGenerateSessionTitleFromFirstMessage(sessionTitleSessionId, userContentBlocks);
  }

  const abortController = new AbortController();
  currentAbortController = abortController;
  const signal = abortController.signal;

  // Build system text: base → skills → MCP → AGENTS.md. Also refreshes the
  // skill/agent/subagent runtime.
  const systemText = await buildAgentSystemText();

  const modelConfig = currentModelConfig();
  const modelVariant = currentModelVariant();
  const provider = await resolveProvider(modelConfig);
  const toolDefs = getProviderToolDefinitions();

  // ── View state driven by loop events ──
  let accText = "";
  let currentTextBlockId: number | undefined;
  let accReasoning = "";
  let currentReasoningBlockId: number | undefined;
  let currentReasoningTitle: string | undefined;
  const reasoningBlocks: ThinkingBlock[] = [];
  const streamingTools = new Map<string, { name: string; inputJson: string }>();
  const toolBlocks = new Map<string, number>();
  const streamedToolContentByTool = new Map<string, string>();
  const runningToolUseIds = new Set<string>();
  let imageCapNoticeShown = false;

  const finishReasoningBlock = () => {
    if (currentReasoningBlockId === undefined) {
      return;
    }

    if (accReasoning) {
      reasoningBlocks.push({ type: "thinking", thinking: accReasoning });
    }

    tui.updateBlock(currentReasoningBlockId, {
      title: reasoningDisplayTitle(accReasoning),
      collapsed: true,
    });
    currentReasoningBlockId = undefined;
    accReasoning = "";
    currentReasoningTitle = undefined;
  };

  try {
    const result = await runAgentLoop({
      provider,
      model: modelConfig.providerModel,
      system: systemText,
      tools,
      toolDefs,
      maxTokens: modelConfig.maxOutputTokens,
      providerOptions: {
        ...(modelConfig.providerOptions ?? {}),
        ...(modelVariant?.providerOptions ?? {}),
        ...((modelConfig.provider === "opencode" || modelConfig.provider === "fireworks"
          || modelConfig.provider === "friendli")
          && { supportsImages: modelConfig.supportsImages }),
      },
      signal,

      compaction: (() => {
        const threshold = effectiveCompactionThreshold(modelConfig);
        if (threshold === undefined) {
          return undefined;
        }
        return {
          thresholdTokens: threshold,
          initialContextTokens: lastInputTokens + lastOutputTokens,
          compact: async () => {
            // Circuit breaker: 3 consecutive summarizer failures disable
            // auto-compaction for the rest of the session. Manual /compact
            // is never blocked by it.
            if (autoCompactionDisabled) {
              return;
            }
            tui.setRunning(true, "Compacting");
            let succeeded = false;
            try {
              const entry = await compactContext({
                trigger: "auto",
                draft: turnDraft,
                signal,
              });
              if (entry) {
                succeeded = true;
                compactionFailures = 0;
                tui.addBlock({
                  role: "assistant",
                  title: `Context compacted · ${formatTokenCount(entry.tokensBefore)} → ~${formatTokenCount(entry.tokensAfter)} tokens`,
                  content: entry.summary,
                  collapsed: true,
                });
              }
            } catch (error) {
              if (isAbortError(error)) throw error;
              compactionFailures += 1;
              if (compactionFailures >= 3) {
                autoCompactionDisabled = true;
                tui.addBlock({
                  role: "error",
                  title: "Auto-compaction disabled",
                  content: `Compaction failed ${compactionFailures} consecutive times and is disabled for this session. Manual /compact still works.\n\n${formatError(error)}`,
                });
              } else {
                tui.addBlock({
                  role: "error",
                  title: "Compaction failed",
                  content: formatError(error),
                });
              }
            } finally {
              // On success the "Compacted X → ~Y" status set by
              // compactContext stays until the next stream event; on
              // failure restore the loop's running indicator.
              if (!succeeded) {
                tui.setRunning(true, "Reasoning");
              }
            }
          },
        };
      })(),

      takeSteeringMessages: () => {
        const steeringMessages = steeringQueue.splice(0);
        for (const steeringText of steeringMessages) {
          appendTurnDraftEntry(turnDraft, createUserEntry({
            content: [{ type: "text", text: steeringText }],
            steering: true,
          }));
          tui.addBlock({ role: "user", content: steeringText });
        }
        tui.setSteeringQueueCount(0);
        return steeringMessages;
      },

      getMessages: () => {
        // Reasoning blocks are scoped to a single provider request.
        reasoningBlocks.length = 0;
        const imageCap = capProviderMessageImages(
          sessionToProviderMessages(activeSession, turnDraft),
          MAX_REQUEST_BYTES * REQUEST_IMAGE_PAYLOAD_WARNING_RATIO,
        );
        if (imageCap.droppedImages > 0 && !imageCapNoticeShown) {
          imageCapNoticeShown = true;
          tui.addBlock({
            role: "assistant",
            title: "Context images omitted",
            content: `${imageCap.droppedImages} older image${imageCap.droppedImages === 1 ? "" : "s"} (${(imageCap.droppedBytes / (1024 * 1024)).toFixed(1)} MB base64) omitted from this provider request to stay under the request-size limit. Saved session history is unchanged.`,
          });
        }
        return imageCap.messages;
      },

      computeCost: (usage) => computeCallCost(
        modelConfig,
        usage.inputTokens,
        // For cost: use inputTokens minus cache tokens for the base input cost
        usage.inputTokens - usage.cacheCreationTokens - usage.cacheReadTokens,
        usage.cacheCreationTokens,
        usage.cacheReadTokens,
        usage.outputTokens,
      ),

      onStreamEvent: (event) => {
        switch (event.type) {
          case "text_start": {
            finishReasoningBlock();
            accText = event.text;
            currentTextBlockId = tui.addBlock({
              role: "assistant",
              content: accText,
            });
            tui.setStatus("Streaming response");
            break;
          }

          case "text_delta": {
            finishReasoningBlock();
            accText += event.text;
            if (currentTextBlockId === undefined) {
              currentTextBlockId = tui.addBlock({
                role: "assistant",
                content: accText,
              });
            } else {
              tui.updateBlock(currentTextBlockId, accText);
            }
            tui.setStatus("Streaming response");
            break;
          }

          case "reasoning_start": {
            currentTextBlockId = undefined;
            accText = "";
            accReasoning = event.text;
            currentReasoningTitle = reasoningTitle(accReasoning) ?? undefined;
            currentReasoningBlockId = tui.addBlock({
              role: "reasoning",
              title: reasoningDisplayTitle(accReasoning),
              content: reasoningDisplayContent(accReasoning),
              collapsed: false,
            });
            tui.setStatus("Reasoning");
            break;
          }

          case "reasoning_delta": {
            currentTextBlockId = undefined;
            accText = "";
            accReasoning += event.text;
            const discoveredTitle = reasoningTitle(accReasoning);
            if (discoveredTitle && discoveredTitle !== currentReasoningTitle) {
              currentReasoningTitle = discoveredTitle;
            }
            if (currentReasoningBlockId === undefined) {
              currentReasoningBlockId = tui.addBlock({
                role: "reasoning",
                title: reasoningDisplayTitle(accReasoning),
                content: reasoningDisplayContent(accReasoning),
                collapsed: false,
              });
            } else {
              tui.updateBlock(currentReasoningBlockId, {
                content: reasoningDisplayContent(accReasoning),
                title: reasoningDisplayTitle(accReasoning),
              });
            }
            tui.setStatus("Thinking");
            break;
          }

          case "tool_use_start": {
            streamingTools.set(event.id, { name: event.name, inputJson: "" });
            currentTextBlockId = undefined;
            accText = "";
            finishReasoningBlock();
            ensureToolBlock(toolBlocks, event.id, event.name);
            runningToolUseIds.add(event.id);
            tui.setStatus(`Preparing tool: ${event.name}`);
            break;
          }

          case "tool_input_delta": {
            const state = streamingTools.get(event.id);
            if (state) {
              state.inputJson += event.partialJson;
              const id = ensureToolBlock(toolBlocks, event.id, state.name);
              tui.updateBlock(id, { title: visualizeToolPartialTitle(state.name, state.inputJson) });
            }
            break;
          }

          case "block_stop": {
            if (event.id) {
              streamingTools.delete(event.id);
            } else {
              finishReasoningBlock();
              currentTextBlockId = undefined;
              accText = "";
            }
            break;
          }
        }
      },

      onToolOutput: (toolUseId, chunk) => {
        const blockId = toolBlocks.get(toolUseId);
        if (blockId !== undefined) {
          streamedToolContentByTool.set(toolUseId, (streamedToolContentByTool.get(toolUseId) ?? "") + chunk);
          tui.updateBlock(blockId, { content: streamedToolContentByTool.get(toolUseId) ?? "" });
        }
      },

      onToolContent: (toolUseId, content) => {
        const blockId = toolBlocks.get(toolUseId);
        if (blockId !== undefined) {
          streamedToolContentByTool.set(toolUseId, content);
          tui.updateBlock(blockId, { content });
        }
      },

      onResponse: (response, meta) => {
        lastCacheReadTokens = response.usage.cacheReadTokens;
        lastCacheCreationTokens = response.usage.cacheCreationTokens;
        lastInputTokens = response.usage.inputTokens;
        lastOutputTokens = response.usage.outputTokens;

        accumulatedCost += meta.cost;
        tui.setCost(accumulatedCost);

        updateContextInfo();

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
      },

      onToolResult: (executed) => {
        // Per-tool UI flip so parallel tools finish their spinner
        // independently. Persistence and cost stay in onToolResults.
        runningToolUseIds.delete(executed.result.tool_use_id);
        streamedToolContentByTool.delete(executed.result.tool_use_id);

        const blockId = toolBlocks.get(executed.result.tool_use_id);
        if (blockId !== undefined) {
          tui.updateBlock(blockId, {
            content: executed.display,
            state: executed.result.is_error ? "error" : "done",
          });
        }
      },

      onToolResults: (executedTools) => {
        for (const executed of executedTools) {
          runningToolUseIds.delete(executed.result.tool_use_id);
          streamedToolContentByTool.delete(executed.result.tool_use_id);

          if (executed.cost !== undefined && executed.cost > 0) {
            accumulatedCost += executed.cost;
            tui.setCost(accumulatedCost);
          }

          const blockId = toolBlocks.get(executed.result.tool_use_id);
          if (blockId !== undefined) {
            tui.updateBlock(blockId, {
              content: executed.display,
              state: executed.result.is_error ? "error" : "done",
            });
          }

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

    await commitAndSaveTurnDraft();

    if (result.cancelled) {
      // Mark any in-progress tool blocks as cancelled
      for (const [toolUseId, blockId] of toolBlocks) {
        if (runningToolUseIds.has(toolUseId)) {
          tui.updateBlock(blockId, { content: "Cancelled", state: "error" });
        }
      }

      tui.addBlock({
        role: "assistant",
        title: "Cancelled",
        content: "Prompt execution cancelled.",
      });
      return;
    }

    // Show the turn usage summary after the final message. The draft's last
    // entry is the final assistant entry once the turn completed.
    const turnSummary = getTurnSummary(turnDraft.entries);
    if (turnSummary) {
      const lastEntry = turnDraft.entries[turnDraft.entries.length - 1];
      tui.addBlock({
        role: "meta",
        key: lastEntry ? `turn-summary:${lastEntry.id}` : undefined,
        content: formatTurnSummary(turnSummary, costDisplayConfig),
      });
    }
  } catch (error: unknown) {
    if (isAbortError(error)) {
      // Mark any in-progress tool blocks as cancelled
      for (const [toolUseId, blockId] of toolBlocks) {
        if (runningToolUseIds.has(toolUseId)) {
          tui.updateBlock(blockId, { content: "Cancelled", state: "error" });
        }
      }

      if (!turnDraftCommitted && !isTurnDraftEmpty(turnDraft)) {
        await commitAndSaveTurnDraft();
      }

      tui.addBlock({
        role: "assistant",
        title: "Cancelled",
        content: "Prompt execution cancelled.",
      });
      return;
    }
    if (!turnDraftCommitted && !isTurnDraftEmpty(turnDraft)) {
      await commitAndSaveTurnDraft();
    }
    throw error;
  } finally {
    currentAbortController = null;
  }
}

function parseCliArgs(): { resume: boolean; sessionId?: string } {
  // process.argv is [node, script, ...args]
  const args = process.argv.slice(2);
  const sessionIdIndex = args.indexOf("--session-id");
  const sessionId = sessionIdIndex !== -1 ? args[sessionIdIndex + 1] : undefined;
  return {
    resume: args.includes("--resume") || args.includes("-r"),
    ...(sessionId !== undefined && { sessionId }),
  };
}

async function main() {
  // `pace run ...` is the headless (non-interactive) mode. Dispatch it before
  // any TUI startup so it stays fast and never touches the terminal UI.
  if (process.argv[2] === "run") {
    const exitCode = await runHeadless(process.argv.slice(3));
    process.exit(exitCode);
  }

  const cliArgs = parseCliArgs();

  // Resolve config + persisted preferences before the first render so the
  // status bar shows the correct (last-used) model on the very first frame,
  // with no flash of the default model. Errors are buffered and surfaced
  // after the TUI starts.
  const startupErrors: Array<{ title: string; content: string }> = [];

  try {
    await loadCachedModelCatalog();
  } catch (error) {
    startupErrors.push({ title: "Model catalog", content: formatError(error) });
  }

  try {
    const paceConfig = await loadPaceConfig();
    costDisplayConfig = paceConfig.cost;
    compactionConfig = paceConfig.compaction;
    if (compactionConfig.model !== undefined && parseModelSelection(compactionConfig.model) === undefined) {
      throw new Error(`Invalid compaction.model. Expected provider/model or provider/model:variant for a supported provider: ${compactionConfig.model}`);
    }
    tui.setCostDisplayConfig(paceConfig.cost);
    applyConfiguredModels(paceConfig);
    syncThemeFromTerminal();
  } catch (error) {
    startupErrors.push({ title: "Pace config", content: formatError(error) });
  }

  try {
    applyStoredPreferences(await loadPreferences());
  } catch (error) {
    startupErrors.push({ title: "Pace preferences", content: formatError(error) });
  }

  updateContextInfo();

  // If --resume was passed, load the most recent session for this project.
  if (cliArgs.resume) {
    try {
      const sessions = await listSessions(process.cwd());
      if (sessions.length > 0) {
        const mostRecent = sessions[0]; // listSessions sorts by updatedAt desc
        const session = await loadSession(createProjectKey(process.cwd()), mostRecent.id);
        activateSession(session);
      }
    } catch (error) {
      startupErrors.push({ title: "Resume session", content: formatError(error) });
    }
  }

  // If --session-id was passed, load that specific session for this project.
  if (cliArgs.sessionId !== undefined) {
    try {
      const session = await loadSession(createProjectKey(process.cwd()), cliArgs.sessionId);
      activateSession(session);
    } catch {
      startupErrors.push({
        title: "Resume session",
        content: `No session with id ${cliArgs.sessionId} found for this project.`,
      });
    }
  }

  tui.start();

  process.on("SIGUSR2", () => {
    syncThemeFromTerminal();
  });
  // Omarchy hooks target running Pace instances with `SIGUSR2`.
  process.title = "pace";

  for (const { title, content } of startupErrors) {
    tui.addBlock({ role: "error", title, content });
  }

  void refreshModelCatalog()
    .then((result) => {
      if (result && result.addedModelIds.length > 0) {
        tui.setStatus(`Model catalog updated: ${result.addedModelIds.length} new model(s) available`);
      }
    })
    .catch((error) => {
      tui.setStatus(`Model catalog refresh failed: ${formatErrorMessage(error)}`);
    });

  // Initialise Shiki in the background. The hand-rolled tokenizer remains
  // active until the promise resolves, then Shiki takes over automatically.
  initHighlighter().catch(() => {
    // Non-fatal — hand-rolled highlighting stays active.
  });

  onEvent("rate-limit-retry", (event) => {
    const seconds = (event.waitMs / 1000).toFixed(1);
    tui.setStatus(`Rate limited on ${new URL(event.url).hostname}, retrying in ${seconds}s… (${event.attempt}/${event.maxRetries})`);
  });

  onEvent("stream-retry", (event) => {
    const seconds = (event.waitMs / 1000).toFixed(1);
    tui.setStatus(`Response stream interrupted (${event.reason}), retrying in ${seconds}s… (${event.attempt}/${event.maxRetries})`);
  });

  // Initialize MCP servers
  try {
    const { connected, errors } = await initMcpServers(mcpEnabledOverrides);
    if (connected.length > 0) {
      const serverNames = connected.map((s) => s.name).join(", ");
      const totalTools = connected.reduce((sum, s) => sum + s.tools.length, 0);
      tui.setStatus(`MCP: connected to ${connected.length} server(s) (${totalTools} tools): ${serverNames}`);
    }
    for (const err of errors) {
      tui.addBlock({
        role: "error",
        title: `MCP: ${err.name}`,
        content: err.error,
      });
    }
  } catch {
    // MCP init errors are already handled above; don't crash the app.
  }
}

process.on("uncaughtException", (error: unknown) => {
  tui.addBlock({ role: "error", title: "Uncaught exception", content: formatError(error) });
  promptRunning = false;
  tui.setRunning(false, "idle");
});

process.on("unhandledRejection", (reason: unknown) => {
  tui.addBlock({ role: "error", title: "Unhandled rejection", content: formatError(reason) });
  promptRunning = false;
  tui.setRunning(false, "idle");
});

main();
