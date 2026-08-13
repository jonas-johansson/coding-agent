import { createHash, randomUUID } from "crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import type {
  AssistantMessage,
  ContentBlock as ProviderContentBlock,
  ImageBlock,
  ProviderMessage,
  TextBlock,
  ToolResultContent,
  ToolResultPart as ProviderToolResultPart,
  ToolUseBlock,
  UserMessage,
} from "./provider";

export type { ImageBlock, TextBlock, ToolUseBlock };

export const SESSION_SCHEMA_VERSION = 1;

export type ThinkingBlock = {
  type: "thinking";
  thinking: string;
};

export type ToolResultPart = ProviderToolResultPart | ImageBlock;

export type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ImageBlock;

export type BaseEntry = {
  id: string;
  parentId: string | null;
  timestamp: string;
};

export type UserEntry = BaseEntry & {
  type: "user";
  content: (TextBlock | ImageBlock)[];
};

export type AssistantEntry = BaseEntry & {
  type: "assistant";
  content: ContentBlock[];
  provider: string;
  modelId: string;
  modelVariant?: string;
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  cost: number;
  /** Wall-clock time spent streaming this response, in milliseconds. */
  streamDurationMs?: number;
  providerMetadata?: unknown;
};

export type ToolResultEntry = BaseEntry & {
  type: "tool_result";
  toolUseId: string;
  content: ToolResultPart[];
  isError?: boolean;
  /** Optional cost incurred by the tool call (e.g. subagent model usage). */
  cost?: number;
};

export type SessionEntry = UserEntry | AssistantEntry | ToolResultEntry;

export type Session = {
  version: number;
  id: string;
  projectKey: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  currentModelId: string;
  currentModelVariant?: string;
  title?: string;
  starred?: boolean;
  activeEntryId: string | null;
  entries: SessionEntry[];
};

export type SessionListItem = {
  id: string;
  projectKey: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  currentModelId: string;
  currentModelVariant?: string;
  title?: string;
  starred?: boolean;
  activeEntryId: string | null;
  entryCount: number;
  cost: number;
  filePath: string;
};

export type TurnDraft = {
  baseActiveEntryId: string | null;
  entries: SessionEntry[];
};

type NewEntryFields = Partial<Pick<BaseEntry, "id" | "timestamp">>;

export type CreateUserEntryParams = NewEntryFields & Pick<UserEntry, "content">;

export type CreateAssistantEntryParams = NewEntryFields &
  Omit<AssistantEntry, keyof BaseEntry | "type">;

export type CreateToolResultEntryParams = NewEntryFields &
  Omit<ToolResultEntry, keyof BaseEntry | "type">;

let currentSessionId: string = randomUUID();

export function getSessionId(): string {
  return currentSessionId;
}

export function resetSession(): string {
  currentSessionId = randomUUID();
  return currentSessionId;
}

export function setCurrentSessionId(sessionId: string): void {
  currentSessionId = sessionId;
}

export function createProjectKey(cwd: string): string {
  return createHash("sha256").update(cwd).digest("base64url").slice(0, 32);
}

export function getSessionProjectDir(projectKey: string): string {
  assertSafeStorageSegment(projectKey, "projectKey");
  return join(homedir(), ".pace", "sessions", projectKey);
}

export function getSessionFilePath(projectKey: string, sessionId: string): string {
  assertSafeStorageSegment(projectKey, "projectKey");
  assertSafeStorageSegment(sessionId, "sessionId");
  return join(getSessionProjectDir(projectKey), `${sessionId}.json`);
}

export async function saveSession(session: Session): Promise<void> {
  if (session.version !== SESSION_SCHEMA_VERSION) {
    throw new Error(`Unsupported session schema version: ${session.version}`);
  }

  const projectDir = getSessionProjectDir(session.projectKey);
  const filePath = getSessionFilePath(session.projectKey, session.id);
  const tempPath = join(projectDir, `${session.id}.${process.pid}.${randomUUID()}.tmp`);

  await mkdir(projectDir, { recursive: true });

  try {
    await writeFile(tempPath, `${JSON.stringify(session, null, 2)}\n`, "utf8");
    await rename(tempPath, filePath);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

export async function loadSession(projectKey: string, sessionId: string): Promise<Session> {
  const filePath = getSessionFilePath(projectKey, sessionId);
  const session = parseSessionJson(await readFile(filePath, "utf8"), filePath);

  validateLoadedSession(session, projectKey, sessionId, filePath);
  setCurrentSessionId(session.id);

  return session;
}

export async function listSessions(cwd: string): Promise<SessionListItem[]> {
  const projectKey = createProjectKey(cwd);
  const projectDir = getSessionProjectDir(projectKey);
  let dirEntries;

  try {
    dirEntries = await readdir(projectDir, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const sessions: SessionListItem[] = [];

  for (const dirEntry of dirEntries) {
    if (!dirEntry.isFile() || !dirEntry.name.endsWith(".json")) {
      continue;
    }

    const filePath = join(projectDir, dirEntry.name);

    try {
      const sessionId = dirEntry.name.slice(0, -".json".length);
      const session = parseSessionJson(await readFile(filePath, "utf8"), filePath);
      validateLoadedSession(session, projectKey, sessionId, filePath);
      sessions.push(toSessionListItem(session, filePath));
    } catch {
      // Corrupt or unreadable sessions should not break the session listing.
    }
  }

  return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function createSession(cwd: string, currentModelId: string, currentModelVariant?: string): Session {
  const now = new Date().toISOString();
  const id = randomUUID();
  setCurrentSessionId(id);

  return {
    version: SESSION_SCHEMA_VERSION,
    id,
    projectKey: createProjectKey(cwd),
    cwd,
    createdAt: now,
    updatedAt: now,
    currentModelId,
    ...(currentModelVariant !== undefined && { currentModelVariant }),
    starred: false,
    activeEntryId: null,
    entries: [],
  };
}

export function createUserEntry(params: CreateUserEntryParams): UserEntry {
  return {
    ...createBaseEntry(params),
    type: "user",
    content: params.content,
  };
}

export function createAssistantEntry(params: CreateAssistantEntryParams): AssistantEntry {
  return {
    ...createBaseEntry(params),
    type: "assistant",
    content: params.content,
    provider: params.provider,
    modelId: params.modelId,
    ...(params.modelVariant !== undefined && { modelVariant: params.modelVariant }),
    tokensIn: params.tokensIn,
    tokensOut: params.tokensOut,
    ...(params.cacheReadTokens !== undefined && { cacheReadTokens: params.cacheReadTokens }),
    ...(params.cacheCreationTokens !== undefined && { cacheCreationTokens: params.cacheCreationTokens }),
    cost: params.cost,
    ...(params.streamDurationMs !== undefined && { streamDurationMs: params.streamDurationMs }),
    ...(params.providerMetadata !== undefined && { providerMetadata: params.providerMetadata }),
  };
}

export function createToolResultEntry(params: CreateToolResultEntryParams): ToolResultEntry {
  return {
    ...createBaseEntry(params),
    type: "tool_result",
    toolUseId: params.toolUseId,
    content: params.content,
    ...(params.isError && { isError: true }),
    ...(params.cost !== undefined && { cost: params.cost }),
  };
}

function createBaseEntry(params: NewEntryFields): BaseEntry {
  return {
    id: params.id ?? randomUUID(),
    parentId: null,
    timestamp: params.timestamp ?? new Date().toISOString(),
  };
}

export type SessionTreeNode = {
  entry: SessionEntry;
  children: SessionTreeNode[];
};

export function getTree(session: Session): SessionTreeNode[] {
  const nodeById = new Map<string, SessionTreeNode>();
  for (const entry of session.entries) {
    nodeById.set(entry.id, { entry, children: [] });
  }

  const roots: SessionTreeNode[] = [];
  for (const entry of session.entries) {
    const node = nodeById.get(entry.id);
    if (!node) {
      continue;
    }
    if (entry.parentId === null) {
      roots.push(node);
    } else {
      const parent = nodeById.get(entry.parentId);
      if (parent) {
        parent.children.push(node);
      } else {
        roots.push(node);
      }
    }
  }
  return roots;
}

export function getChildren(session: Session, parentId: string | null): SessionEntry[] {
  return session.entries.filter((entry) => entry.parentId === parentId);
}

export function setActiveEntryId(session: Session, entryId: string | null): Session {
  if (entryId !== null && !session.entries.some((entry) => entry.id === entryId)) {
    throw new Error(`Entry ${entryId} not found in session ${session.id}`);
  }

  return {
    ...session,
    activeEntryId: entryId,
    updatedAt: new Date().toISOString(),
  };
}

export function getActivePath(session: Session): SessionEntry[] {
  if (session.activeEntryId === null) {
    return [];
  }

  const entriesById = new Map(session.entries.map((entry) => [entry.id, entry]));
  const seen = new Set<string>();
  const path: SessionEntry[] = [];
  let entryId: string | null = session.activeEntryId;

  while (entryId !== null) {
    if (seen.has(entryId)) {
      throw new Error(`Session ${session.id} active path contains a cycle at entry ${entryId}`);
    }
    seen.add(entryId);

    const entry = entriesById.get(entryId);
    if (!entry) {
      throw new Error(`Session ${session.id} active path references missing entry ${entryId}`);
    }

    path.push(entry);
    entryId = entry.parentId;
  }

  return path.reverse();
}

export function appendEntries(
  session: Session,
  entries: readonly SessionEntry[],
  updatedAt = new Date().toISOString(),
): Session {
  if (entries.length === 0) {
    return session;
  }

  const existingIds = new Set(session.entries.map((entry) => entry.id));
  const appendedIds = new Set<string>();
  let parentId = session.activeEntryId;
  const appendedEntries: SessionEntry[] = [];

  for (const entry of entries) {
    if (existingIds.has(entry.id) || appendedIds.has(entry.id)) {
      throw new Error(`Duplicate session entry id: ${entry.id}`);
    }
    appendedIds.add(entry.id);

    const appendedEntry: SessionEntry = { ...entry, parentId };
    appendedEntries.push(appendedEntry);
    parentId = entry.id;
  }

  return {
    ...session,
    updatedAt,
    activeEntryId: parentId,
    entries: [...session.entries, ...appendedEntries],
  };
}

export function createTurnDraft(session: Session): TurnDraft {
  return {
    baseActiveEntryId: session.activeEntryId,
    entries: [],
  };
}

export function appendTurnDraftEntry(draft: TurnDraft, entry: SessionEntry): void {
  draft.entries.push(entry);
}

export function isTurnDraftEmpty(draft: TurnDraft): boolean {
  return draft.entries.length === 0;
}

export function commitTurnDraft(
  session: Session,
  draft: TurnDraft,
  updatedAt = new Date().toISOString(),
): Session {
  if (session.activeEntryId !== draft.baseActiveEntryId) {
    throw new Error("Cannot commit turn draft because the session active entry changed");
  }

  return appendEntries(session, draft.entries, updatedAt);
}

export function undoLastUserTurn(
  session: Session,
  updatedAt = new Date().toISOString(),
): Session {
  const path = getActivePath(session);

  for (let i = path.length - 1; i >= 0; i -= 1) {
    const entry = path[i];
    if (entry.type === "user") {
      return {
        ...session,
        updatedAt,
        activeEntryId: entry.parentId,
      };
    }
  }

  return session;
}

export function sessionToProviderMessages(session: Session, draft?: TurnDraft): ProviderMessage[] {
  if (draft && session.activeEntryId !== draft.baseActiveEntryId) {
    throw new Error("Cannot convert turn draft because the session active entry changed");
  }

  return entriesToProviderMessages([
    ...getActivePath(session),
    ...(draft?.entries ?? []),
  ]);
}

export function entriesToProviderMessages(entries: readonly SessionEntry[]): ProviderMessage[] {
  const messages: ProviderMessage[] = [];
  let pendingToolResults: ToolResultContent[] = [];

  const flushToolResults = () => {
    if (pendingToolResults.length === 0) {
      return;
    }

    messages.push({
      role: "user",
      content: pendingToolResults,
    });
    pendingToolResults = [];
  };

  for (const entry of entries) {
    if (entry.type === "tool_result") {
      pendingToolResults.push(toProviderToolResult(entry));
      continue;
    }

    flushToolResults();

    if (entry.type === "user") {
      messages.push(toProviderUserMessage(entry));
    } else {
      messages.push(toProviderAssistantMessage(entry));
    }
  }

  flushToolResults();
  return messages;
}

function toProviderUserMessage(entry: UserEntry): UserMessage {
  return {
    role: "user",
    content: entry.content,
  };
}

function toProviderAssistantMessage(entry: AssistantEntry): AssistantMessage {
  return {
    role: "assistant",
    content: entry.content.filter(isProviderAssistantContentBlock),
    ...(entry.providerMetadata !== undefined && { providerMetadata: entry.providerMetadata }),
  };
}

function toProviderToolResult(entry: ToolResultEntry): ToolResultContent {
  return {
    type: "tool_result",
    tool_use_id: entry.toolUseId,
    content: entry.content.filter(isProviderToolResultPart),
    ...(entry.isError && { is_error: true }),
  };
}

function isProviderAssistantContentBlock(block: ContentBlock): block is ProviderContentBlock {
  return block.type === "text" || block.type === "tool_use";
}

function isProviderToolResultPart(part: ToolResultPart): part is ProviderToolResultPart {
  return part.type === "text" || part.type === "image";
}

function assertSafeStorageSegment(value: string, label: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) {
    throw new Error(`Invalid ${label} for session storage: ${value}`);
  }
}

function parseSessionJson(raw: string, filePath: string): Session {
  let value: unknown;

  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Failed to parse session file ${filePath}: ${formatErrorMessage(error)}`);
  }

  if (isRecord(value) && value.version !== SESSION_SCHEMA_VERSION) {
    throw new Error(`Unsupported session schema version in ${filePath}: ${String(value.version)}`);
  }

  if (!isSession(value)) {
    throw new Error(`Invalid session file ${filePath}`);
  }

  return value;
}

function validateLoadedSession(
  session: Session,
  projectKey: string,
  sessionId: string,
  filePath: string,
): void {
  if (session.projectKey !== projectKey) {
    throw new Error(`Session file ${filePath} belongs to project ${session.projectKey}, not ${projectKey}`);
  }

  if (session.id !== sessionId) {
    throw new Error(`Session file ${filePath} contains session ${session.id}, not ${sessionId}`);
  }

  getActivePath(session);
}

function toSessionListItem(session: Session, filePath: string): SessionListItem {
  const title = session.title ?? firstUserMessagePreview(session);
  const cost = session.entries.reduce(
    (sum, entry) => sum + (entry.type === "assistant" ? entry.cost : 0)
      + (entry.type === "tool_result" ? (entry.cost ?? 0) : 0),
    0,
  );

  return {
    id: session.id,
    projectKey: session.projectKey,
    cwd: session.cwd,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    currentModelId: session.currentModelId,
    ...(title !== undefined && { title }),
    ...(session.starred && { starred: true }),
    activeEntryId: session.activeEntryId,
    entryCount: session.entries.length,
    cost,
    filePath,
  };
}

function firstUserMessagePreview(session: Session): string | undefined {
  const firstUserEntry = session.entries.find((entry): entry is UserEntry => entry.type === "user");
  const text = firstUserEntry?.content
    .filter((block): block is TextBlock => block.type === "text")
    .map((block) => block.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  if (!text) {
    return undefined;
  }

  return Array.from(text).slice(0, 80).join("");
}

function isSession(value: unknown): value is Session {
  return (
    isRecord(value)
    && value.version === SESSION_SCHEMA_VERSION
    && isString(value.id)
    && isString(value.projectKey)
    && isString(value.cwd)
    && isString(value.createdAt)
    && isString(value.updatedAt)
    && isString(value.currentModelId)
    && isOptionalString(value.currentModelVariant)
    && isOptionalString(value.title)
    && isOptionalBoolean(value.starred)
    && isNullableString(value.activeEntryId)
    && Array.isArray(value.entries)
    && value.entries.every(isSessionEntry)
  );
}

function isSessionEntry(value: unknown): value is SessionEntry {
  if (!isRecord(value) || !isBaseEntry(value)) {
    return false;
  }

  switch (value.type) {
    case "user":
      return Array.isArray(value.content) && value.content.every(isUserContentBlock);
    case "assistant":
      return (
        Array.isArray(value.content)
        && value.content.every(isSessionContentBlock)
        && isString(value.provider)
        && isString(value.modelId)
        && isOptionalString(value.modelVariant)
        && isNumber(value.tokensIn)
        && isNumber(value.tokensOut)
        && isOptionalNumber(value.cacheReadTokens)
        && isOptionalNumber(value.cacheCreationTokens)
        && isNumber(value.cost)
        && isOptionalNumber(value.streamDurationMs)
      );
    case "tool_result":
      return (
        isString(value.toolUseId)
        && Array.isArray(value.content)
        && value.content.every(isToolResultPart)
        && isOptionalBoolean(value.isError)
        && isOptionalNumber(value.cost)
      );
    default:
      return false;
  }
}

function isBaseEntry(value: Record<string, unknown>): boolean {
  return isString(value.id) && isNullableString(value.parentId) && isString(value.timestamp);
}

function isUserContentBlock(value: unknown): value is TextBlock | ImageBlock {
  return isTextBlock(value) || isImageBlock(value);
}

function isSessionContentBlock(value: unknown): value is ContentBlock {
  return isTextBlock(value) || isThinkingBlock(value) || isToolUseBlock(value) || isImageBlock(value);
}

function isToolResultPart(value: unknown): value is ToolResultPart {
  return isTextBlock(value) || isImageBlock(value);
}

function isTextBlock(value: unknown): value is TextBlock {
  return isRecord(value) && value.type === "text" && isString(value.text);
}

function isThinkingBlock(value: unknown): value is ThinkingBlock {
  return isRecord(value) && value.type === "thinking" && isString(value.thinking);
}

function isToolUseBlock(value: unknown): value is ToolUseBlock {
  return (
    isRecord(value)
    && value.type === "tool_use"
    && isString(value.id)
    && isString(value.name)
    && hasOwn(value, "input")
  );
}

function isImageBlock(value: unknown): value is ImageBlock {
  return (
    isRecord(value)
    && value.type === "image"
    && isSupportedImageMediaType(value.mediaType)
    && isString(value.data)
  );
}

function isSupportedImageMediaType(value: unknown): value is ImageBlock["mediaType"] {
  return (
    value === "image/jpeg"
    || value === "image/png"
    || value === "image/gif"
    || value === "image/webp"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || isString(value);
}

function isOptionalNumber(value: unknown): value is number | undefined {
  return value === undefined || isNumber(value);
}

function isOptionalBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === "boolean";
}

function isNullableString(value: unknown): value is string | null {
  return value === null || isString(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return isRecord(error) && typeof error.code === "string";
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
