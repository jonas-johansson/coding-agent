import { type BlockRole, type BlockTheme, type TuiTheme, BUILT_IN_THEMES } from "./themes.js";
import {
  DEFAULT_COST_DISPLAY_CONFIG,
  formatCost,
  formatCostAmount,
  formatSessionCost,
  formatTokenCount,
  type BlockState,
  type BlockPatch,
  type ContextInfo,
  type RenderBlock,
} from "./view-model";

import { homedir } from "os";
import { basename } from "path";
import { type CostDisplayConfig } from "./config";
import { tokenizeCode, hexToAnsi256, onHighlighterReady } from "./syntax.js";
import { fuzzyMatch } from "./fuzzy.js";

type SubmitHandler = (input: string) => void | Promise<void>;
type SuggestionItem = {
  label: string;
  detail: string;
  kind: "command" | "file";
  insertText: string;
  executeOnAccept?: boolean;
};
type SuggestionProvider = () => SuggestionItem[];
type FileSuggestionProvider = () => Promise<string[]>;

/** A single model row displayed in the model picker overlay. */
export type ModelOverlayItem = {
  id: string;
  contextWindow: number;
  supportsImages: boolean;
  inputPerMTok: number;
  outputPerMTok: number;
};

/** Callbacks and data wiring for the model picker overlay. */
export type ModelOverlayOptions = {
  /** Snapshot of the full model catalog to display. */
  list: () => ModelOverlayItem[];
  /** Model ids currently in the cycle set. */
  initialSelected: () => string[];
  /** Called on Enter to switch the current model immediately. */
  onPick: (id: string) => void;
  /** Called whenever the cycle set changes via space toggle. */
  onCycleChange: (ids: string[]) => void;
};

/** A single MCP server row displayed in the MCP picker overlay. */
export type McpOverlayItem = {
  name: string;
  enabled: boolean;
  connected: boolean;
  toolCount: number;
  type: "local" | "remote";
};

/** Callbacks and data wiring for the MCP picker overlay. */
export type McpOverlayOptions = {
  /** Snapshot of the configured MCP servers to display. */
  list: () => McpOverlayItem[] | Promise<McpOverlayItem[]>;
  /** Called when the user toggles a server's enabled state via space. */
  onToggle: (name: string, enabled: boolean) => void | Promise<void>;
};

/** A single session row displayed in the session picker overlay. */
export type SessionOverlayItem = {
  id: string;
  updatedAt: string;
  entryCount: number;
  currentModelId: string;
  title?: string;
  starred?: boolean;
  isActive?: boolean;
  cost?: number;
};

/** Callbacks and data wiring for the session picker overlay. */
export type SessionOverlayOptions = {
  /** Called on Enter to resume the highlighted session. */
  onPick: (id: string) => void;
};

/** A single row displayed in the conversation tree overlay. */
export type TreeOverlayItem = {
  id: string;
  parentId: string | null;
  depth: number;
  role: "user" | "assistant";
  preview: string;
  isActive: boolean;
  isLeaf: boolean;
  hasChildren: boolean;
  timestamp: string;
};

/** Callbacks and data wiring for the conversation tree overlay. */
export type TreeOverlayOptions = {
  /** Called on Enter to make the selected entry the active leaf. */
  onPick: (id: string) => void;
  /** Called when the user presses the open-tree shortcut. */
  onOpen: () => void;
};

type ModelOverlayEntry = { item: ModelOverlayItem; positions: number[] };
type McpOverlayEntry = { item: McpOverlayItem; positions: number[] };
type SegmentStyle =
  | "normal"
  | "bold"
  | "italic"
  | "code"
  | "heading"
  | "title"
  | "tableBorder"
  | "sh-raw"
  | "sh-keyword"
  | "sh-string"
  | "sh-number"
  | "sh-comment"
  | "sh-type"
  | "sh-function"
  | "sh-operator"
  | "sh-punctuation"
  | "sh-property"
  | "sh-diff-add"
  | "sh-diff-remove"
  | "sh-diff-context";

type ScreenPosition = {
  row: number;
  col: number;
};

type SelectionRange = {
  anchor: ScreenPosition;
  focus: ScreenPosition;
};

type StyledSegment = {
  text: string;
  style: SegmentStyle;
  /** CSS hex color string — only used when style === "sh-raw" (Shiki tokens). */
  color?: string;
  /** FontStyle bitmask — only used when style === "sh-raw". Bold=2, Italic=1. */
  fontStyle?: number;
};

type TableAlignment = "left" | "center" | "right";

type MarkdownTable = {
  header: string[];
  alignments: TableAlignment[];
  rows: string[][];
  rawLines: string[];
};

type ParsedMarkdownTable = {
  table: MarkdownTable;
  nextIndex: number;
};

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const NO_BOLD = "\x1b[22m";
const ITALIC = "\x1b[3m";
const INVERSE = "\x1b[7m";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const CLEAR_SCREEN = "\x1b[2J";
const ENTER_ALT_SCREEN = "\x1b[?1049h";
const LEAVE_ALT_SCREEN = "\x1b[?1049l";
const ENABLE_MOUSE = "\x1b[?1002h\x1b[?1006h";
const DISABLE_MOUSE = "\x1b[?1000l\x1b[?1002l\x1b[?1006l";
const ENABLE_FOCUS = "\x1b[?1004h";
const DISABLE_FOCUS = "\x1b[?1004l";
const ANSI_PATTERN = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
const ANSI_AT_START = /^\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/;
const SGR_MOUSE_PATTERN = /\x1b\[<(\d+);(\d+);(\d+)([mM])/g;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const ASCII_LOGO: string[] = [
  "██████╗  █████╗  ██████╗███████╗",
  "██╔══██╗██╔══██╗██╔════╝██╔════╝",
  "██████╔╝███████║██║     █████╗  ",
  "██╔═══╝ ██╔══██║██║     ██╔══╝  ",
  "██║     ██║  ██║╚██████╗███████╗",
  "╚═╝     ╚═╝  ╚═╝ ╚═════╝╚══════╝",
];

const MOUSE_WHEEL_LINES = 3;
const INPUT_HORIZONTAL_PADDING = 2;
const INPUT_VERTICAL_PADDING = 2;
const STATUS_ROWS = 1;
const MIN_MESSAGE_ROWS = 1;
const INSERT_NEWLINE_KEYS = new Set(["\x1b[13;2u", "\x1b[13;2~", "\x1b[27;2;13~"]);
const MAX_SUGGESTION_ROWS = 6;

// ── Model picker overlay ──
/** Header rows above the list: title, search, separator. */
const OVERLAY_HEADER_ROWS = 3;
/** Footer rows below the list: hint line. */
const OVERLAY_FOOTER_ROWS = 1;

let currentTheme: TuiTheme = BUILT_IN_THEMES.dark;

export function setTuiTheme(theme: TuiTheme) {
  currentTheme = theme;
  cachedBlackLineColumns = -1;
}

export function getCurrentTuiTheme(): TuiTheme {
  return currentTheme;
}

/** Cache entry for a single block's rendered output. */
type BlockRenderCacheEntry = {
  content: string;
  title: string | undefined;
  state: BlockState | undefined;
  collapsed: boolean | undefined;
  columns: number;
  lines: string[];
};

export class Tui {
  private blocks: RenderBlock[] = [];
  private input = "";
  private inputCursor = 0;
  private inputScrollRow = 0;
  private inputHistory: string[] = [];
  private historyIndex: number | undefined;
  private nextBlockId = 1;
  private running = false;
  private status = "idle";
  private model = "";
  private spinnerFrame = 0;
  private spinnerTimer: ReturnType<typeof setInterval> | undefined;
  private renderQueued = false;
  private open = false;
  private scrollOffset = 0;
  private lastRenderedLineCount = 0;
  private screenLines: string[] = [];
  private screenColumns = 0;
  private selection: SelectionRange | undefined;
  private selecting = false;
  private selectionMoved = false;
  private inputClickStart = false;
  private blockLineMap: number[] = [];
  private lastMessageStart = 0;
  private lastMessageRows = 0;
  private lastMessageScreenStartRow = 1;
  private emptyPrefixLines = 0;
  private contextInfo: ContextInfo | undefined;
  private cost = 0;
  private costDisplayConfig: CostDisplayConfig = DEFAULT_COST_DISPLAY_CONFIG;
  private cwd = "";
  private gitBranch = "";

  // ── Performance: block-level render cache (P0) ──
  private blockRenderCache = new Map<number, BlockRenderCacheEntry>();

  // ── Performance: line-level screen diff (P1) ──
  private previousFrameLines: string[] = [];
  private previousRawLines: string[] = [];
  private previousFrameColumns = 0;
  private previousFrameRows = 0;

  // ── Performance: lazy screenLines (only computed on mouse access) ──
  private rawFrameLines: string[] = [];
  private rawFrameRows = 0;
  private screenLinesDirty = true;

  private imageCount = 0;
  private steeringQueueCount = 0;
  private focused = true;
  private exitConfirmPresses = 0;
  private collapseOverrides = new Map<string, boolean>();
  private sessionTitle = "";
  private sessionStarred = false;

  // ── Suggestion popup state ──
  private slashItems: SuggestionItem[] = [];
  private filePaths: string[] = [];
  private filePathsLoaded = false;
  private filePathsLoading = false;
  private suggestionMode: "none" | "slash" | "file" = "none";
  private suggestionQuery = "";
  private suggestionIndex = 0;
  private suggestionActive = false;
  private suggestionTokenStart = 0;
  private suggestionTokenEnd = 0;

  // ── Model picker overlay state ──
  private modelOverlayActive = false;
  private modelOverlayQuery = "";
  private modelOverlayIndex = 0;
  private modelOverlayScroll = 0;
  private modelOverlayItems: ModelOverlayItem[] = [];
  private modelOverlaySelected = new Set<string>();

  // ── MCP picker overlay state ──
  private mcpOverlayActive = false;
  private mcpOverlayQuery = "";
  private mcpOverlayIndex = 0;
  private mcpOverlayScroll = 0;
  private mcpOverlayItems: McpOverlayItem[] = [];
  private mcpOverlayBusy = false;

  // ── Session picker overlay state ──
  private sessionOverlayActive = false;
  private sessionOverlayIndex = 0;
  private sessionOverlayScroll = 0;
  private sessionOverlayItems: SessionOverlayItem[] = [];

  // ── Conversation tree overlay state ──
  private treeOverlayActive = false;
  private treeOverlayIndex = 0;
  private treeOverlayScroll = 0;
  private treeOverlayItems: TreeOverlayItem[] = [];
  private treeOverlayExpanded = new Set<string>();

  constructor(private readonly options: { onSubmit?: SubmitHandler; onSteer?: (text: string) => void; onTab?: () => void; onShiftTab?: () => void; onCycleVariant?: () => void; onEscape?: () => void; onExit?: () => void | Promise<void>; onPasteImage?: () => void | Promise<void>; slashCommands?: SuggestionProvider; fileSuggestions?: FileSuggestionProvider; modelOverlay?: ModelOverlayOptions; mcpOverlay?: McpOverlayOptions; sessionOverlay?: SessionOverlayOptions; treeOverlay?: TreeOverlayOptions; model?: string; cwd?: string; gitBranch?: string } = {}) {
    this.model = options.model ?? "";
    this.cwd = options.cwd ?? "";
    this.gitBranch = options.gitBranch ?? "";
    this.slashItems = options.slashCommands ? options.slashCommands() : [];

    // When Shiki finishes loading, flush the render cache so code blocks get
    // re-rendered with full syntax highlighting.
    onHighlighterReady(() => {
      this.blockRenderCache.clear();
      this.requestRender();
    });
  }

  start() {
    if (this.open) {
      return;
    }

    this.open = true;
    this.setWindowTitle("Pace");
    process.stdin.setEncoding("utf8");
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();
    process.stdin.on("data", this.handleData);
    process.stdout.on("resize", this.handleResize);
    process.once("exit", this.handleExit);
    process.stdout.write(`${ENTER_ALT_SCREEN}${CLEAR_SCREEN}${HIDE_CURSOR}${ENABLE_MOUSE}${ENABLE_FOCUS}`);
    this.render();
  }

  stop() {
    if (!this.open) {
      return;
    }

    this.open = false;
    this.stopSpinner();
    process.stdin.off("data", this.handleData);
    process.stdout.off("resize", this.handleResize);
    process.off("exit", this.handleExit);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    process.stdout.write(`${RESET}${DISABLE_MOUSE}${DISABLE_FOCUS}${SHOW_CURSOR}${LEAVE_ALT_SCREEN}\n`);
  }

  addBlock(block: Omit<RenderBlock, "id">) {
    const id = this.nextBlockId++;
    this.blocks.push(this.createRenderBlock(id, block));
    this.requestRender();
    return id;
  }

  setBlocks(blocks: Array<Omit<RenderBlock, "id">>) {
    this.nextBlockId = 1;
    this.blocks = blocks.map((block) => this.createRenderBlock(this.nextBlockId++, block));
    this.scrollOffset = 0;
    this.lastRenderedLineCount = 0;
    this.selection = undefined;
    this.selecting = false;
    this.selectionMoved = false;
    this.blockRenderCache.clear();
    this.previousFrameLines = [];
    this.previousRawLines = [];
    this.requestRender();
  }

  updateBlock(id: number, patch: string | BlockPatch) {
    const block = this.blocks.find((candidate) => candidate.id === id);
    if (!block) {
      return;
    }

    if (typeof patch === "string") {
      block.content = patch;
    } else {
      if (patch.title !== undefined) block.title = patch.title;
      if (patch.content !== undefined) block.content = patch.content;
      if (patch.state !== undefined) block.state = patch.state;
      if (patch.collapsed !== undefined) block.collapsed = patch.collapsed;
    }
    this.requestRender();
  }

  clearBlocks() {
    this.blocks = [];
    this.scrollOffset = 0;
    this.lastRenderedLineCount = 0;
    this.selection = undefined;
    this.selecting = false;
    this.selectionMoved = false;
    this.blockRenderCache.clear();
    this.previousFrameLines = [];
    this.previousRawLines = [];
    this.requestRender();
  }

  appendToBlock(id: number, text: string) {
    const block = this.blocks.find((candidate) => candidate.id === id);
    if (!block) {
      return;
    }

    block.content += text;
    this.requestRender();
  }

  setStatus(status: string) {
    this.status = status;
    this.requestRender();
  }

  setRunning(running: boolean, status?: string) {
    this.running = running;
    if (status) {
      this.status = status;
    }

    if (running) {
      this.startSpinner();
    } else {
      this.stopSpinner();
      this.spinnerFrame = 0;
    }

    this.requestRender();
  }

  setModel(model: string) {
    this.model = model;
    this.requestRender();
  }

  setContextInfo(info: ContextInfo) {
    this.contextInfo = info;
    this.requestRender();
  }

  setCost(cost: number) {
    this.cost = cost;
    this.requestRender();
  }

  setCostDisplayConfig(config: CostDisplayConfig) {
    this.costDisplayConfig = config;
    this.requestRender();
  }

  setCwd(cwd: string) {
    this.cwd = cwd;
    this.requestRender();
  }

  setGitBranch(branch: string) {
    this.gitBranch = branch;
    this.requestRender();
  }

  setSessionTitle(title: string) {
    this.sessionTitle = title;
    this.requestRender();
  }

  setSessionStarred(starred: boolean) {
    this.sessionStarred = starred;
    this.requestRender();
  }

  setWindowTitle(title: string) {
    process.stdout.write(`\x1b]0;${title}\x07`);
  }

  invalidateRenderCache() {
    this.blockRenderCache.clear();
    this.previousFrameLines = [];
    this.previousRawLines = [];
    this.cachedLogoColumns = -1;
    this.cachedLogoRows = -1;
    this.requestRender();
  }

  setImageCount(count: number) {
    this.imageCount = count;
    this.requestRender();
  }

  setSteeringQueueCount(count: number) {
    this.steeringQueueCount = count;
    this.requestRender();
  }

  setInput(text: string) {
    this.input = text;
    this.inputCursor = Array.from(text).length;
    this.inputScrollRow = 0;
    this.deactivateHistory();
    this.requestRender();
  }

  prependInput(text: string) {
    if (!text) {
      return;
    }
    this.setInput(this.input ? `${text}\n${this.input}` : text);
  }

  get isFocused(): boolean {
    return this.focused;
  }

  toggleBlockCollapse(id: number) {
    const block = this.blocks.find((candidate) => candidate.id === id);
    if (!block) {
      return;
    }
    if (block.role !== "tool" && block.role !== "reasoning") {
      return;
    }
    block.collapsed = !block.collapsed;
    if (block.key) {
      this.collapseOverrides.set(block.key, block.collapsed);
    }
    this.requestRender();
  }

  private createRenderBlock(id: number, block: Omit<RenderBlock, "id">): RenderBlock {
    return {
      id,
      ...block,
      collapsed: this.resolveCollapsed(block),
    };
  }

  private resolveCollapsed(block: Omit<RenderBlock, "id">): boolean | undefined {
    if (block.key && this.collapseOverrides.has(block.key)) {
      return this.collapseOverrides.get(block.key);
    }

    return block.collapsed ?? (block.role === "tool" || block.role === "reasoning" ? true : undefined);
  }

  private handleBlockClick(position: ScreenPosition | undefined) {
    if (!position) {
      return;
    }

    const messageRow = position.row - this.lastMessageScreenStartRow;
    if (messageRow < 0 || messageRow >= this.lastMessageRows) {
      return;
    }

    // Subtract the empty prefix lines that were prepended to fill the
    // screen when there are fewer rendered block lines than message rows.
    const renderedIndex = this.lastMessageStart + messageRow - this.emptyPrefixLines;
    if (renderedIndex < 0 || renderedIndex >= this.blockLineMap.length) {
      return;
    }
    const blockId = this.blockLineMap[renderedIndex];
    if (blockId) {
      this.toggleBlockCollapse(blockId);
    }
  }

  private clearSelection() {
    if (!this.selection && !this.selecting && !this.selectionMoved) {
      return;
    }

    this.selection = undefined;
    this.selecting = false;
    this.selectionMoved = false;
    // The last rendered frame may contain highlighted selection spans while
    // the underlying raw line references are unchanged. Invalidate the raw
    // diff cache so the next render compares/repaints those rows without the
    // selection highlight instead of taking the no-selection fast path.
    this.previousRawLines = [];
    this.requestRender();
  }

  private deactivateHistory() {
    this.historyIndex = undefined;
  }

  private applyHistoryInput() {
    this.deactivateHistory();
  }

  private clearInput() {
    this.input = "";
    this.inputCursor = 0;
    this.inputScrollRow = 0;
    this.deactivateHistory();
    this.dismissSuggestions();
  }

  private recallHistory(index: number) {
    this.historyIndex = index;
    this.input = this.inputHistory[index] ?? "";
    this.inputCursor = Array.from(this.input).length;
    this.inputScrollRow = 0;
    this.dismissSuggestions();
    this.requestRender();
  }

  private navigateHistoryUp() {
    if (!this.inputHistory.length) {
      return false;
    }

    if (this.historyIndex === undefined) {
      if (this.input.length !== 0) {
        return false;
      }

      this.recallHistory(this.inputHistory.length - 1);
      return true;
    }

    this.recallHistory(Math.max(0, this.historyIndex - 1));
    return true;
  }

  private navigateHistoryDown() {
    if (this.historyIndex === undefined) {
      return false;
    }

    if (this.historyIndex >= this.inputHistory.length - 1) {
      this.clearInput();
      this.requestRender();
      return true;
    }

    this.recallHistory(this.historyIndex + 1);
    return true;
  }

  private startSpinner() {
    if (this.spinnerTimer) {
      return;
    }

    this.spinnerTimer = setInterval(() => {
      this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER_FRAMES.length;
      // Spinner ticks only need to update the status line and any running
      // block indicators. The block render cache already skips "running"
      // blocks, and the line-level diff (P1) ensures only the actually
      // changed rows are written to stdout, so the regular render path
      // handles this efficiently.
      this.requestRender();
    }, 50);
  }

  private stopSpinner() {
    if (!this.spinnerTimer) {
      return;
    }

    clearInterval(this.spinnerTimer);
    this.spinnerTimer = undefined;
  }

  private handleResize = () => {
    // Terminal dimensions changed — invalidate line diff cache so every
    // row is rewritten on the next frame.
    this.previousFrameLines = [];
    this.previousRawLines = [];
    this.requestRender();
  };

  private handleExit = () => {
    process.stdout.write(`${RESET}${DISABLE_MOUSE}${DISABLE_FOCUS}${SHOW_CURSOR}${LEAVE_ALT_SCREEN}`);
  };

  private handleData = (data: string) => {
    // Ignore OSC 11 (background color query) responses that may arrive mid-session
    if (data.startsWith("\x1b]11;")) {
      return;
    }

    if (this.modelOverlayActive) {
      this.handleModelOverlayKey(data);
      return;
    }

    if (this.mcpOverlayActive) {
      this.handleMcpOverlayKey(data);
      return;
    }

    if (this.sessionOverlayActive) {
      this.handleSessionOverlayKey(data);
      return;
    }

    if (this.treeOverlayActive) {
      this.handleTreeOverlayKey(data);
      return;
    }

    if (data === "\u0003") {
      if (this.suggestionActive) {
        this.dismissSuggestions();
        this.requestRender();
        return;
      }
      if (this.input) {
        this.exitConfirmPresses = 0;
        this.clearInput();
        this.requestRender();
      } else if (this.running) {
        this.exitConfirmPresses = 0;
        this.options.onEscape?.();
        this.status = "Cancelling prompt before exit";
        this.requestRender();
      } else if (this.exitConfirmPresses === 0) {
        this.exitConfirmPresses = 1;
        this.status = "Press Ctrl+C again to exit";
        this.requestRender();
      } else {
        void Promise.resolve(this.options.onExit?.())
          .catch(() => undefined)
          .finally(() => {
            this.stop();
            process.exit(0);
          });
      }
      return;
    }

    // Any key other than Ctrl+C cancels the exit confirmation
    this.exitConfirmPresses = 0;

    if (this.handleEscape(data)) {
      return;
    }

    this.clearSelection();

    // Detect paste: if the data contains more than a single \r or \n,
    // treat carriage returns and newlines as newline insertions rather
    // than submit triggers.  A real Enter keypress arrives as a lone "\r".
    const isPaste = data.length > 1 && data !== "\r\n";

    const chars = Array.from(data);
    for (let i = 0; i < chars.length; i++) {
      const char = chars[i];
      if (char === "\r") {
        if (isPaste) {
          this.insertInputNewline();
          // Skip a \n that immediately follows \r (i.e. \r\n pair)
          if (chars[i + 1] === "\n") {
            i += 1;
          }
        } else if (this.suggestionActive) {
          this.acceptSuggestion();
        } else {
          this.submitInput();
        }
        continue;
      }

      if (char === "\n") {
        this.insertInputNewline();
        continue;
      }

      if (char === "\u007f") {
        this.deleteBackward();
        continue;
      }

      if (char === "\b") {
        this.deleteWord();
        continue;
      }

      if (char === "\t") {
        if (this.suggestionActive) {
          this.acceptSuggestion();
        } else {
          this.options.onTab?.();
        }
        continue;
      }

      if (char === "\x16") {
        void Promise.resolve(this.options.onPasteImage?.()).catch(() => {
          // Swallow here; app-level handler is responsible for user-visible status.
        });
        continue;
      }

      // Ctrl+T — cycle the current model's variant.
      if (char === "\u0014") {
        this.options.onCycleVariant?.();
        continue;
      }

      // Ctrl+O — open the model picker overlay
      if (char === "\u000f") {
        if (this.running) {
          this.status = "agent is still running";
          this.requestRender();
        } else {
          this.openModelOverlay();
        }
        continue;
      }

      // Ctrl+E — open the MCP server picker overlay (Ctrl+M is Enter, so E)
      if (char === "\u0005") {
        if (this.running) {
          this.status = "agent is still running";
          this.requestRender();
        } else {
          void this.openMcpOverlay();
        }
        continue;
      }

      // Ctrl+B — open the conversation tree overlay
      if (char === "\x02") {
        this.options.treeOverlay?.onOpen();
        continue;
      }

      if (char === "\u0015") {
        if (this.input) {
          this.clearInputBeforeCursor();
        } else {
          this.scrollPageUp();
        }
        continue;
      }

      if (char === "\u0004") {
        if (!this.input) {
          this.scrollPageDown();
        }
        continue;
      }

      if (char >= " " && char !== "\u007f") {
        this.insertCharAtCursor(char);
      }
    }
  };

  private handleEscape(data: string) {
    // Bare ESC key (single \x1b byte) — dismiss suggestions first, then cancel running prompt
    if (data === "\x1b") {
      if (this.suggestionActive) {
        this.dismissSuggestions();
        this.requestRender();
        return true;
      }
      if (this.running) {
        this.options.onEscape?.();
      }
      return true;
    }

    if (INSERT_NEWLINE_KEYS.has(data)) {
      this.clearSelection();
      this.insertInputNewline();
      return true;
    }

    if (this.handleMouse(data)) {
      return true;
    }

    switch (data) {
      // Up/Down navigate suggestions when active, otherwise input history / cursor.
      case "\x1b[A":
        this.clearSelection();
        if (this.navigateSuggestionUp()) return true;
        if (this.navigateHistoryUp()) return true;
        this.moveCursorUp();
        return true;
      case "\x1b[B":
        this.clearSelection();
        if (this.navigateSuggestionDown()) return true;
        if (this.navigateHistoryDown()) return true;
        this.moveCursorDown();
        return true;
      case "\x1b[C":
        this.clearSelection();
        this.moveCursorRight();
        return true;
      case "\x1b[D":
        this.clearSelection();
        this.moveCursorLeft();
        return true;

      // Alt+Up / Alt+Down / Alt+K / Alt+J — scroll the message area
      case "\x1b[1;3A":
      case "\x1bk":
        this.scrollBy(1);
        return true;
      case "\x1b[1;3B":
      case "\x1bj":
        this.scrollBy(-1);
        return true;

      // Alt+Left / Alt+Right / Ctrl+Left / Ctrl+Right — word movement
      case "\x1b[1;3D":
      case "\x1b[1;5D":
      case "\x1bb":
        this.clearSelection();
        this.moveCursorWordLeft();
        return true;
      case "\x1b[1;3C":
      case "\x1b[1;5C":
      case "\x1bf":
        this.clearSelection();
        this.moveCursorWordRight();
        return true;

      // Page Up / Page Down
      case "\x1b[5~":
        this.scrollPageUp();
        return true;
      case "\x1b[6~":
        this.scrollPageDown();
        return true;

      // Home / End — move cursor to start/end of current visual line
      case "\x1b[H":
      case "\x1b[1~":
      case "\x1bOH":
        this.clearSelection();
        this.moveCursorHome();
        return true;
      case "\x1b[F":
      case "\x1b[4~":
      case "\x1bOF":
        this.clearSelection();
        this.moveCursorEnd();
        return true;

      // Ctrl+Home / Ctrl+End — scroll to top/bottom of messages
      case "\x1b[1;5H":
        this.scrollToTop();
        return true;
      case "\x1b[1;5F":
        this.scrollToBottom();
        return true;

      // Shift+Tab — cycle model in reverse
      case "\x1b[Z":
        this.options.onShiftTab?.();
        return true;

      // Delete key — delete character after cursor
      case "\x1b[3~":
        this.clearSelection();
        this.deleteForward();
        return true;

      // Shift+Delete — delete current line
      case "\x1b[3;2~":
        this.clearSelection();
        this.deleteCurrentLine();
        return true;

      // Ctrl+Delete — delete next word
      case "\x1b[3;5~":
        this.clearSelection();
        this.deleteWordForward();
        return true;

      // Alt+Backspace — delete word
      case "\x1b\u007f":
      case "\x1b\b":
        this.clearSelection();
        this.deleteWord();
        return true;

      // Focus reporting (?1004h)
      case "\x1b[I":
        this.focused = true;
        return true;
      case "\x1b[O":
        this.focused = false;
        return true;

      default:
        return data.startsWith("\x1b");
    }
  }

  private insertInputNewline() {
    this.insertCharAtCursor("\n");
  }

  private insertCharAtCursor(char: string) {
    this.applyHistoryInput();
    // Convert tabs to spaces for display (tabs should not appear in input)
    const charToInsert = char === "\t" ? "  " : char;
    const chars = Array.from(this.input);
    const insertChars = Array.from(charToInsert);
    chars.splice(this.inputCursor, 0, ...insertChars);
    this.input = chars.join("");
    this.inputCursor += insertChars.length;
    this.updateSuggestions();
    this.requestRender();
  }

  private deleteBackward() {
    if (this.inputCursor <= 0) {
      return;
    }

    this.applyHistoryInput();
    const chars = Array.from(this.input);
    chars.splice(this.inputCursor - 1, 1);
    this.input = chars.join("");
    this.inputCursor -= 1;
    this.updateSuggestions();
    this.requestRender();
  }

  private deleteForward() {
    const chars = Array.from(this.input);
    if (this.inputCursor >= chars.length) {
      return;
    }

    this.applyHistoryInput();
    chars.splice(this.inputCursor, 1);
    this.input = chars.join("");
    this.updateSuggestions();
    this.requestRender();
  }

  private clearInputBeforeCursor() {
    this.applyHistoryInput();
    const chars = Array.from(this.input);
    this.input = chars.slice(this.inputCursor).join("");
    this.inputCursor = 0;
    this.updateSuggestions();
    this.requestRender();
  }

  private deleteWord() {
    if (this.inputCursor <= 0) {
      return;
    }

    this.applyHistoryInput();
    const chars = Array.from(this.input);
    let index = this.inputCursor - 1;

    // If char before cursor is a special character (not alphanumeric, not space), remove just it
    const lastChar = chars[index];
    if (lastChar && !/^[\p{L}\p{Nd}]$/u.test(lastChar) && lastChar !== " ") {
      chars.splice(index, 1);
      this.input = chars.join("");
      this.inputCursor -= 1;
      this.updateSuggestions();
      this.requestRender();
      return;
    }

    // If char before cursor is a space, remove trailing spaces then the preceding word
    if (lastChar === " ") {
      while (index >= 0 && chars[index] === " ") {
        index -= 1;
      }
    }

    // Remove consecutive alphanumeric characters
    while (index >= 0 && /^[\p{L}\p{Nd}]$/u.test(chars[index])) {
      index -= 1;
    }

    const deleteFrom = index + 1;
    const deleteCount = this.inputCursor - deleteFrom;
    chars.splice(deleteFrom, deleteCount);
    this.input = chars.join("");
    this.inputCursor = deleteFrom;
    this.updateSuggestions();
    this.requestRender();
  }

  private deleteCurrentLine() {
    if (!this.input) {
      return;
    }

    this.applyHistoryInput();
    const chars = Array.from(this.input);

    // Find start of current line (after previous \n, or index 0)
    let start = this.inputCursor;
    while (start > 0 && chars[start - 1] !== "\n") {
      start -= 1;
    }

    // Find end of current line (before next \n, or end of string)
    let end = this.inputCursor;
    while (end < chars.length && chars[end] !== "\n") {
      end += 1;
    }

    // Delete the line content plus one adjacent newline
    if (end < chars.length) {
      // There's a \n after the line — include it
      end += 1;
    } else if (start > 0) {
      // No \n after, but there's a \n before — include the preceding \n
      start -= 1;
    }

    chars.splice(start, end - start);
    this.input = chars.join("");
    this.inputCursor = start;
    this.updateSuggestions();
    this.requestRender();
  }

  private deleteWordForward() {
    const chars = Array.from(this.input);
    if (this.inputCursor >= chars.length) {
      return;
    }

    this.applyHistoryInput();
    let index = this.inputCursor;

    // Skip spaces
    while (index < chars.length && (chars[index] === " " || chars[index] === "\t")) {
      index += 1;
    }

    // If on a word character, skip consecutive word characters
    if (index < chars.length && /^[\p{L}\p{Nd}]$/u.test(chars[index])) {
      while (index < chars.length && /^[\p{L}\p{Nd}]$/u.test(chars[index])) {
        index += 1;
      }
    } else {
      // Skip consecutive special characters until space or word character
      while (index < chars.length && chars[index] !== " " && chars[index] !== "\t" && !/^[\p{L}\p{Nd}]$/u.test(chars[index])) {
        index += 1;
      }
    }

    const deleteCount = index - this.inputCursor;
    chars.splice(this.inputCursor, deleteCount);
    this.input = chars.join("");
    this.updateSuggestions();
    this.requestRender();
  }

  private moveCursorLeft() {
    if (this.inputCursor > 0) {
      this.inputCursor -= 1;
      this.updateSuggestions();
      this.requestRender();
    }
  }

  private moveCursorRight() {
    const length = Array.from(this.input).length;
    if (this.inputCursor < length) {
      this.inputCursor += 1;
      this.updateSuggestions();
      this.requestRender();
    }
  }

  private moveCursorWordLeft() {
    if (this.inputCursor <= 0) {
      return;
    }

    const chars = Array.from(this.input);
    let index = this.inputCursor - 1;

    // Skip spaces
    while (index >= 0 && (chars[index] === " " || chars[index] === "\t")) {
      index -= 1;
    }

    // Skip word characters
    while (index >= 0 && /^[\p{L}\p{Nd}]$/u.test(chars[index])) {
      index -= 1;
    }

    // If we only skipped spaces and hit a non-word char, move past it
    if (index === this.inputCursor - 1) {
      index -= 1;
    }

    this.inputCursor = Math.max(0, index + 1);
    this.updateSuggestions();
    this.requestRender();
  }

  private moveCursorWordRight() {
    const chars = Array.from(this.input);
    if (this.inputCursor >= chars.length) {
      return;
    }

    let index = this.inputCursor;

    if (/^[\p{L}\p{Nd}]$/u.test(chars[index])) {
      // On a word character — move to the end of this word
      while (index < chars.length && /^[\p{L}\p{Nd}]$/u.test(chars[index])) {
        index += 1;
      }
    } else {
      // On a non-word character (space or special) — skip spaces/specials,
      // then move to the end of the next word
      while (index < chars.length && (chars[index] === " " || chars[index] === "\t")) {
        index += 1;
      }
      while (index < chars.length && chars[index] !== " " && chars[index] !== "\t" && !/^[\p{L}\p{Nd}]$/u.test(chars[index])) {
        index += 1;
      }
      while (index < chars.length && /^[\p{L}\p{Nd}]$/u.test(chars[index])) {
        index += 1;
      }
    }

    this.inputCursor = Math.min(chars.length, index);
    this.updateSuggestions();
    this.requestRender();
  }

  private moveCursorUp() {
    const columns = Math.max(process.stdout.columns ?? 80, 1);
    const horizontalPadding = Math.min(INPUT_HORIZONTAL_PADDING, Math.floor((columns - 1) / 2));
    const textWidth = Math.max(1, columns - horizontalPadding * 2);
    const raw = sanitizeContent(this.input);
    const layout = wrapInputTextWithCursor(raw, textWidth, this.inputCursor);

    if (layout.cursorLine <= 0) {
      // Already on the first visual line — move to start
      this.inputCursor = 0;
      this.updateSuggestions();
      this.requestRender();
      return;
    }

    // Move to same visual column on the previous line
    const targetLine = layout.cursorLine - 1;
    const targetCol = layout.cursorCol;
    this.inputCursor = layout.charOffsetAt(targetLine, targetCol);
    this.updateSuggestions();
    this.requestRender();
  }

  private moveCursorDown() {
    const columns = Math.max(process.stdout.columns ?? 80, 1);
    const horizontalPadding = Math.min(INPUT_HORIZONTAL_PADDING, Math.floor((columns - 1) / 2));
    const textWidth = Math.max(1, columns - horizontalPadding * 2);
    const raw = sanitizeContent(this.input);
    const layout = wrapInputTextWithCursor(raw, textWidth, this.inputCursor);

    if (layout.cursorLine >= layout.lines.length - 1) {
      // Already on the last visual line — move to end
      this.inputCursor = Array.from(this.input).length;
      this.updateSuggestions();
      this.requestRender();
      return;
    }

    // Move to same visual column on the next line
    const targetLine = layout.cursorLine + 1;
    const targetCol = layout.cursorCol;
    this.inputCursor = layout.charOffsetAt(targetLine, targetCol);
    this.updateSuggestions();
    this.requestRender();
  }

  private moveCursorHome() {
    const columns = Math.max(process.stdout.columns ?? 80, 1);
    const horizontalPadding = Math.min(INPUT_HORIZONTAL_PADDING, Math.floor((columns - 1) / 2));
    const textWidth = Math.max(1, columns - horizontalPadding * 2);
    const raw = sanitizeContent(this.input);
    const layout = wrapInputTextWithCursor(raw, textWidth, this.inputCursor);

    this.inputCursor = layout.charOffsetAt(layout.cursorLine, 0);
    this.updateSuggestions();
    this.requestRender();
  }

  private moveCursorEnd() {
    const columns = Math.max(process.stdout.columns ?? 80, 1);
    const horizontalPadding = Math.min(INPUT_HORIZONTAL_PADDING, Math.floor((columns - 1) / 2));
    const textWidth = Math.max(1, columns - horizontalPadding * 2);
    const raw = sanitizeContent(this.input);
    const layout = wrapInputTextWithCursor(raw, textWidth, this.inputCursor);

    const lineText = layout.lines[layout.cursorLine] ?? "";
    const lineWidth = displayWidth(lineText);
    this.inputCursor = layout.charOffsetAt(layout.cursorLine, lineWidth);
    this.updateSuggestions();
    this.requestRender();
  }

  // ── Suggestion popup logic ──

  private async ensureFilePaths() {
    if (this.filePathsLoaded || this.filePathsLoading || !this.options.fileSuggestions) {
      return;
    }
    this.filePathsLoading = true;
    try {
      const paths = await this.options.fileSuggestions();
      this.filePaths = paths.slice(0, 5000);
      this.filePathsLoaded = true;
    } catch {
      this.filePaths = [];
      this.filePathsLoaded = true;
    } finally {
      this.filePathsLoading = false;
      if (this.suggestionMode === "file" && this.suggestionActive) {
        this.updateSuggestions();
        this.requestRender();
      }
    }
  }

  private detectSlashMode(): { query: string; start: number; end: number } | null {
    if (!this.input.startsWith("/")) {
      return null;
    }
    const chars = Array.from(this.input);
    // Cursor must be within the first token (no spaces yet)
    for (let i = 0; i < this.inputCursor; i++) {
      if (chars[i] === " " || chars[i] === "\n") {
        return null;
      }
    }
    return { query: this.input.slice(1, this.inputCursor), start: 0, end: this.inputCursor };
  }

  private detectFileMode(): { query: string; start: number; end: number } | null {
    const chars = Array.from(this.input);
    let start = this.inputCursor - 1;
    while (start >= 0 && chars[start] !== " " && chars[start] !== "\n") {
      start -= 1;
    }
    start += 1;
    const end = this.inputCursor;
    const token = chars.slice(start, end).join("");
    if (token.startsWith("@")) {
      return { query: token.slice(1), start, end };
    }
    return null;
  }

  private updateSuggestions() {
    const slash = this.detectSlashMode();
    if (slash) {
      const query = slash.query.toLowerCase();
      const matches = this.slashItems.filter((item) => item.label.toLowerCase().includes(query));
      if (matches.length > 0 && !this.hasExactMatch(matches, this.input)) {
        this.suggestionMode = "slash";
        this.suggestionQuery = slash.query;
        this.suggestionTokenStart = slash.start;
        this.suggestionTokenEnd = slash.end;
        this.suggestionIndex = Math.min(this.suggestionIndex, matches.length - 1);
        this.suggestionActive = true;
        return;
      }
    }

    const file = this.detectFileMode();
    if (file) {
      if (!this.filePathsLoaded && this.options.fileSuggestions) {
        this.suggestionMode = "file";
        this.suggestionQuery = file.query;
        this.suggestionTokenStart = file.start;
        this.suggestionTokenEnd = file.end;
        this.suggestionActive = true;
        void this.ensureFilePaths();
        return;
      }
      const query = file.query.toLowerCase();
      const matches = this.filePaths.filter((path) => path.toLowerCase().includes(query));
      if (matches.length > 0 && !this.hasExactMatchForPaths(matches, "@" + file.query)) {
        this.suggestionMode = "file";
        this.suggestionQuery = file.query;
        this.suggestionTokenStart = file.start;
        this.suggestionTokenEnd = file.end;
        this.suggestionIndex = Math.min(this.suggestionIndex, matches.length - 1);
        this.suggestionActive = true;
        return;
      }
    }

    this.dismissSuggestions();
  }

  private hasExactMatch(matches: SuggestionItem[], fullToken: string): boolean {
    const tokenLower = fullToken.toLowerCase();
    return matches.some((item) => item.label.toLowerCase() === tokenLower);
  }

  private hasExactMatchForPaths(paths: string[], fullToken: string): boolean {
    const tokenLower = fullToken.toLowerCase();
    return paths.some((path) => path.toLowerCase() === tokenLower);
  }

  private dismissSuggestions() {
    this.suggestionMode = "none";
    this.suggestionQuery = "";
    this.suggestionIndex = 0;
    this.suggestionActive = false;
    this.suggestionTokenStart = 0;
    this.suggestionTokenEnd = 0;
  }

  private getSuggestionMatches(): SuggestionItem[] {
    if (!this.suggestionActive) return [];
    const query = this.suggestionQuery.toLowerCase();
    if (this.suggestionMode === "slash") {
      return this.slashItems.filter((item) => item.label.toLowerCase().includes(query));
    }
    if (this.suggestionMode === "file") {
      return this.filePaths
        .filter((path) => path.toLowerCase().includes(query))
        .map((path) => ({
          label: path,
          detail: "file",
          kind: "file" as const,
          insertText: `@${path}`,
        }));
    }
    return [];
  }

  private acceptSuggestion() {
    const matches = this.getSuggestionMatches();
    if (matches.length === 0) {
      this.dismissSuggestions();
      return;
    }
    const item = matches[this.suggestionIndex];
    if (this.suggestionMode === "slash") {
      if (item.executeOnAccept) {
        if (this.running) {
          this.status = "agent is still running";
          this.dismissSuggestions();
          this.requestRender();
          return;
        }
        this.input = item.insertText;
        this.inputCursor = this.input.length;
        this.dismissSuggestions();
        this.submitInput();
        return;
      }

      this.input = item.insertText;
      this.inputCursor = this.input.length;
    } else {
      const chars = Array.from(this.input);
      const before = chars.slice(0, this.suggestionTokenStart).join("");
      const after = chars.slice(this.suggestionTokenEnd).join("");
      const insertWithSpace = item.insertText + " ";
      this.input = before + insertWithSpace + after;
      this.inputCursor = this.suggestionTokenStart + insertWithSpace.length;
    }
    this.dismissSuggestions();
    this.requestRender();
  }

  private navigateSuggestionUp(): boolean {
    if (!this.suggestionActive) return false;
    const matches = this.getSuggestionMatches();
    if (matches.length === 0) return false;
    this.suggestionIndex = Math.max(0, this.suggestionIndex - 1);
    this.requestRender();
    return true;
  }

  private navigateSuggestionDown(): boolean {
    if (!this.suggestionActive) return false;
    const matches = this.getSuggestionMatches();
    if (matches.length === 0) return false;
    this.suggestionIndex = Math.min(matches.length - 1, this.suggestionIndex + 1);
    this.requestRender();
    return true;
  }

  // ── Model picker overlay ───────────────────────────────────────────────────

  openModelOverlay() {
    if (!this.options.modelOverlay) {
      return;
    }
    this.modelOverlayActive = true;
    this.modelOverlayQuery = "";
    this.modelOverlayItems = this.options.modelOverlay.list();
    this.modelOverlaySelected = new Set(this.options.modelOverlay.initialSelected());
    const currentIndex = this.modelOverlayItems.findIndex((item) => item.id === this.model);
    this.modelOverlayIndex = currentIndex >= 0 ? currentIndex : 0;
    this.modelOverlayScroll = 0;
    this.modelOverlayAdjustScroll();
    this.requestRender();
  }

  private closeModelOverlay() {
    this.modelOverlayActive = false;
    // Force a full repaint so the picker is fully cleared.
    this.previousFrameRows = -1;
    this.requestRender();
  }

  private handleModelOverlayKey(data: string) {
    switch (data) {
      case "\u0003": // Ctrl+C
      case "\x1b": // Esc
        this.closeModelOverlay();
        return;
      case "\r": // Enter — switch to highlighted model
        this.pickModelOverlay();
        return;
      case " ": // Space — toggle cycle membership
        this.toggleModelOverlay();
        return;
      case "\x1b[A": // Up
      case "\u0010": // Ctrl+P
      case "\x1bk": // Alt+K (vim-style up)
        this.moveModelOverlay(-1);
        return;
      case "\x1b[B": // Down
      case "\u000e": // Ctrl+N
      case "\x1bj": // Alt+J (vim-style down)
        this.moveModelOverlay(1);
        return;
      case "\x1b[5~": // Page Up
        this.moveModelOverlay(-this.modelOverlayListRows());
        return;
      case "\x1b[6~": // Page Down
        this.moveModelOverlay(this.modelOverlayListRows());
        return;
      case "\u007f": // Backspace
      case "\b":
        if (this.modelOverlayQuery.length > 0) {
          this.modelOverlayQuery = Array.from(this.modelOverlayQuery).slice(0, -1).join("");
          this.modelOverlayIndex = 0;
          this.modelOverlayScroll = 0;
          this.requestRender();
        }
        return;
    }

    if (data.startsWith("\x1b")) {
      return;
    }

    // Append any printable characters to the fuzzy query. Spaces are handled
    // above as a toggle (model ids never contain spaces).
    let added = "";
    for (const char of data) {
      if (char >= " " && char !== "\u007f" && char !== " ") {
        added += char;
      }
    }
    if (added.length > 0) {
      this.modelOverlayQuery += added;
      this.modelOverlayIndex = 0;
      this.modelOverlayScroll = 0;
      this.requestRender();
    }
  }

  private modelOverlayFiltered(): ModelOverlayEntry[] {
    const query = this.modelOverlayQuery.trim();
    if (query.length === 0) {
      return this.modelOverlayItems.map((item) => ({ item, positions: [] }));
    }
    const scored: Array<ModelOverlayEntry & { score: number; index: number }> = [];
    this.modelOverlayItems.forEach((item, index) => {
      const match = fuzzyMatch(query, item.id);
      if (match) {
        scored.push({ item, positions: match.positions, score: match.score, index });
      }
    });
    scored.sort((a, b) => b.score - a.score || a.index - b.index);
    return scored.map(({ item, positions }) => ({ item, positions }));
  }

  private modelOverlayListRows(): number {
    const rows = Math.max(process.stdout.rows ?? 24, 1);
    return Math.max(1, rows - OVERLAY_HEADER_ROWS - OVERLAY_FOOTER_ROWS);
  }

  private modelOverlayAdjustScroll() {
    const visible = this.modelOverlayListRows();
    if (this.modelOverlayIndex < this.modelOverlayScroll) {
      this.modelOverlayScroll = this.modelOverlayIndex;
    } else if (this.modelOverlayIndex >= this.modelOverlayScroll + visible) {
      this.modelOverlayScroll = this.modelOverlayIndex - visible + 1;
    }
    if (this.modelOverlayScroll < 0) {
      this.modelOverlayScroll = 0;
    }
  }

  private moveModelOverlay(delta: number) {
    const items = this.modelOverlayFiltered();
    if (items.length === 0) {
      return;
    }
    this.modelOverlayIndex = Math.max(0, Math.min(items.length - 1, this.modelOverlayIndex + delta));
    this.modelOverlayAdjustScroll();
    this.requestRender();
  }

  /** Cycle ids in catalog order, restricted to the current selection. */
  private modelOverlayOrderedSelection(): string[] {
    return this.modelOverlayItems
      .filter((item) => this.modelOverlaySelected.has(item.id))
      .map((item) => item.id);
  }

  private toggleModelOverlay() {
    const entry = this.modelOverlayFiltered()[this.modelOverlayIndex];
    if (!entry) {
      return;
    }
    if (this.modelOverlaySelected.has(entry.item.id)) {
      this.modelOverlaySelected.delete(entry.item.id);
    } else {
      this.modelOverlaySelected.add(entry.item.id);
    }
    this.options.modelOverlay?.onCycleChange(this.modelOverlayOrderedSelection());
    this.requestRender();
  }

  private pickModelOverlay() {
    const entry = this.modelOverlayFiltered()[this.modelOverlayIndex];
    if (entry) {
      // Picking a model also adds it to the cycle so Tab can return to it.
      if (!this.modelOverlaySelected.has(entry.item.id)) {
        this.modelOverlaySelected.add(entry.item.id);
        this.options.modelOverlay?.onCycleChange(this.modelOverlayOrderedSelection());
      }
      this.options.modelOverlay?.onPick(entry.item.id);
    }
    this.closeModelOverlay();
  }

  // ── MCP picker overlay ─────────────────────────────────────────────────────

  async openMcpOverlay() {
    if (!this.options.mcpOverlay) {
      return;
    }
    const items = await this.options.mcpOverlay.list();
    this.mcpOverlayActive = true;
    this.mcpOverlayQuery = "";
    this.mcpOverlayItems = items;
    this.mcpOverlayIndex = 0;
    this.mcpOverlayScroll = 0;
    this.mcpOverlayAdjustScroll();
    this.requestRender();
  }

  private closeMcpOverlay() {
    this.mcpOverlayActive = false;
    this.mcpOverlayBusy = false;
    // Force a full repaint so the picker is fully cleared.
    this.previousFrameRows = -1;
    this.requestRender();
  }

  private handleMcpOverlayKey(data: string) {
    switch (data) {
      case "\u0003": // Ctrl+C
      case "\x1b": // Esc
        this.closeMcpOverlay();
        return;
      case "\r": // Enter — close (state persists per-toggle)
        this.closeMcpOverlay();
        return;
      case " ": // Space — toggle enabled state
        if (!this.mcpOverlayBusy) {
          void this.toggleMcpOverlay();
        }
        return;
      case "\x1b[A": // Up
      case "\u0010": // Ctrl+P
      case "\x1bk": // Alt+K (vim-style up)
        this.moveMcpOverlay(-1);
        return;
      case "\x1b[B": // Down
      case "\u000e": // Ctrl+N
      case "\x1bj": // Alt+J (vim-style down)
        this.moveMcpOverlay(1);
        return;
      case "\x1b[5~": // Page Up
        this.moveMcpOverlay(-this.mcpOverlayListRows());
        return;
      case "\x1b[6~": // Page Down
        this.moveMcpOverlay(this.mcpOverlayListRows());
        return;
      case "\u007f": // Backspace
      case "\b":
        if (this.mcpOverlayQuery.length > 0) {
          this.mcpOverlayQuery = Array.from(this.mcpOverlayQuery).slice(0, -1).join("");
          this.mcpOverlayIndex = 0;
          this.mcpOverlayScroll = 0;
          this.requestRender();
        }
        return;
    }

    if (data.startsWith("\x1b")) {
      return;
    }

    // Append any printable characters to the fuzzy query. Spaces are handled
    // above as a toggle (server names never contain spaces).
    let added = "";
    for (const char of data) {
      if (char >= " " && char !== "\u007f" && char !== " ") {
        added += char;
      }
    }
    if (added.length > 0) {
      this.mcpOverlayQuery += added;
      this.mcpOverlayIndex = 0;
      this.mcpOverlayScroll = 0;
      this.requestRender();
    }
  }

  private mcpOverlayFiltered(): McpOverlayEntry[] {
    const query = this.mcpOverlayQuery.trim();
    if (query.length === 0) {
      return this.mcpOverlayItems.map((item) => ({ item, positions: [] }));
    }
    const scored: Array<McpOverlayEntry & { score: number; index: number }> = [];
    this.mcpOverlayItems.forEach((item, index) => {
      const match = fuzzyMatch(query, item.name);
      if (match) {
        scored.push({ item, positions: match.positions, score: match.score, index });
      }
    });
    scored.sort((a, b) => b.score - a.score || a.index - b.index);
    return scored.map(({ item, positions }) => ({ item, positions }));
  }

  private mcpOverlayListRows(): number {
    const rows = Math.max(process.stdout.rows ?? 24, 1);
    return Math.max(1, rows - OVERLAY_HEADER_ROWS - OVERLAY_FOOTER_ROWS);
  }

  private mcpOverlayAdjustScroll() {
    const visible = this.mcpOverlayListRows();
    if (this.mcpOverlayIndex < this.mcpOverlayScroll) {
      this.mcpOverlayScroll = this.mcpOverlayIndex;
    } else if (this.mcpOverlayIndex >= this.mcpOverlayScroll + visible) {
      this.mcpOverlayScroll = this.mcpOverlayIndex - visible + 1;
    }
    if (this.mcpOverlayScroll < 0) {
      this.mcpOverlayScroll = 0;
    }
  }

  private moveMcpOverlay(delta: number) {
    const items = this.mcpOverlayFiltered();
    if (items.length === 0) {
      return;
    }
    this.mcpOverlayIndex = Math.max(0, Math.min(items.length - 1, this.mcpOverlayIndex + delta));
    this.mcpOverlayAdjustScroll();
    this.requestRender();
  }

  private async toggleMcpOverlay() {
    const entry = this.mcpOverlayFiltered()[this.mcpOverlayIndex];
    if (!entry) {
      return;
    }
    this.mcpOverlayBusy = true;
    try {
      await this.options.mcpOverlay?.onToggle(entry.item.name, !entry.item.enabled);
    } finally {
      this.mcpOverlayBusy = false;
    }
    // Re-list so the checkbox reflects the (possibly rolled-back) state.
    this.mcpOverlayItems = (await this.options.mcpOverlay?.list()) ?? [];
    if (this.mcpOverlayIndex >= this.mcpOverlayItems.length) {
      this.mcpOverlayIndex = Math.max(0, this.mcpOverlayItems.length - 1);
    }
    this.requestRender();
  }

  // ── Session picker overlay ─────────────────────────────────────────────────

  openSessionOverlay(items: SessionOverlayItem[]) {
    if (!this.options.sessionOverlay) {
      return;
    }
    this.sessionOverlayActive = true;
    this.sessionOverlayItems = items;
    const activeIndex = this.sessionOverlayItems.findIndex((item) => item.isActive);
    this.sessionOverlayIndex = activeIndex >= 0 ? activeIndex : 0;
    this.sessionOverlayScroll = 0;
    this.sessionOverlayAdjustScroll();
    this.requestRender();
  }

  private closeSessionOverlay() {
    this.sessionOverlayActive = false;
    // Force a full repaint so the picker is fully cleared.
    this.previousFrameRows = -1;
    this.requestRender();
  }

  private handleSessionOverlayKey(data: string) {
    switch (data) {
      case "\u0003": // Ctrl+C
      case "\x1b": // Esc
      case "q":
      case "Q":
        this.closeSessionOverlay();
        return;
      case "\r": // Enter — resume highlighted session
        this.pickSessionOverlay();
        return;
      case "\x1b[A": // Up
      case "\u0010": // Ctrl+P
      case "k":
      case "K":
      case "\x1bk": // Alt+K (vim-style up)
        this.moveSessionOverlay(-1);
        return;
      case "\x1b[B": // Down
      case "\u000e": // Ctrl+N
      case "j":
      case "J":
      case "\x1bj": // Alt+J (vim-style down)
        this.moveSessionOverlay(1);
        return;
      case "\x1b[5~": // Page Up
        this.moveSessionOverlay(-this.sessionOverlayListRows());
        return;
      case "\x1b[6~": // Page Down
        this.moveSessionOverlay(this.sessionOverlayListRows());
        return;
    }

    if (data.startsWith("\x1b")) {
      return;
    }
  }

  private sessionOverlayListRows(): number {
    const rows = Math.max(process.stdout.rows ?? 24, 1);
    return Math.max(1, rows - OVERLAY_HEADER_ROWS - OVERLAY_FOOTER_ROWS);
  }

  private sessionOverlayAdjustScroll() {
    const visible = this.sessionOverlayListRows();
    if (this.sessionOverlayIndex < this.sessionOverlayScroll) {
      this.sessionOverlayScroll = this.sessionOverlayIndex;
    } else if (this.sessionOverlayIndex >= this.sessionOverlayScroll + visible) {
      this.sessionOverlayScroll = this.sessionOverlayIndex - visible + 1;
    }
    if (this.sessionOverlayScroll < 0) {
      this.sessionOverlayScroll = 0;
    }
  }

  private moveSessionOverlay(delta: number) {
    if (this.sessionOverlayItems.length === 0) {
      return;
    }
    this.sessionOverlayIndex = Math.max(0, Math.min(this.sessionOverlayItems.length - 1, this.sessionOverlayIndex + delta));
    this.sessionOverlayAdjustScroll();
    this.requestRender();
  }

  private pickSessionOverlay() {
    const item = this.sessionOverlayItems[this.sessionOverlayIndex];
    if (item) {
      this.options.sessionOverlay?.onPick(item.id);
    }
    this.closeSessionOverlay();
  }

  // ── Conversation tree overlay ──────────────────────────────────────────────

  openTreeOverlay(items: TreeOverlayItem[]) {
    this.treeOverlayActive = true;
    this.treeOverlayItems = items;
    this.treeOverlayExpanded = new Set(items.filter((item) => item.hasChildren).map((item) => item.id));
    const leafIndex = items.findIndex((item) => item.isLeaf);
    this.treeOverlayIndex = leafIndex >= 0 ? leafIndex : 0;
    this.treeOverlayScroll = 0;
    this.treeOverlayAdjustScroll();
    this.requestRender();
  }

  private closeTreeOverlay() {
    this.treeOverlayActive = false;
    this.previousFrameRows = -1;
    this.requestRender();
  }

  private handleTreeOverlayKey(data: string) {
    switch (data) {
      case "\u0003": // Ctrl+C
      case "\x02": // Ctrl+B
      case "\x1b": // Esc
      case "q":
      case "Q":
        this.closeTreeOverlay();
        return;
      case "\r": // Enter
        this.pickTreeOverlay();
        return;
      case " ": // Space
        this.toggleTreeOverlayFold();
        return;
      case "\x1b[A": // Up
      case "\u0010": // Ctrl+P
      case "k":
      case "K":
      case "\x1bk": // Alt+K
        this.moveTreeOverlay(-1);
        return;
      case "\x1b[B": // Down
      case "\u000e": // Ctrl+N
      case "j":
      case "J":
      case "\x1bj": // Alt+J
        this.moveTreeOverlay(1);
        return;
      case "\x1b[5~": // Page Up
        this.moveTreeOverlay(-this.treeOverlayListRows());
        return;
      case "\x1b[6~": // Page Down
        this.moveTreeOverlay(this.treeOverlayListRows());
        return;
    }

    if (data.startsWith("\x1b")) {
      return;
    }
  }

  private treeOverlayVisibleItems(): TreeOverlayItem[] {
    const visible: TreeOverlayItem[] = [];
    let i = 0;
    while (i < this.treeOverlayItems.length) {
      const item = this.treeOverlayItems[i];
      visible.push(item);
      if (!this.treeOverlayExpanded.has(item.id) && item.hasChildren) {
        const depth = item.depth;
        i += 1;
        while (i < this.treeOverlayItems.length && this.treeOverlayItems[i].depth > depth) {
          i += 1;
        }
      } else {
        i += 1;
      }
    }
    return visible;
  }

  private treeOverlayListRows(): number {
    const rows = Math.max(process.stdout.rows ?? 24, 1);
    return Math.max(1, rows - OVERLAY_HEADER_ROWS - OVERLAY_FOOTER_ROWS);
  }

  private treeOverlayAdjustScroll() {
    const visible = this.treeOverlayVisibleItems();
    const visibleCount = visible.length;
    const listRows = this.treeOverlayListRows();
    if (this.treeOverlayIndex >= visibleCount && visibleCount > 0) {
      this.treeOverlayIndex = Math.max(0, visibleCount - 1);
    }
    if (this.treeOverlayScroll > Math.max(0, visibleCount - listRows)) {
      this.treeOverlayScroll = Math.max(0, visibleCount - listRows);
    }
    if (this.treeOverlayIndex < this.treeOverlayScroll) {
      this.treeOverlayScroll = this.treeOverlayIndex;
    } else if (this.treeOverlayIndex >= this.treeOverlayScroll + listRows) {
      this.treeOverlayScroll = this.treeOverlayIndex - listRows + 1;
    }
    if (this.treeOverlayScroll < 0) {
      this.treeOverlayScroll = 0;
    }
  }

  private moveTreeOverlay(delta: number) {
    const visible = this.treeOverlayVisibleItems();
    if (visible.length === 0) {
      return;
    }
    this.treeOverlayIndex = Math.max(0, Math.min(visible.length - 1, this.treeOverlayIndex + delta));
    this.treeOverlayAdjustScroll();
    this.requestRender();
  }

  private toggleTreeOverlayFold() {
    const visible = this.treeOverlayVisibleItems();
    const item = visible[this.treeOverlayIndex];
    if (!item || !item.hasChildren) {
      return;
    }
    if (this.treeOverlayExpanded.has(item.id)) {
      this.treeOverlayExpanded.delete(item.id);
    } else {
      this.treeOverlayExpanded.add(item.id);
    }
    this.requestRender();
  }

  private pickTreeOverlay() {
    const visible = this.treeOverlayVisibleItems();
    const item = visible[this.treeOverlayIndex];
    if (item) {
      this.options.treeOverlay?.onPick(item.id);
    }
    this.closeTreeOverlay();
  }

  private renderTreeOverlay(columns: number, rows: number): string[] {
    const visible = this.treeOverlayVisibleItems();

    if (this.treeOverlayIndex >= visible.length) {
      this.treeOverlayIndex = Math.max(0, visible.length - 1);
    }
    const listRows = this.treeOverlayListRows();
    if (this.treeOverlayScroll > Math.max(0, visible.length - listRows)) {
      this.treeOverlayScroll = Math.max(0, visible.length - listRows);
    }
    this.treeOverlayAdjustScroll();

    const lines: string[] = [];
    const title = `  Conversation tree  ·  ${visible.length} visible / ${this.treeOverlayItems.length} total`;
    lines.push(overlayChromeLine(`${BOLD}${fg(currentTheme.overlay.brightFg)}${title}`, columns));
    lines.push(overlayLine(`${fg(currentTheme.overlay.fg)}  ↑/↓ move  space fold/unfold  enter jump  esc close`, columns));
    lines.push(`${bg(currentTheme.overlay.bg)}${fg(240)}${"─".repeat(columns)}${RESET}`);

    if (visible.length === 0) {
      lines.push(overlayLine(`${fg(currentTheme.overlay.dimFg)}  No entries`, columns));
      for (let i = 1; i < listRows; i += 1) {
        lines.push(overlayLine("", columns));
      }
    } else {
      const start = this.treeOverlayScroll;
      const end = Math.min(visible.length, start + listRows);
      for (let i = start; i < end; i += 1) {
        lines.push(this.renderTreeOverlayRow(visible[i], i === this.treeOverlayIndex, columns));
      }
      for (let i = end - start; i < listRows; i += 1) {
        lines.push(overlayLine("", columns));
      }
    }

    const hint = "  ↑/↓ or J/K move   space fold/unfold   enter jump to entry   esc close";
    lines.push(overlayChromeLine(`${fg(currentTheme.overlay.fg)}${hint}`, columns));

    while (lines.length < rows) {
      lines.push(overlayLine("", columns));
    }
    lines.length = rows;
    return lines;
  }

  private renderTreeOverlayRow(item: TreeOverlayItem, isCursor: boolean, columns: number): string {
    const rowBg = isCursor ? currentTheme.overlay.selBg : currentTheme.overlay.bg;
    const baseFg = isCursor ? 255 : item.isActive ? 252 : 250;
    const roleColor = item.role === "user" ? currentTheme.blocks.user.accent : currentTheme.blocks.assistant.accent;
    const indent = "  ".repeat(item.depth);
    const foldGlyph = item.hasChildren ? (this.treeOverlayExpanded.has(item.id) ? "⊟" : "⊞") : " ";
    const roleGlyph = item.role === "user" ? ">" : "◇";
    const activeMarker = item.isLeaf ? "← active" : item.isActive ? "●" : "";

    const prefix = `${indent}${foldGlyph} ${roleGlyph} `;
    const prefixWidth = displayWidth(prefix);
    const markerTextWidth = activeMarker ? displayWidth(activeMarker) : 0;
    const markerWidth = activeMarker ? 2 + markerTextWidth : 0;
    const leftPadding = 2;
    const rightPadding = 2;
    const reserved = leftPadding + prefixWidth + markerWidth + rightPadding;
    const maxPreviewWidth = Math.max(1, columns - reserved);
    const preview = truncateToWidth(item.preview, maxPreviewWidth);

    const content = `${fg(baseFg)}  ${prefix}${fg(roleColor)}${preview}${fg(baseFg)}${activeMarker ? `  ${activeMarker}` : ""}`;
    const contentWidth = leftPadding + prefixWidth + displayWidth(preview) + markerWidth;
    const trailing = Math.max(0, columns - contentWidth);

    return `${bg(rowBg)}${content}${" ".repeat(trailing)}${RESET}`;
  }

  private handleMouse(data: string) {
    let handled = false;

    for (const match of data.matchAll(SGR_MOUSE_PATTERN)) {
      handled = this.handleMouseEvent(Number(match[1]), Number(match[2]), Number(match[3]), match[4]) || handled;
    }

    let index = 0;
    while (index < data.length) {
      const start = data.indexOf("\x1b[M", index);
      if (start === -1) {
        break;
      }

      if (start + 6 > data.length) {
        break;
      }

      handled = this.handleMouseEvent(
        data.charCodeAt(start + 3) - 32,
        data.charCodeAt(start + 4) - 32,
        data.charCodeAt(start + 5) - 32,
        "M",
      ) || handled;
      index = start + 6;
    }

    return handled;
  }

  private handleMouseEvent(buttonCode: number, col: number, row: number, action: string) {
    if (action === "M" && (buttonCode & 64) !== 0) {
      const wheelButton = buttonCode & 3;
      if (wheelButton === 0) {
        this.scrollBy(MOUSE_WHEEL_LINES);
        return true;
      }

      if (wheelButton === 1) {
        this.scrollBy(-MOUSE_WHEEL_LINES);
        return true;
      }

      return false;
    }

    const position = this.mousePosition(col, row);
    const button = buttonCode & 3;
    const isRelease = action === "m" || button === 3;
    if (isRelease) {
      if (!this.selecting) {
        return false;
      }

      this.updateSelection(position);
      if (this.inputClickStart && this.isInputPosition(position.col, position.row) && !this.selectionMoved) {
        this.handleInputClick(position.col, position.row);
        this.selecting = false;
        this.selection = undefined;
        this.inputClickStart = false;
        return true;
      }
      this.inputClickStart = false;
      this.finishSelection();
      return true;
    }

    if (button !== 0) {
      return false;
    }

    const isMotion = (buttonCode & 32) !== 0;
    if (isMotion) {
      if (!this.selecting) {
        return false;
      }

      this.updateSelection(position);
      return true;
    }

    if (this.isInputPosition(position.col, position.row)) {
      this.inputClickStart = true;
      this.selection = { anchor: position, focus: position };
      this.selecting = true;
      this.selectionMoved = false;
      this.requestRender();
      return true;
    }

    this.startSelection(position);
    return true;
  }

  private handleInputClick(col: number, row: number): boolean {
    const { rows, columns, statusRows, input, inputStartRow, inputEndRow } = this.computeLayout();
    const maxInputRows = this.maxInputRows(rows, statusRows);

    if (row < inputStartRow || row > inputEndRow) {
      return false;
    }

    const hasPadding = maxInputRows >= INPUT_VERTICAL_PADDING + 1;
    let contentRow = row - inputStartRow;
    if (hasPadding) {
      contentRow -= 1; // skip top bar
    }
    const contentRows = input.lines.length - (hasPadding ? 2 : 0);
    contentRow = Math.max(0, Math.min(contentRows - 1, contentRow));

    const horizontalPadding = Math.min(INPUT_HORIZONTAL_PADDING, Math.floor((columns - 1) / 2));
    const textWidth = Math.max(1, columns - horizontalPadding * 2);
    const raw = sanitizeContent(this.input);
    const layout = wrapInputTextWithCursor(raw, textWidth, this.inputCursor);

    const textCol = col - horizontalPadding - 1;
    const visualLine = this.inputScrollRow + contentRow;
    const clampedLine = Math.max(0, Math.min(layout.lines.length - 1, visualLine));
    const clampedCol = Math.max(0, textCol);

    this.inputCursor = layout.charOffsetAt(clampedLine, clampedCol);
    this.clearSelection();
    this.requestRender();
    return true;
  }

  private isInputPosition(col: number, row: number): boolean {
    const { inputStartRow, inputEndRow } = this.computeLayout();
    return row >= inputStartRow && row <= inputEndRow;
  }

  /**
   * If the current selection is entirely within the input box, returns the
   * selected input text (without padding or ANSI). Otherwise returns undefined.
   */
  private getInputSelectionText(): string | undefined {
    if (!this.selection) {
      return undefined;
    }

    const { rows, columns, statusRows, input, inputStartRow, inputEndRow } = this.computeLayout();
    const maxInputRows = this.maxInputRows(rows, statusRows);

    const { start, end } = normalizeSelection(this.selection);
    if (start.row < inputStartRow || end.row > inputEndRow) {
      return undefined;
    }

    const hasPadding = maxInputRows >= INPUT_VERTICAL_PADDING + 1;
    const horizontalPadding = Math.min(INPUT_HORIZONTAL_PADDING, Math.floor((columns - 1) / 2));
    const textWidth = Math.max(1, columns - horizontalPadding * 2);
    const raw = sanitizeContent(this.input);
    const layout = wrapInputTextWithCursor(raw, textWidth, this.inputCursor);

    const lines: string[] = [];
    for (let screenRow = start.row; screenRow <= end.row; screenRow += 1) {
      const bounds = selectionBoundsForRow(this.selection, screenRow, columns);
      if (!bounds) {
        continue;
      }

      // Map screen row to visual line index within the input content
      let contentRow = screenRow - inputStartRow;
      if (hasPadding) {
        contentRow -= 1;
      }
      const contentRows = input.lines.length - (hasPadding ? 2 : 0);
      contentRow = Math.max(0, Math.min(contentRows - 1, contentRow));
      const visualLine = this.inputScrollRow + contentRow;
      const clampedLine = Math.max(0, Math.min(layout.lines.length - 1, visualLine));
      const lineText = layout.lines[clampedLine] ?? "";

      // Convert selection bounds from screen columns to text columns
      const lineStart = bounds.start - horizontalPadding;
      const lineEnd = bounds.end - horizontalPadding;
      lines.push(sliceByCells(lineText, Math.max(0, lineStart), Math.max(0, lineEnd)));
    }

    // Trim leading/trailing empty lines the same way selectedText() does
    while (lines[0]?.trim() === "") {
      lines.shift();
    }
    while (lines[lines.length - 1]?.trim() === "") {
      lines.pop();
    }

    return lines.join("\n");
  }

  /** Lazily compute screenLines (plain text per row) for mouse/selection use. */
  private ensureScreenLines() {
    if (!this.screenLinesDirty) {
      return;
    }
    this.screenLinesDirty = false;
    const columns = this.screenColumns || process.stdout.columns || 80;
    this.screenLines = this.rawFrameLines.slice(0, this.rawFrameRows).map(
      (line) => stripAnsi(clipAnsi(line, columns)),
    );
  }

  private mousePosition(col: number, row: number): ScreenPosition {
    const columns = this.screenColumns || process.stdout.columns || 80;
    this.ensureScreenLines();
    const rows = this.screenLines.length || process.stdout.rows || 24;
    return {
      row: Math.max(1, Math.min(rows, Math.trunc(row))),
      col: Math.max(1, Math.min(columns, Math.trunc(col))),
    };
  }

  private startSelection(position: ScreenPosition) {
    this.selection = { anchor: position, focus: position };
    this.selecting = true;
    this.selectionMoved = false;
    this.requestRender();
  }

  private updateSelection(position: ScreenPosition) {
    if (!this.selection) {
      return;
    }

    this.selectionMoved = this.selectionMoved || !samePosition(this.selection.anchor, position);
    this.selection.focus = position;
    this.requestRender();
  }

  private finishSelection() {
    this.selecting = false;
    if (!this.selectionMoved) {
      this.handleBlockClick(this.selection?.anchor);
      this.clearSelection();
      return;
    }

    const inputText = this.getInputSelectionText();
    if (inputText !== undefined) {
      const text = cleanCopiedText(inputText);
      if (text) {
        copyToClipboard(text);
        const lineCount = text.split("\n").length;
        this.status = lineCount === 1 ? `copied ${visibleLength(text)} chars` : `copied ${lineCount} lines`;
      }
      this.clearSelection();
      return;
    }

    const text = cleanCopiedText(this.selectedText());
    if (!text) {
      this.clearSelection();
      return;
    }

    copyToClipboard(text);
    const lineCount = text.split("\n").length;
    this.status = lineCount === 1 ? `copied ${visibleLength(text)} chars` : `copied ${lineCount} lines`;
    this.clearSelection();
  }

  private selectedText() {
    if (!this.selection) {
      return "";
    }

    const { start, end } = normalizeSelection(this.selection);
    const columns = this.screenColumns || process.stdout.columns || 80;
    const lines: string[] = [];
    for (let row = start.row; row <= end.row; row += 1) {
      const bounds = selectionBoundsForRow(this.selection, row, columns);
      if (!bounds) {
        continue;
      }

      this.ensureScreenLines();
      const line = this.screenLines[row - 1] ?? "";
      lines.push(sliceByCells(line, bounds.start, bounds.end).replace(/[ \t]+$/g, ""));
    }

    while (lines[0]?.trim() === "") {
      lines.shift();
    }

    while (lines[lines.length - 1]?.trim() === "") {
      lines.pop();
    }

    return lines.join("\n");
  }

  private scrollPageUp() {
    this.scrollBy(Math.max(1, Math.floor(this.messageRows() / 2)));
  }

  private scrollPageDown() {
    this.scrollBy(-Math.max(1, Math.floor(this.messageRows() / 2)));
  }

  private scrollBy(lines: number) {
    this.clearSelection();
    this.scrollOffset = Math.max(0, this.scrollOffset + Math.trunc(lines));
    this.requestRender();
  }

  private scrollToTop() {
    this.clearSelection();
    this.scrollOffset = Number.MAX_SAFE_INTEGER;
    this.requestRender();
  }

  private scrollToBottom() {
    this.clearSelection();
    this.scrollOffset = 0;
    this.requestRender();
  }

  private messageRows() {
    const columns = Math.max(process.stdout.columns ?? 80, 1);
    const rows = Math.max(process.stdout.rows ?? 24, 1);
    const statusRows = this.statusRows(rows);
    const input = this.renderInputLine(columns, this.maxInputRows(rows, statusRows));
    return Math.max(0, rows - statusRows - input.lines.length);
  }

  private statusRows(rows: number) {
    return rows > 1 ? STATUS_ROWS : 0;
  }

  private maxInputRows(rows: number, statusRows: number) {
    return Math.max(1, rows - statusRows - MIN_MESSAGE_ROWS);
  }

  private headerRows() {
    return this.sessionTitle ? 2 : 0;
  }

  /**
   * Computes the vertical layout of the screen: how many rows each region
   * occupies and where the input box starts/ends. Shared by the render loop
   * and the mouse hit-testing helpers so the two never drift apart.
   */
  private computeLayout() {
    const rows = Math.max(process.stdout.rows ?? 24, 1);
    const columns = Math.max(process.stdout.columns ?? 80, 1);
    const statusRows = this.statusRows(rows);
    const input = this.renderInputLine(columns, this.maxInputRows(rows, statusRows));
    const popupRows = this.suggestionActive
      ? this.renderSuggestionPopup(columns, this.getSuggestionMatches(), this.suggestionIndex).length
      : 0;
    const headerRows = this.headerRows();
    const messageRows = Math.max(0, rows - statusRows - input.lines.length - popupRows - headerRows);
    const inputStartRow = headerRows + messageRows + popupRows + 1;
    const inputEndRow = inputStartRow + input.lines.length - 1;
    return { rows, columns, statusRows, input, popupRows, headerRows, messageRows, inputStartRow, inputEndRow };
  }

  private submitInput() {
    const submitted = this.input.trimEnd();
    if (!submitted.trim()) {
      this.clearInput();
      this.requestRender();
      return;
    }

    if (this.running) {
      if (!this.options.onSteer) {
        this.status = "agent is still running";
        this.requestRender();
        return;
      }

      this.inputHistory.push(submitted);
      this.clearInput();
      this.scrollOffset = 0;
      this.clearSelection();
      this.requestRender();
      this.options.onSteer(submitted);
      return;
    }

    this.inputHistory.push(submitted);
    this.clearInput();
    this.scrollOffset = 0;
    this.clearSelection();
    this.requestRender();

    Promise.resolve(this.options.onSubmit?.(submitted)).catch((error: unknown) => {
      this.addBlock({
        role: "error",
        title: "Error",
        content: error instanceof Error ? error.stack ?? error.message : String(error),
      });
      this.setRunning(false, "idle");
    });
  }

  private requestRender() {
    if (!this.open || this.renderQueued) {
      return;
    }

    this.renderQueued = true;
    setImmediate(() => {
      this.renderQueued = false;
      this.render();
    });
  }

  private render() {
    if (!this.open) {
      return;
    }

    const columns = Math.max(process.stdout.columns ?? 80, 1);
    const rows = Math.max(process.stdout.rows ?? 24, 1);

    if (this.modelOverlayActive) {
      const overlayLines = this.renderModelOverlay(columns, rows);
      // Cursor sits at the end of the search query on the second row.
      const cursorCol = visibleLength("  Search: ") + Array.from(this.modelOverlayQuery).length + 1;
      this.flushFrame(overlayLines, rows, columns, 2, cursorCol);
      return;
    }

    if (this.mcpOverlayActive) {
      const overlayLines = this.renderMcpOverlay(columns, rows);
      // Cursor sits at the end of the search query on the second row.
      const cursorCol = visibleLength("  Search: ") + Array.from(this.mcpOverlayQuery).length + 1;
      this.flushFrame(overlayLines, rows, columns, 2, cursorCol);
      return;
    }

    if (this.sessionOverlayActive) {
      const overlayLines = this.renderSessionOverlay(columns, rows);
      this.flushFrame(overlayLines, rows, columns, Math.min(rows, this.sessionOverlayIndex - this.sessionOverlayScroll + OVERLAY_HEADER_ROWS + 1), 1);
      return;
    }

    if (this.treeOverlayActive) {
      const overlayLines = this.renderTreeOverlay(columns, rows);
      this.flushFrame(overlayLines, rows, columns, Math.min(rows, this.treeOverlayIndex - this.treeOverlayScroll + OVERLAY_HEADER_ROWS + 1), 1);
      return;
    }

    const statusRows = this.statusRows(rows);
    const input = this.renderInputLine(columns, this.maxInputRows(rows, statusRows));
    const suggestionPopup = this.suggestionActive
      ? this.renderSuggestionPopup(columns, this.getSuggestionMatches(), this.suggestionIndex)
      : [];
    const popupRows = suggestionPopup.length;
    const headerRows = this.headerRows();
    const messageRows = Math.max(0, rows - statusRows - input.lines.length - popupRows - headerRows);
    const renderedBlocks: string[] = [];
    const blockLineMap: number[] = [];
    const spinnerFrame = SPINNER_FRAMES[this.spinnerFrame];

    // Classify each block's visual type for margin logic
    type VisualType = "user" | "assistant" | "inline-tool" | "panel" | "error" | "meta";
    const visualType = (b: RenderBlock): VisualType => {
      if (b.role === "user") return "user";
      if (b.role === "assistant" || b.role === "reasoning") return "assistant";
      if (b.role === "meta") return "meta";
      if (b.role === "error") return "error";
      // tool
      return isInlineTool(b) ? "inline-tool" : "panel";
    };

    // Visual type of the next block that renders at least one line. Blocks
    // that render nothing (e.g. an assistant text block that only contains
    // whitespace) are skipped so they cannot suppress trailing margins.
    const nextVisibleType = (fromIndex: number): VisualType | undefined => {
      for (let i = fromIndex + 1; i < this.blocks.length; i++) {
        if (!blockRendersEmpty(this.blocks[i])) {
          return visualType(this.blocks[i]);
        }
      }
      return undefined;
    };

    let prevType: VisualType | undefined;
    for (let blockIdx = 0; blockIdx < this.blocks.length; blockIdx++) {
      const block = this.blocks[blockIdx];
      const curType = visualType(block);

      // ── P0: Block-level render cache ──
      // Blocks with state "running" contain a spinner that changes every
      // frame, so they must always be re-rendered. All other blocks are
      // cached by their content/title/state/collapsed/columns.
      let blockLines: string[];
      const isRunning = block.state === "running";
      const cached = this.blockRenderCache.get(block.id);
      if (
        !isRunning &&
        cached &&
        cached.content === block.content &&
        cached.title === block.title &&
        cached.state === block.state &&
        cached.collapsed === block.collapsed &&
        cached.columns === columns
      ) {
        blockLines = cached.lines;
      } else {
        blockLines = renderBlock(block, columns, spinnerFrame);
        this.blockRenderCache.set(block.id, {
          content: block.content,
          title: block.title,
          state: block.state,
          collapsed: block.collapsed,
          columns,
          lines: blockLines,
        });
      }

      // Skip empty blocks (e.g. assistant still streaming with no content yet)
      if (blockLines.length === 0) {
        continue;
      }

      // ── Margin logic ──
      // Assistant blocks: always get a top margin and a trailing margin.
      // User blocks: no trailing margin (they have internal padding).
      // Panel / error blocks: have internal padding, so blocks following
      //   them skip their leading margin.
      // Inline tools: get a margin line before the *first* in a consecutive
      //   group, but no separator between adjacent inline tools.
      if (prevType !== undefined) {
        if (curType === "assistant") {
          // Assistant blocks always get a top margin line.
          renderedBlocks.push(blackLine(columns));
          blockLineMap.push(0);
        } else if (curType === "user") {
          // Skip margin if previous block has its own internal padding,
          // or is an inline tool (user cards sit flush against them).
          if (prevType !== "panel" && prevType !== "error" && prevType !== "assistant" && prevType !== "inline-tool" && prevType !== "meta") {
            renderedBlocks.push(blackLine(columns));
            blockLineMap.push(0);
          }
        } else if (curType === "inline-tool") {
          // Only add margin before the first inline tool in a group
          if (prevType !== "inline-tool" && prevType !== "assistant") {
            renderedBlocks.push(blackLine(columns));
            blockLineMap.push(0);
          }
        } else {
          // panel, error — margin before, unless prev was assistant
          // or user (user blocks have internal padding).
          if (prevType !== "assistant" && prevType !== "user") {
            renderedBlocks.push(blackLine(columns));
            blockLineMap.push(0);
          }
        }
      }

      renderedBlocks.push(...blockLines);
      for (let i = 0; i < blockLines.length; i++) {
        blockLineMap.push(block.id);
      }

      // Trailing margin after assistant and meta blocks — skip only if the
      // next visible block is another assistant (which will add its own
      // leading margin). Empty blocks are transparent so whitespace-only text
      // after reasoning does not suppress the margin.
      if (curType === "assistant" || curType === "meta") {
        const nextType = nextVisibleType(blockIdx);
        if (nextType !== "assistant") {
          renderedBlocks.push(blackLine(columns));
          blockLineMap.push(0);
        }
      }

      // Trailing margin at the end of an inline-tool group — adds a
      // bottom margin after the last consecutive inline tool so there
      // is visual separation from the input box or the next block.
      if (curType === "inline-tool") {
        const nextType = nextVisibleType(blockIdx);
        if (nextType !== "inline-tool" && nextType !== "panel" && nextType !== "error" && nextType !== "assistant") {
          renderedBlocks.push(blackLine(columns));
          blockLineMap.push(0);
        }
      }

      prevType = curType;
    }

    // Purge stale cache entries for blocks that no longer exist
    if (this.blockRenderCache.size > this.blocks.length + 10) {
      const activeIds = new Set(this.blocks.map((b) => b.id));
      for (const id of this.blockRenderCache.keys()) {
        if (!activeIds.has(id)) {
          this.blockRenderCache.delete(id);
        }
      }
    }

    // Ensure there's a margin line at the very top of the scroll area
    if (renderedBlocks.length > 0) {
      renderedBlocks.unshift(blackLine(columns));
      blockLineMap.unshift(0);
    }

    const lineDelta = renderedBlocks.length - this.lastRenderedLineCount;
    if (this.scrollOffset > 0 && this.lastRenderedLineCount > 0 && lineDelta !== 0) {
      this.scrollOffset += lineDelta;
    }

    this.lastRenderedLineCount = renderedBlocks.length;

    const maxScroll = Math.max(0, renderedBlocks.length - messageRows);
    this.scrollOffset = Math.min(Math.max(0, this.scrollOffset), maxScroll);

    const start = Math.max(0, renderedBlocks.length - messageRows - this.scrollOffset);
    const visibleMessages = renderedBlocks.slice(start, start + messageRows);

    // When there are fewer rendered block lines than message rows, empty
    // lines are prepended to fill the screen. Track how many so click
    // handling can offset correctly.
    let emptyPrefixLines = 0;
    while (visibleMessages.length < messageRows) {
      visibleMessages.unshift(blackLine(columns));
      emptyPrefixLines += 1;
    }

    // Block rendering functions (renderBlockRow, blackLine, etc.) already
    // pad every line to exactly `columns` visible width, so we can use them
    // directly without the expensive padAnsi pass.
    const messageLines = this.blocks.length === 0
      ? this.renderLogo(columns, messageRows)
      : visibleMessages;
    const statusLine = this.renderStatusLine(columns, maxScroll);

    const inputSection = input.lines;
    const headerLines = headerRows > 0 ? [this.renderHeaderLine(columns), blackLine(columns)] : [];

    const lines = statusRows > 0
      ? [...headerLines, ...messageLines, ...suggestionPopup, ...inputSection, statusLine]
      : [...headerLines, ...messageLines, ...suggestionPopup, ...inputSection];
    this.screenColumns = columns;
    // Defer screenLines computation — it runs clipAnsi + stripAnsi on
    // every row and is only needed for mouse selection / copy.  Store
    // the raw lines and invalidate the cached screenLines so they are
    // rebuilt lazily on first access (see getScreenLines()).
    this.rawFrameLines = lines;
    this.rawFrameRows = rows;
    this.screenLinesDirty = true;
    this.blockLineMap = blockLineMap;
    this.lastMessageStart = start;
    this.lastMessageRows = messageRows;
    this.lastMessageScreenStartRow = headerRows + 1;
    this.emptyPrefixLines = emptyPrefixLines;

    const cursorRow = Math.min(rows, headerRows + messageRows + popupRows + input.cursorRow);
    this.flushFrame(lines, rows, columns, cursorRow, input.cursorCol);
  }

  /**
   * Diff `lines` against the previously emitted frame and write only the rows
   * that changed, then park the cursor. Shared by the normal render path and
   * the model picker overlay.
   *
   * Uses a two-level diff:
   *  1. Fast path: compare the raw (pre-clip) line reference. If the line is
   *     identical by reference to the previous frame AND there's no active
   *     selection, the output is unchanged — skip clipAnsi entirely.
   *  2. Slow path: compute the final clipped string and compare it to the
   *     previously emitted string.
   */
  private flushFrame(lines: string[], rows: number, columns: number, cursorRow: number, cursorCol: number) {
    const fullRepaint = this.previousFrameRows !== rows || this.previousFrameColumns !== columns;
    const hasSelection = !!(this.selection && this.selectionMoved);
    const output: string[] = [];
    let hidCursor = false;

    for (let row = 0; row < rows; row += 1) {
      const rawLine = lines[row] ?? "";

      if (
        !fullRepaint &&
        !hasSelection &&
        row < this.previousRawLines.length &&
        this.previousRawLines[row] === rawLine &&
        row < this.previousFrameLines.length
      ) {
        continue;
      }

      const rendered = clipAnsi(this.renderSelectedLine(rawLine, row + 1, columns), columns);
      if (!fullRepaint && row < this.previousFrameLines.length && this.previousFrameLines[row] === rendered) {
        this.previousRawLines[row] = rawLine;
        continue;
      }
      if (!hidCursor) {
        output.push(HIDE_CURSOR);
        hidCursor = true;
      }
      output.push(`\x1b[${row + 1};1H\x1b[2K${rendered}`);
      this.previousFrameLines[row] = rendered;
      this.previousRawLines[row] = rawLine;
    }

    // Trim caches if the terminal shrank
    if (this.previousFrameLines.length > rows) {
      this.previousFrameLines.length = rows;
      this.previousRawLines.length = rows;
    }

    this.previousFrameRows = rows;
    this.previousFrameColumns = columns;

    // Always position cursor and show it
    output.push(`\x1b[${cursorRow};${cursorCol}H${SHOW_CURSOR}`);

    process.stdout.write(output.join(""));
  }

  private renderSelectedLine(line: string, row: number, columns: number) {
    if (!this.selection || !this.selectionMoved) {
      return line;
    }

    const bounds = selectionBoundsForRow(this.selection, row, columns);
    if (!bounds) {
      return line;
    }

    return highlightAnsiRange(line, bounds.start, bounds.end);
  }

  private cachedLogo: string[] = [];
  private cachedLogoColumns = -1;
  private cachedLogoRows = -1;

  private renderLogo(columns: number, messageRows: number): string[] {
    if (columns === this.cachedLogoColumns && messageRows === this.cachedLogoRows) {
      return this.cachedLogo;
    }

    const logoWidth = Math.max(...ASCII_LOGO.map((line) => line.length));
    const logoHeight = ASCII_LOGO.length;

    if (messageRows < logoHeight || columns < logoWidth) {
      const bl = blackLine(columns);
      const result: string[] = [];
      for (let i = 0; i < messageRows; i++) result.push(bl);
      this.cachedLogo = result;
      this.cachedLogoColumns = columns;
      this.cachedLogoRows = messageRows;
      return result;
    }

    const topPad = Math.floor((messageRows - logoHeight) / 2);
    const lines: string[] = [];
    const bl = blackLine(columns);

    for (let i = 0; i < topPad; i++) {
      lines.push(bl);
    }

    for (const logoLine of ASCII_LOGO) {
      const leftPad = Math.floor((columns - logoWidth) / 2);
      const rightPad = Math.max(0, columns - leftPad - logoWidth);
      const padded = logoLine + " ".repeat(Math.max(0, logoWidth - logoLine.length));
      lines.push(
        `${bg(currentTheme.canvas.bg)}${" ".repeat(leftPad)}${fg(currentTheme.logoColor)}${padded}${RESET}${bg(currentTheme.canvas.bg)}${" ".repeat(rightPad)}${RESET}`,
      );
    }

    while (lines.length < messageRows) {
      lines.push(bl);
    }

    this.cachedLogo = lines;
    this.cachedLogoColumns = columns;
    this.cachedLogoRows = messageRows;
    return lines;
  }

  private renderStatusLine(columns: number, maxScroll: number) {
    const spinner = this.running ? `${SPINNER_FRAMES[this.spinnerFrame]} ` : "";
    const statusText = !this.running && (!this.status || this.status === "idle") ? "" : this.status || "idle";
    const imageText = this.imageCount > 0 ? `${statusText ? " | " : ""}📎 ${this.imageCount} image${this.imageCount === 1 ? "" : "s"}` : "";
    const steerText = this.steeringQueueCount > 0 ? `${statusText || imageText ? " | " : ""}${this.steeringQueueCount} steering queued` : "";
    const scrollText = this.scrollOffset > 0 ? `${statusText || imageText || steerText ? " | " : ""}scroll ${this.scrollOffset}/${maxScroll} | End latest` : "";
    const leftText = `${spinner}${statusText}${imageText}${steerText}${scrollText}`;
    const costText = this.cost > 0 ? `  ${formatCost(this.cost, this.costDisplayConfig)}  ` : "";
    const contextText = this.contextInfo ? `  ${formatContextInfo(this.contextInfo)}  ` : "";
    const modelText = this.model ? `  ${this.model}  ` : "";
    const home = homedir();
    let displayCwd = this.cwd && this.cwd.startsWith(home) ? "~" + this.cwd.slice(home.length) : this.cwd;
    if (displayCwd && this.gitBranch) displayCwd = `${displayCwd}:${this.gitBranch}`;
    const cwdText = displayCwd ? `  ${displayCwd}  ` : "";
    const horizontalPadding = Math.min(INPUT_HORIZONTAL_PADDING, Math.floor((columns - 1) / 2));
    const rightWidth = displayWidth(cwdText) + displayWidth(costText) + displayWidth(contextText) + displayWidth(modelText);
    const leftWidth = Math.max(1, columns - horizontalPadding * 2 - rightWidth);
    const leftVisible = takeRight(leftText, leftWidth);
    const leftPadded = `${" ".repeat(horizontalPadding)}${leftVisible}`;
    const leftPaddedWidth = displayWidth(leftPadded);
    const gapWidth = Math.max(0, columns - leftPaddedWidth - rightWidth);
    const fgColor = this.running ? currentTheme.status.runningFg : currentTheme.status.fg;
    const contextFgColor = this.contextInfo && this.contextInfo.usedTokens / this.contextInfo.contextWindow >= 0.8 ? currentTheme.status.contextWarnFg : currentTheme.status.contextFg;
    return (
      `${bg(currentTheme.status.bg)}${fg(fgColor)}${leftPadded}${" ".repeat(gapWidth)}` +
      `${bg(currentTheme.status.bg)}${fg(currentTheme.status.fg)}${cwdText}` +
      `${bg(currentTheme.status.bg)}${fg(currentTheme.status.costFg)}${costText}` +
      `${bg(currentTheme.status.bg)}${fg(contextFgColor)}${contextText}` +
      `${bg(currentTheme.status.bg)}${fg(currentTheme.status.modelFg)}${modelText}${RESET}`
    );
  }

  private renderHeaderLine(columns: number): string {
    const cwdDir = this.cwd ? basename(this.cwd) : "";
    const parts = [this.sessionTitle, cwdDir].filter(Boolean);
    const innerLabel = parts.length > 1 ? parts.join(" · ") : (parts[0] ?? "");
    const starPrefix = this.sessionStarred ? "★ " : "";
    const label = starPrefix + innerLabel;
    const text = truncateToWidth(label, Math.max(1, columns - 2));
    const visible = displayWidth(text);
    const totalPad = Math.max(0, columns - 2 - visible);
    const leftPad = Math.floor(totalPad / 2);
    const rightPad = totalPad - leftPad;
    const content = this.sessionStarred
      ? `${fg(currentTheme.starColor)}★ ${RESET}${bg(currentTheme.canvas.bg)}${fg(245)}${text.slice(2)}`
      : `${fg(245)}${text}`;
    return `${bg(currentTheme.canvas.bg)}${" ".repeat(leftPad)}${content}${" ".repeat(rightPad)}${RESET}`;
  }

  private renderSuggestionPopup(columns: number, matches: SuggestionItem[], selectedIndex: number): string[] {
    if (matches.length === 0) return [];
    const maxRows = Math.min(matches.length, MAX_SUGGESTION_ROWS);
    const lines: string[] = [];
    for (let i = 0; i < maxRows; i++) {
      const item = matches[i];
      const isSelected = i === selectedIndex;
      const prefix = isSelected ? `${INVERSE}` : "";
      const suffix = isSelected ? `${RESET}` : "";
      const labelColor = item.kind === "command" ? fg(currentTheme.blocks.user.accent) : fg(currentTheme.blocks.tool.fg);
      const label = item.label.padEnd(20, " ");
      const detail = item.detail;
      const text = `  ${label} ${detail}`;
      const clipped = clipAnsi(text, columns - 4);
      const pad = Math.max(0, columns - 4 - visibleLength(clipped));
      lines.push(
        `${bg(currentTheme.suggestion.bg)}  ${prefix}${labelColor}${clipped}${suffix}${" ".repeat(pad)}  ${RESET}`,
      );
    }
    if (matches.length > MAX_SUGGESTION_ROWS) {
      const remaining = matches.length - MAX_SUGGESTION_ROWS;
      const moreText = `  … and ${remaining} more  `;
      const pad = Math.max(0, columns - visibleLength(moreText));
      lines.push(`${bg(currentTheme.suggestion.bg)}${fg(currentTheme.overlay.dimFg)}${moreText}${" ".repeat(pad)}${RESET}`);
    }
    return lines;
  }

  private renderModelOverlay(columns: number, rows: number): string[] {
    const items = this.modelOverlayFiltered();

    // Clamp the highlight and scroll window to the current (possibly filtered) list.
    if (this.modelOverlayIndex >= items.length) {
      this.modelOverlayIndex = Math.max(0, items.length - 1);
    }
    const listRows = Math.max(1, rows - OVERLAY_HEADER_ROWS - OVERLAY_FOOTER_ROWS);
    if (this.modelOverlayScroll > Math.max(0, items.length - listRows)) {
      this.modelOverlayScroll = Math.max(0, items.length - listRows);
    }
    this.modelOverlayAdjustScroll();

    const lines: string[] = [];

    // Title bar.
    const count = this.modelOverlaySelected.size;
    const title = `  Select models  ·  ${count} in cycle  ·  ${items.length}/${this.modelOverlayItems.length} shown`;
    lines.push(overlayChromeLine(`${BOLD}${fg(currentTheme.overlay.brightFg)}${title}`, columns));

    // Search line.
    lines.push(overlayLine(`${fg(currentTheme.overlay.fg)}  Search: ${fg(currentTheme.overlay.brightFg)}${this.modelOverlayQuery}`, columns));

    // Separator.
    lines.push(`${bg(currentTheme.overlay.bg)}${fg(240)}${"─".repeat(columns)}${RESET}`);

    // List window.
    if (items.length === 0) {
      lines.push(overlayLine(`${fg(currentTheme.overlay.dimFg)}  No models match "${this.modelOverlayQuery}"`, columns));
      for (let i = 1; i < listRows; i++) {
        lines.push(overlayLine("", columns));
      }
    } else {
      const start = this.modelOverlayScroll;
      const end = Math.min(items.length, start + listRows);
      for (let i = start; i < end; i++) {
        lines.push(this.renderModelOverlayRow(items[i], i === this.modelOverlayIndex, columns));
      }
      for (let i = end - start; i < listRows; i++) {
        lines.push(overlayLine("", columns));
      }
    }

    // Footer hint.
    const hint = "  ↑/↓ move   space toggle cycle   enter switch now   esc close";
    lines.push(overlayChromeLine(`${fg(currentTheme.overlay.fg)}${hint}`, columns));

    // Guarantee exactly `rows` lines.
    while (lines.length < rows) {
      lines.push(overlayLine("", columns));
    }
    lines.length = rows;
    return lines;
  }

  private renderModelOverlayRow(entry: ModelOverlayEntry, isCursor: boolean, columns: number): string {
    const { item, positions } = entry;
    const rowBg = isCursor ? currentTheme.overlay.selBg : currentTheme.overlay.bg;
    const isCurrent = item.id === this.model;
    const isSelected = this.modelOverlaySelected.has(item.id);

    const marker = isCurrent ? "●" : " ";
    const checkbox = isSelected ? "[x]" : "[ ]";
    const baseFg = isCursor ? 255 : 250;

    const ctx = formatTokenCount(item.contextWindow).padStart(6);
    const img = item.supportsImages ? "img" : "   ";
    const price = item.inputPerMTok === 0 && item.outputPerMTok === 0
      ? "free"
      : `${formatPrice(item.inputPerMTok)}/${formatPrice(item.outputPerMTok)}`;
    const meta = `${ctx}  ${img}  ${price}`;

    // Visible width of the left portion: "  " + marker + " " + checkbox + " " + id.
    const leftWidth = 2 + 1 + 1 + checkbox.length + 1 + item.id.length;
    const metaWidth = meta.length;
    const gap = Math.max(1, columns - leftWidth - metaWidth - 1);
    const trailing = Math.max(0, columns - leftWidth - gap - metaWidth);

    let line = `${bg(rowBg)}`;
    line += `${fg(isCurrent ? 41 : baseFg)}  ${marker} `;
    line += `${fg(isSelected ? currentTheme.glyphs.done.color : 244)}${checkbox} `;
    line += highlightModelId(item.id, positions, baseFg, currentTheme.logoColor);
    line += `${fg(currentTheme.overlay.fg)}${" ".repeat(gap)}${meta}${" ".repeat(trailing)}`;
    line += RESET;
    return line;
  }

  private renderMcpOverlay(columns: number, rows: number): string[] {
    const items = this.mcpOverlayFiltered();

    // Clamp the highlight and scroll window to the current (possibly filtered) list.
    if (this.mcpOverlayIndex >= items.length) {
      this.mcpOverlayIndex = Math.max(0, items.length - 1);
    }
    const listRows = Math.max(1, rows - OVERLAY_HEADER_ROWS - OVERLAY_FOOTER_ROWS);
    if (this.mcpOverlayScroll > Math.max(0, items.length - listRows)) {
      this.mcpOverlayScroll = Math.max(0, items.length - listRows);
    }
    this.mcpOverlayAdjustScroll();

    const lines: string[] = [];

    // Title bar.
    const enabledCount = this.mcpOverlayItems.filter((item) => item.enabled).length;
    const title = `  Select MCP servers  ·  ${enabledCount} enabled  ·  ${items.length}/${this.mcpOverlayItems.length} shown`;
    lines.push(overlayChromeLine(`${BOLD}${fg(currentTheme.overlay.brightFg)}${title}`, columns));

    // Search line.
    lines.push(overlayLine(`${fg(currentTheme.overlay.fg)}  Search: ${fg(currentTheme.overlay.brightFg)}${this.mcpOverlayQuery}`, columns));

    // Separator.
    lines.push(`${bg(currentTheme.overlay.bg)}${fg(240)}${"─".repeat(columns)}${RESET}`);

    // List window.
    if (items.length === 0) {
      const message = this.mcpOverlayItems.length === 0
        ? "No MCP servers configured. Add servers to ~/.config/pace/mcp.json"
        : `No MCP servers match "${this.mcpOverlayQuery}"`;
      lines.push(overlayLine(`${fg(currentTheme.overlay.dimFg)}  ${message}`, columns));
      for (let i = 1; i < listRows; i++) {
        lines.push(overlayLine("", columns));
      }
    } else {
      const start = this.mcpOverlayScroll;
      const end = Math.min(items.length, start + listRows);
      for (let i = start; i < end; i++) {
        lines.push(this.renderMcpOverlayRow(items[i], i === this.mcpOverlayIndex, columns));
      }
      for (let i = end - start; i < listRows; i++) {
        lines.push(overlayLine("", columns));
      }
    }

    // Footer hint.
    const hint = "  ↑/↓ move   space toggle   esc close";
    lines.push(overlayChromeLine(`${fg(currentTheme.overlay.fg)}${hint}`, columns));

    // Guarantee exactly `rows` lines.
    while (lines.length < rows) {
      lines.push(overlayLine("", columns));
    }
    lines.length = rows;
    return lines;
  }

  private renderMcpOverlayRow(entry: McpOverlayEntry, isCursor: boolean, columns: number): string {
    const { item, positions } = entry;
    const rowBg = isCursor ? currentTheme.overlay.selBg : currentTheme.overlay.bg;
    const isSelected = item.enabled;

    const marker = item.connected ? "●" : " ";
    const checkbox = isSelected ? "[x]" : "[ ]";
    const baseFg = isCursor ? 255 : 250;

    const kind = item.type === "local" ? "local" : "remote";
    const tools = item.connected ? `${item.toolCount} tool${item.toolCount === 1 ? "" : "s"}` : "off";
    const meta = `${kind}  ${tools}`;

    // Visible width of the left portion: "  " + marker + " " + checkbox + " " + name.
    const leftWidth = 2 + 1 + 1 + checkbox.length + 1 + item.name.length;
    const metaWidth = meta.length;
    const gap = Math.max(1, columns - leftWidth - metaWidth - 1);
    const trailing = Math.max(0, columns - leftWidth - gap - metaWidth);

    let line = `${bg(rowBg)}`;
    line += `${fg(item.connected ? 41 : baseFg)}  ${marker} `;
    line += `${fg(isSelected ? currentTheme.glyphs.done.color : 244)}${checkbox} `;
    line += highlightModelId(item.name, positions, baseFg, currentTheme.logoColor);
    line += `${fg(currentTheme.overlay.fg)}${" ".repeat(gap)}${meta}${" ".repeat(trailing)}`;
    line += RESET;
    return line;
  }

  private renderSessionOverlay(columns: number, rows: number): string[] {
    const items = this.sessionOverlayItems;

    if (this.sessionOverlayIndex >= items.length) {
      this.sessionOverlayIndex = Math.max(0, items.length - 1);
    }
    const listRows = Math.max(1, rows - OVERLAY_HEADER_ROWS - OVERLAY_FOOTER_ROWS);
    if (this.sessionOverlayScroll > Math.max(0, items.length - listRows)) {
      this.sessionOverlayScroll = Math.max(0, items.length - listRows);
    }
    this.sessionOverlayAdjustScroll();

    const lines: string[] = [];

    const title = `  Select session  ·  ${items.length} saved`;
    lines.push(overlayChromeLine(`${BOLD}${fg(currentTheme.overlay.brightFg)}${title}`, columns));

    lines.push(overlayLine(`${fg(currentTheme.overlay.fg)}  Project sessions for ${fg(currentTheme.overlay.brightFg)}${this.cwd || "current directory"}`, columns));

    lines.push(`${bg(currentTheme.overlay.bg)}${fg(240)}${"─".repeat(columns)}${RESET}`);

    if (items.length === 0) {
      lines.push(overlayLine(`${fg(currentTheme.overlay.dimFg)}  No sessions found`, columns));
      for (let i = 1; i < listRows; i++) {
        lines.push(overlayLine("", columns));
      }
    } else {
      const start = this.sessionOverlayScroll;
      const end = Math.min(items.length, start + listRows);
      for (let i = start; i < end; i++) {
        lines.push(this.renderSessionOverlayRow(items[i], i === this.sessionOverlayIndex, columns));
      }
      for (let i = end - start; i < listRows; i++) {
        lines.push(overlayLine("", columns));
      }
    }

    const hint = "  ↑/↓ or J/K move   enter resume   esc close";
    lines.push(overlayChromeLine(`${fg(currentTheme.overlay.fg)}${hint}`, columns));

    while (lines.length < rows) {
      lines.push(overlayLine("", columns));
    }
    lines.length = rows;
    return lines;
  }

  private renderSessionOverlayRow(item: SessionOverlayItem, isCursor: boolean, columns: number): string {
    const rowBg = isCursor ? currentTheme.overlay.selBg : currentTheme.overlay.bg;
    const baseFg = isCursor ? 255 : 250;
    return renderSessionOverlayColumns({
      columns,
      bgColor: rowBg,
      date: formatSessionOverlayTimestamp(item.updatedAt),
      id: item.id.slice(0, 8),
      name: sanitizeSingleLine(item.title ?? "").trim(),
      entries: String(item.entryCount),
      cost: item.cost !== undefined ? formatSessionCost(item.cost, this.costDisplayConfig) : "",
      fgColor: baseFg,
      activeColor: item.isActive ? 41 : baseFg,
      starMarker: item.starred ? "★" : " ",
      activeMarker: item.isActive ? "●" : " ",
    });
  }

  private renderInputLine(columns: number, maxRows: number) {
    const prompt = "";
    const horizontalPadding = Math.min(INPUT_HORIZONTAL_PADDING, Math.floor((columns - 1) / 2));
    const textWidth = Math.max(1, columns - horizontalPadding * 2);
    const raw = sanitizeContent(`${prompt}${this.input}`);

    // Clamp cursor to valid range.
    // Count characters without allocating an array: for...of iterates
    // code points which matches Array.from(string).length.
    let inputLength = 0;
    for (const _ of this.input) inputLength++;
    if (this.inputCursor > inputLength) {
      this.inputCursor = inputLength;
    }
    if (this.inputCursor < 0) {
      this.inputCursor = 0;
    }

    const layout = wrapInputTextWithCursor(raw, textWidth, this.inputCursor);
    const wrapped = layout.lines;
    const hasPadding = maxRows >= INPUT_VERTICAL_PADDING + 1;
    const contentRows = Math.max(1, maxRows - (hasPadding ? INPUT_VERTICAL_PADDING : 0));

    // Ensure the cursor line is visible by adjusting inputScrollRow
    const cursorLine = layout.cursorLine;
    if (cursorLine < this.inputScrollRow) {
      this.inputScrollRow = cursorLine;
    }
    if (cursorLine >= this.inputScrollRow + contentRows) {
      this.inputScrollRow = cursorLine - contentRows + 1;
    }
    // Clamp scroll to valid range
    const maxInputScroll = Math.max(0, wrapped.length - contentRows);
    this.inputScrollRow = Math.min(Math.max(0, this.inputScrollRow), maxInputScroll);

    const visibleRows = wrapped.slice(this.inputScrollRow, this.inputScrollRow + contentRows);
    const cursorRowInView = cursorLine - this.inputScrollRow;
    const cursorCol = Math.max(1, Math.min(columns, horizontalPadding + layout.cursorCol + 1));
    const isBashCommand = this.input.startsWith("!");
    const inputBg = isBashCommand ? currentTheme.input.bashBg : currentTheme.input.bg;
    const inputFg = isBashCommand ? currentTheme.input.bashFg : currentTheme.input.fg;
    const renderedContent = visibleRows.map((line) => {
      const prefix = " ".repeat(horizontalPadding);
      const highlighted = highlightInputLine(line, inputFg);
      const visibleWidth = horizontalPadding + displayWidth(line);
      const pad = Math.max(0, columns - visibleWidth);
      return `${bg(inputBg)}${fg(inputFg)}${prefix}${highlighted}${RESET}${bg(inputBg)}${" ".repeat(pad)}${RESET}`;
    });

    return {
      lines: hasPadding
        ? [renderBar("", columns, inputBg, inputFg, true), ...renderedContent, renderBar("", columns, inputBg, inputFg, true)]
        : renderedContent,
      cursorRow: (hasPadding ? 1 : 0) + cursorRowInView + 1,
      cursorCol,
    };
  }
}

/**
 * Highlights slash commands (`/word`) and file mentions (`@word`) in the
 * input line with distinct colors. Returns an ANSI string where tokens are
 * wrapped in the appropriate fg() sequences. The caller is responsible for
 * adding background and padding.
 */
function highlightInputLine(line: string, inputFg: number): string {
  const segments: { text: string; color: number }[] = [];
  let index = 0;

  while (index < line.length) {
    let found = false;
    for (let i = index; i < line.length; i++) {
      const ch = line[i];
      if (ch === "/" || ch === "@") {
        const prev = i > 0 ? line[i - 1] : undefined;
        const isWordStart = ch === "/"
          ? (prev === undefined || /\s/.test(prev))
          : (prev === undefined || !/[\p{L}\p{Nd}]/u.test(prev));
        if (isWordStart) {
          if (i > index) {
            segments.push({ text: line.slice(index, i), color: inputFg });
          }
          let j = i + 1;
          while (j < line.length && line[j] !== " ") {
            j++;
          }
          const word = line.slice(i, j);
          const color = ch === "/" ? currentTheme.blocks.user.accent : currentTheme.glyphs.done.color;
          segments.push({ text: word, color });
          index = j;
          found = true;
          break;
        }
      }
    }
    if (!found) {
      segments.push({ text: line.slice(index), color: inputFg });
      break;
    }
  }

  let result = "";
  for (const seg of segments) {
    result += `${fg(seg.color)}${seg.text}`;
  }
  return result;
}

function copyToClipboard(text: string) {
  process.stdout.write(`\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`);
}

function cleanCopiedText(text: string) {
  return text
    .split("\n")
    .map((line) => line.trimStart().replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function samePosition(a: ScreenPosition, b: ScreenPosition) {
  return a.row === b.row && a.col === b.col;
}

function comparePositions(a: ScreenPosition, b: ScreenPosition) {
  return a.row === b.row ? a.col - b.col : a.row - b.row;
}

function normalizeSelection(selection: SelectionRange) {
  const { anchor, focus } = selection;
  return comparePositions(anchor, focus) <= 0 ? { start: anchor, end: focus } : { start: focus, end: anchor };
}

function selectionBoundsForRow(selection: SelectionRange, row: number, columns: number) {
  const maxColumn = Math.max(1, columns);
  const { start, end } = normalizeSelection(selection);
  if (row < start.row || row > end.row) {
    return undefined;
  }

  if (start.row === end.row) {
    const left = Math.max(0, Math.min(maxColumn, Math.min(start.col, end.col) - 1));
    const right = Math.max(left, Math.min(maxColumn, Math.max(start.col, end.col)));
    return right > left ? { start: left, end: right } : undefined;
  }

  if (row === start.row) {
    return { start: Math.max(0, Math.min(maxColumn, start.col - 1)), end: maxColumn };
  }

  if (row === end.row) {
    return { start: 0, end: Math.max(0, Math.min(maxColumn, end.col)) };
  }

  return { start: 0, end: maxColumn };
}

function sliceByCells(text: string, start: number, end: number) {
  let result = "";
  let cell = 0;

  for (const char of text) {
    const width = charWidth(char);
    const charStart = cell;
    const charEnd = cell + width;
    if (charEnd > start && charStart < end) {
      result += char;
    }

    cell = charEnd;
    if (cell >= end) {
      break;
    }
  }

  return result;
}

function highlightAnsiRange(line: string, start: number, end: number) {
  if (end <= start) {
    return line;
  }

  let result = "";
  let activeStyle = "";
  let selected = false;
  let cell = 0;
  let index = 0;
  const len = line.length;

  while (index < len) {
    const code = line.charCodeAt(index);

    // Fast path: check for ESC to detect ANSI sequences
    if (code === 0x1b) {
      const ansi = ANSI_AT_START.exec(line.substring(index));
      if (ansi) {
        const sequence = ansi[0];
        result += sequence;
        activeStyle = updateActiveStyle(activeStyle, sequence);
        if (selected) {
          result += INVERSE;
        }

        index += sequence.length;
        continue;
      }
    }

    // Extract the next character (handle surrogate pairs)
    let char: string;
    if (code >= 0xd800 && code <= 0xdbff && index + 1 < len) {
      char = line.substring(index, index + 2);
    } else {
      char = line[index];
    }

    const width = charWidth(char);
    const charStart = cell;
    const charEnd = cell + width;
    if (!selected && charEnd > start && charStart < end) {
      result += INVERSE;
      selected = true;
    }

    if (selected && charStart >= end) {
      result += `${RESET}${activeStyle}`;
      selected = false;
    }

    result += char;
    cell = charEnd;
    index += char.length;
  }

  if (selected) {
    result += `${RESET}${activeStyle}`;
  }

  return result;
}

function updateActiveStyle(activeStyle: string, sequence: string) {
  const sgr = /^\x1b\[([0-9;]*)m$/.exec(sequence);
  if (!sgr) {
    return activeStyle;
  }

  const params = sgr[1] ? sgr[1].split(";") : ["0"];
  if (params.includes("0")) {
    return "";
  }

  return activeStyle + sequence;
}

/**
 * True when a block renders zero lines and is skipped by the render loop.
 * Currently only assistant blocks without a title whose content is empty or
 * whitespace-only render nothing (see renderAssistantBlock).
 */
function blockRendersEmpty(block: RenderBlock): boolean {
  if (block.role !== "assistant" || block.title) {
    return false;
  }
  const content = sanitizeContent(block.content).trimStart().replace(/\n+$/, "");
  return !content;
}

/**
 * Determines whether a tool block should render as a single inline line
 * (on the black canvas) or as a panel with gray background.
 *
 * Inline: no visible content body (collapsed with no content, or done with
 * showContent=false, etc.)
 * Panel: has content to display.
 */
function isInlineTool(block: RenderBlock): boolean {
  if (block.role !== "tool") return false;
  const content = sanitizeContent(block.content).replace(/^\n+/, "").replace(/\n+$/, "");
  return !content;
}

function renderBlock(block: RenderBlock, columns: number, spinnerFrame: string) {
  // Sanitize content once and pass it through to avoid repeated work (P3).
  const sanitized = sanitizeContent(block.content);

  // ── User blocks: rendered as a boxed card (existing style) ──
  if (block.role === "user") {
    return renderUserBlock(block, columns, sanitized);
  }

  // ── Assistant blocks: inline text on black canvas ──
  if (block.role === "assistant") {
    return renderAssistantBlock(block, columns, sanitized);
  }

  // ── Reasoning blocks: muted, collapsible reasoning on the canvas ──
  if (block.role === "reasoning") {
    return renderReasoningBlock(block, columns, sanitized);
  }

  // ── Tool blocks ──
  if (block.role === "tool") {
    const trimmed = sanitized.replace(/^\n+/, "").replace(/\n+$/, "");
    if (!trimmed) {
      return renderInlineToolBlock(block, columns, spinnerFrame);
    }
    return renderPanelToolBlock(block, columns, spinnerFrame, sanitized);
  }

  // ── Meta blocks: muted one-line turn usage summary ──
  if (block.role === "meta") {
    return renderMetaBlock(block, columns, sanitized);
  }

  // ── Error blocks: rendered as a panel with error theme ──
  return renderErrorBlock(block, columns, sanitized);
}

// ---------------------------------------------------------------------------
// Block-level region splitting
// ---------------------------------------------------------------------------

type ContentRegion =
  | { kind: "markdown"; lines: string[] }
  | { kind: "code"; language: string | null; lines: string[] };

type FenceInfo = {
  marker: "`" | "~";
  length: number;
  language: string | null;
};

/**
 * Split raw content text into a sequence of alternating markdown and fenced
 * code regions. Opening fences are either backticks or tildes, optionally
 * followed by a language tag and metadata; closing fences must use the same
 * marker and be at least as long as the opener.
 */
function splitContentRegions(content: string): ContentRegion[] {
  const regions: ContentRegion[] = [];
  let currentMarkdown: string[] = [];
  let currentFence: FenceInfo | undefined;
  let codeLines: string[] = [];

  for (const line of content.split("\n")) {
    if (!currentFence) {
      const openFence = parseOpeningFence(line);
      if (openFence) {
        // Flush any pending markdown lines.
        if (currentMarkdown.length > 0) {
          regions.push({ kind: "markdown", lines: currentMarkdown });
          currentMarkdown = [];
        }
        currentFence = openFence;
        codeLines = [];
      } else {
        currentMarkdown.push(line);
      }
      continue;
    }

    if (isClosingFence(line, currentFence)) {
      regions.push({ kind: "code", language: currentFence.language, lines: codeLines });
      currentFence = undefined;
      codeLines = [];
    } else {
      codeLines.push(line);
    }
  }

  // Flush any remaining open code block (unterminated fence, e.g. streaming).
  if (currentFence) {
    regions.push({ kind: "code", language: currentFence.language, lines: codeLines });
  } else if (currentMarkdown.length > 0) {
    regions.push({ kind: "markdown", lines: currentMarkdown });
  }

  return regions;
}

function parseOpeningFence(line: string): FenceInfo | undefined {
  const match = /^(\s*)(`{3,}|~{3,})\s*([^\s`]*)?.*$/.exec(line);
  if (!match) {
    return undefined;
  }

  const fence = match[2];
  const marker = fence[0] as "`" | "~";
  const rawLanguage = match[3]?.trim() ?? "";
  const language = normalizeFenceLanguage(rawLanguage);
  return { marker, length: fence.length, language };
}

function isClosingFence(line: string, fence: FenceInfo) {
  const markerPattern = fence.marker === "`" ? "`" : "~";
  const match = new RegExp("^\\s*" + markerPattern + "{" + fence.length + ",}\\s*$").exec(line);
  return Boolean(match);
}

function normalizeFenceLanguage(language: string) {
  if (!language) {
    return null;
  }

  const withoutBraces = language.replace(/^\{/, "").replace(/\}$/, "");
  const withoutLeadingDot = withoutBraces.replace(/^\./, "");
  return withoutLeadingDot || null;
}

/**
 * Convert a list of content regions into rows of StyledSegments, ready for
 * wrapping and rendering.
 */
function regionToRows(regions: ContentRegion[], innerWidth: number): StyledSegment[][] {
  const rows: StyledSegment[][] = [];

  for (const region of regions) {
    if (region.kind === "markdown") {
      rows.push(...renderMarkdownRows(region.lines.join("\n"), innerWidth));
    } else {
      // Code region — tokenize and wrap each line.
      const tokenized = tokenizeCode(region.lines, region.language);
      for (const segments of tokenized) {
        rows.push(...wrapSegments(segments as StyledSegment[], innerWidth));
      }
    }
  }

  return rows;
}

/** Render a user message as a boxed card with padding (keeps existing look). */
function renderUserBlock(block: RenderBlock, columns: number, sanitizedContent: string) {
  const theme = currentTheme.blocks.user;
  const innerWidth = Math.max(1, columns - 4);
  const content = sanitizedContent.trimStart().replace(/\n+$/, "");
  const rows: StyledSegment[][] = [[]]; // top padding

  if (block.title) {
    rows.push(...wrapSegments([{ text: block.title, style: "title" }], innerWidth));
    if (content) rows.push([]);
  }

  if (content) {
    rows.push(...regionToRows(splitContentRegions(content), innerWidth));
  }

  rows.push([]); // bottom padding

  return rows.map((row) => renderBlockRow(row, theme, columns));
}

/** Render assistant text inline on the black canvas — no box, no padding rows. */
function renderAssistantBlock(block: RenderBlock, columns: number, sanitizedContent: string) {
  const theme = currentTheme.blocks.assistant;
  const innerWidth = Math.max(1, columns - 4);
  const content = sanitizedContent.trimStart().replace(/\n+$/, "");
  const result: string[] = [];

  if (block.title && content) {
    // If there's both a title and content, show title as a heading then content
    const titleRows = wrapSegments([{ text: block.title, style: "title" }], innerWidth);
    for (const row of titleRows) {
      result.push(renderBlockRow(row, theme, columns));
    }
    // blank line between title and content
    result.push(renderBlockRow([], theme, columns));
    for (const row of regionToRows(splitContentRegions(content), innerWidth)) {
      result.push(renderBlockRow(row, theme, columns));
    }
  } else if (block.title) {
    const titleRows = wrapSegments([{ text: block.title, style: "title" }], innerWidth);
    for (const row of titleRows) {
      result.push(renderBlockRow(row, theme, columns));
    }
  } else if (content) {
    for (const row of regionToRows(splitContentRegions(content), innerWidth)) {
      result.push(renderBlockRow(row, theme, columns));
    }
  }

  return result;
}

/** Render model reasoning as a muted, collapsible reasoning line. */
function renderReasoningBlock(block: RenderBlock, columns: number, sanitizedContent: string) {
  const theme = currentTheme.blocks.reasoning;
  const innerWidth = Math.max(1, columns - 4);
  const content = sanitizedContent.trimStart().replace(/\n+$/, "");
  const collapsed = block.collapsed === true;
  const title = block.title ?? "Reasoning";

  if (collapsed) {
    return [renderBlockRow(reasoningTitleSegments(title, "collapsed"), theme, columns)];
  }

  if (!content) {
    return [renderBlockRow(reasoningTitleSegments(title, "expanded"), theme, columns)];
  }

  const rows: StyledSegment[][] = [reasoningTitleSegments(title, "expanded"), []];
  rows.push(...regionToRows(splitContentRegions(content), innerWidth));

  return rows.map((row) => renderBlockRow(row, theme, columns));
}

function reasoningTitleSegments(title: string, state: "collapsed" | "expanded"): StyledSegment[] {
  return [{ text: `${title}${state === "collapsed" ? " →" : ""}`, style: "title" }];
}

/** Render a muted one-line turn usage summary (model, cost, duration, tokens). */
function renderMetaBlock(block: RenderBlock, columns: number, sanitizedContent: string) {
  const theme = currentTheme.blocks.meta;
  const innerWidth = Math.max(1, columns - 4);
  const content = sanitizedContent.trim();
  if (!content) {
    return [];
  }

  const rows = wrapSegments([{ text: content, style: "normal" }], innerWidth);
  return rows.map((row) => renderBlockRow(row, theme, columns));
}

/** Render a tool block as a single inline line: `title  ✓` */
function renderInlineToolBlock(block: RenderBlock, columns: number, spinnerFrame: string) {
  const theme = currentTheme.blocks.inlineTool;
  const title = block.title ?? block.role;
  const indicator = renderInlineStateIndicator(block.state, spinnerFrame);
  // Indicator text is always a single plain character (no ANSI).
  const indicatorWidth = indicator ? displayWidth(indicator.text) + 1 : 0;
  const titleWidth = Math.max(1, columns - 4 - indicatorWidth);
  // Truncate title to fit
  const truncatedTitle = truncateToWidth(title, titleWidth);
  const titleVisible = displayWidth(truncatedTitle);
  const totalContentWidth = titleVisible + (indicator ? 1 + displayWidth(indicator.text) : 0);
  const rightPad = Math.max(0, columns - 2 - totalContentWidth);

  const titleRendered = `${RESET}${bg(theme.bg)}${fg(theme.accent)}${truncatedTitle}`;
  const indicatorRendered = indicator ? `${indicator.rendered} ` : "";
  const padRendered = `${RESET}${bg(theme.bg)}${" ".repeat(rightPad)}${RESET}`;

  return [`${bg(theme.bg)}  ${indicatorRendered}${titleRendered}${padRendered}`];
}

/** Render a tool block as a gray panel (has content to show). */
function renderPanelToolBlock(block: RenderBlock, columns: number, spinnerFrame: string, sanitizedContent: string) {
  const theme = currentTheme.blocks.tool;
  const content = sanitizedContent.trimStart().replace(/\n+$/, "");
  const indicator = renderStateIndicator(block.state, spinnerFrame, theme);
  // Indicator text is a single plain character (no ANSI).
  const indicatorWidth = indicator ? displayWidth(indicator.text) : 0;
  const titleInnerWidth = Math.max(1, columns - 4 - (indicatorWidth > 0 ? indicatorWidth + 1 : 0));
  const innerWidth = Math.max(1, columns - 4);
  const rows: StyledSegment[][] = [[]]; // top padding

  if (block.title) {
    rows.push(...wrapSegments([{ text: block.title, style: "title" }], titleInnerWidth));
    if (content) rows.push([]);
  }

  if (content) {
    rows.push(...regionToRows(splitContentRegions(content), innerWidth));
  }

  rows.push([]); // bottom padding

  const isCollapsed = block.collapsed === true;
  const maxRows = 15;

  let result = rows.map((row, index) => {
    if (index === 1 && indicator && block.title) {
      return renderBlockRowWithGutter(row, indicator, theme, columns);
    }
    return renderBlockRow(row, theme, columns);
  });

  if (isCollapsed && result.length > maxRows) {
    result = result.slice(0, maxRows - 3);
    result.push(renderBlockRow([], theme, columns));
    result.push(renderBlockRow([{ text: "Click to expand", style: "italic" }], theme, columns));
    result.push(renderBlockRow([], theme, columns));
  }

  return result;
}

/** Render an error block as a panel with the error theme. */
function renderErrorBlock(block: RenderBlock, columns: number, sanitizedContent: string) {
  const theme = currentTheme.blocks.error;
  const innerWidth = Math.max(1, columns - 4);
  const content = sanitizedContent.trimStart().replace(/\n+$/, "");
  const rows: StyledSegment[][] = [[]]; // top padding

  if (block.title) {
    rows.push(...wrapSegments([{ text: block.title, style: "title" }], innerWidth));
    if (content) rows.push([]);
  }

  if (content) {
    rows.push(...regionToRows(splitContentRegions(content), innerWidth));
  }

  rows.push([]); // bottom padding

  return rows.map((row) => renderBlockRow(row, theme, columns));
}

/** Truncate text to fit within a given display width. */
function truncateToWidth(text: string, maxWidth: number): string {
  let width = 0;
  let byteIndex = 0;
  for (const char of text) {
    const w = charWidth(char);
    if (width + w > maxWidth) {
      return text.substring(0, byteIndex) + "…";
    }
    width += w;
    byteIndex += char.length;
  }
  return text;
}

function renderStateIndicator(
  state: BlockState | undefined,
  spinnerFrame: string,
  theme: BlockTheme,
): { text: string; rendered: string } | undefined {
  if (!state) {
    return undefined;
  }

  if (state === "running") {
    return {
      text: spinnerFrame,
      rendered: `${RESET}${bg(theme.bg)}${fg(currentTheme.status.runningFg)}${spinnerFrame}`,
    };
  }

  if (state === "error") {
    return {
      text: currentTheme.glyphs.error.glyph,
      rendered: `${RESET}${bg(theme.bg)}${fg(currentTheme.glyphs.error.color)}${BOLD}${currentTheme.glyphs.error.glyph}`,
    };
  }

  // state === "done"
  return {
    text: currentTheme.glyphs.done.glyph,
    rendered: `${RESET}${bg(theme.bg)}${fg(currentTheme.glyphs.done.color)}${BOLD}${currentTheme.glyphs.done.glyph}`,
  };
}

/** State indicator for inline tool lines (rendered on the black canvas). */
function renderInlineStateIndicator(
  state: BlockState | undefined,
  spinnerFrame: string,
): { text: string; rendered: string } | undefined {
  if (!state) {
    return undefined;
  }

  if (state === "running") {
    return {
      text: spinnerFrame,
      rendered: `${RESET}${bg(currentTheme.canvas.bg)}${fg(currentTheme.status.runningFg)}${spinnerFrame}`,
    };
  }

  if (state === "error") {
    return {
      text: currentTheme.glyphs.error.glyph,
      rendered: `${RESET}${bg(currentTheme.canvas.bg)}${fg(currentTheme.glyphs.error.color)}${BOLD}${currentTheme.glyphs.error.glyph}`,
    };
  }

  // done
  return {
    text: currentTheme.glyphs.done.glyph,
    rendered: `${RESET}${bg(currentTheme.canvas.bg)}${fg(currentTheme.glyphs.done.color)}${currentTheme.glyphs.done.glyph}`,
  };
}

function renderBlockRowWithGutter(
  segments: StyledSegment[],
  indicator: { text: string; rendered: string },
  theme: BlockTheme,
  columns: number,
) {
  // Segment text is always plain (no ANSI), so displayWidth is sufficient.
  const visible = segments.reduce((total, segment) => total + displayWidth(segment.text), 0);
  const indicatorWidth = displayWidth(indicator.text);
  const middlePadding = Math.max(1, columns - 2 - visible - indicatorWidth - 3);
  const base = `${bg(theme.bg)}${fg(theme.fg)}`;
  const content = segments.map((segment) => renderSegment(segment, theme)).join("");
  return `${base}  ${indicator.rendered} ${content}${RESET}${bg(theme.bg)}${fg(theme.fg)}${" ".repeat(middlePadding)}${RESET}${bg(theme.bg)}  ${RESET}`;
}

function renderBlockRow(segments: StyledSegment[], theme: BlockTheme, columns: number) {
  // Segment text is always plain (no ANSI), so displayWidth is sufficient.
  const visible = segments.reduce((total, segment) => total + displayWidth(segment.text), 0);
  const rightPadding = Math.max(0, columns - 2 - visible);
  const base = `${bg(theme.bg)}${fg(theme.fg)}`;
  const content = segments.map((segment) => renderSegment(segment, theme)).join("");
  return `${base}  ${content}${RESET}${bg(theme.bg)}${fg(theme.fg)}${" ".repeat(rightPadding)}${RESET}`;
}

// Map shell syntax token styles to the active theme's syntax palette. Colors
// are theme-aware so they stay readable on both dark and light backgrounds.
function syntaxColorFor(style: SegmentStyle): number | undefined {
  const syntax = currentTheme.syntax;
  switch (style) {
    case "sh-keyword":
      return syntax.keyword;
    case "sh-string":
      return syntax.string;
    case "sh-number":
      return syntax.number;
    case "sh-comment":
      return syntax.comment;
    case "sh-type":
      return syntax.type;
    case "sh-function":
      return syntax.function;
    case "sh-operator":
      return syntax.operator;
    case "sh-punctuation":
      return syntax.punctuation;
    case "sh-property":
      return syntax.property;
    case "sh-diff-add":
      return syntax.diffAdd;
    case "sh-diff-remove":
      return syntax.diffRemove;
    case "sh-diff-context":
      return syntax.comment;
    default:
      return undefined;
  }
}

function renderSegment(segment: StyledSegment, theme: BlockTheme) {
  if (!segment.text) {
    return "";
  }

  switch (segment.style) {
    case "title":
      return `${RESET}${bg(theme.bg)}${fg(theme.accent)}${BOLD}${segment.text}`;
    case "heading":
      return `${RESET}${bg(theme.bg)}${fg(currentTheme.syntax.heading)}${BOLD}${segment.text}`;
    case "bold":
      return `${RESET}${bg(theme.bg)}${fg(theme.bold)}${BOLD}${segment.text}`;
    case "italic":
      return `${RESET}${bg(theme.bg)}${fg(theme.fg)}${ITALIC}${segment.text}`;
    case "code":
      return `${RESET}${bg(theme.bg)}${fg(currentTheme.syntax.code)}${segment.text}`;
    case "tableBorder":
      return `${RESET}${bg(theme.bg)}${fg(245)}${segment.text}`;
    case "sh-raw": {
      const ansiColor = segment.color ? hexToAnsi256(segment.color) : theme.fg;
      const bold = segment.fontStyle && (segment.fontStyle & 2) ? BOLD : "";
      const italic = segment.fontStyle && (segment.fontStyle & 1) ? ITALIC : "";
      return `${RESET}${bg(theme.bg)}${fg(ansiColor)}${bold}${italic}${segment.text}`;
    }
    default: {
      const syntaxColor = syntaxColorFor(segment.style);
      if (syntaxColor !== undefined) {
        return `${RESET}${bg(theme.bg)}${fg(syntaxColor)}${segment.text}`;
      }
      return `${RESET}${bg(theme.bg)}${fg(theme.fg)}${segment.text}`;
    }
  }
}

function renderMarkdownRows(content: string, width: number) {
  const lines = content.split("\n");
  const rows: StyledSegment[][] = [];
  let inFencedCodeBlock = false;
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (isMarkdownFenceLine(line)) {
      inFencedCodeBlock = !inFencedCodeBlock;
      rows.push(...renderMarkdownLine(line, width));
      index += 1;
      continue;
    }

    if (!inFencedCodeBlock) {
      const parsedTable = parseMarkdownTableAt(lines, index);
      if (parsedTable) {
        rows.push(...renderMarkdownTableRows(parsedTable.table, width));
        index = parsedTable.nextIndex;
        continue;
      }
    }

    rows.push(...renderMarkdownLine(line, width));
    index += 1;
  }

  return rows;
}

function renderMarkdownLine(line: string, width: number) {
  return wrapSegments(parseMarkdownLine(line), width);
}

function renderMarkdownLines(lines: string[], width: number) {
  return lines.flatMap((line) => renderMarkdownLine(line, width));
}

function parseMarkdownTableAt(lines: string[], index: number): ParsedMarkdownTable | undefined {
  const line = lines[index];
  const nextLine = lines[index + 1];
  const alignments = nextLine === undefined ? undefined : parseTableSeparator(nextLine);
  if (!isTableCandidateLine(line) || !alignments) {
    return undefined;
  }

  const header = splitTableRow(line);
  const rows: string[][] = [];
  const rawLines = [line, nextLine];
  let nextIndex = index + 2;

  while (nextIndex < lines.length && isTableCandidateLine(lines[nextIndex]) && !parseTableSeparator(lines[nextIndex])) {
    rows.push(splitTableRow(lines[nextIndex]));
    rawLines.push(lines[nextIndex]);
    nextIndex += 1;
  }

  return { table: { header, alignments, rows, rawLines }, nextIndex };
}

function isMarkdownFenceLine(line: string) {
  return /^\s*(```|~~~)/.test(line);
}

function isTableCandidateLine(line: string) {
  if (!line.includes("|")) {
    return false;
  }
  return splitTableRow(line).length >= 2;
}

function parseTableSeparator(line: string): TableAlignment[] | undefined {
  if (!line.includes("|")) {
    return undefined;
  }

  const cells = splitTableRow(line);
  if (cells.length < 2) {
    return undefined;
  }

  const alignments: TableAlignment[] = [];
  for (const cell of cells) {
    const marker = cell.trim();
    if (!/^:?-{3,}:?$/.test(marker)) {
      return undefined;
    }
    if (marker.startsWith(":") && marker.endsWith(":")) {
      alignments.push("center");
    } else if (marker.endsWith(":")) {
      alignments.push("right");
    } else {
      alignments.push("left");
    }
  }

  return alignments;
}

function splitTableRow(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inCode = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === "\\" && line[index + 1] === "|") {
      current += "|";
      index += 1;
      continue;
    }
    if (char === "`") {
      inCode = !inCode;
      current += char;
      continue;
    }
    if (char === "|" && !inCode) {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  cells.push(current.trim());

  const trimmed = line.trim();
  if (trimmed.startsWith("|") && cells[0] === "") {
    cells.shift();
  }
  if (trimmed.endsWith("|") && cells[cells.length - 1] === "") {
    cells.pop();
  }

  return cells;
}

function renderMarkdownTableRows(table: MarkdownTable, width: number) {
  const normalized = normalizeMarkdownTable(table);
  const widths = computeTableColumnWidths(normalized.header, normalized.rows, width);
  if (!widths) {
    return renderMarkdownLines(table.rawLines, width);
  }

  const rows: StyledSegment[][] = [];
  rows.push(renderTableRule(widths, "top"));
  rows.push(...renderTableDataRow(normalized.header, widths, normalized.alignments, true));
  rows.push(renderTableRule(widths, "middle"));
  for (let i = 0; i < normalized.rows.length; i++) {
    rows.push(...renderTableDataRow(normalized.rows[i], widths, normalized.alignments, false));
    rows.push(renderTableRule(widths, i < normalized.rows.length - 1 ? "middle" : "bottom"));
  }
  return rows;
}

function normalizeMarkdownTable(table: MarkdownTable) {
  const columnCount = Math.max(
    table.header.length,
    table.alignments.length,
    ...table.rows.map((row) => row.length),
  );
  const normalizeRow = (row: string[]) => {
    const normalized = row.slice(0, columnCount);
    while (normalized.length < columnCount) {
      normalized.push("");
    }
    return normalized;
  };
  const alignments = table.alignments.slice(0, columnCount);
  while (alignments.length < columnCount) {
    alignments.push("left");
  }
  return {
    header: normalizeRow(table.header),
    alignments,
    rows: table.rows.map(normalizeRow),
  };
}

function computeTableColumnWidths(header: string[], rows: string[][], innerWidth: number) {
  const columnCount = header.length;
  if (columnCount === 0) {
    return undefined;
  }

  const borderAndPaddingWidth = columnCount * 3 + 1;
  const minWidths = Array.from({ length: columnCount }, (_, columnIndex) =>
    Math.max(
      1,
      measureTableCellMinWidth(header[columnIndex] ?? ""),
      ...rows.map((row) => measureTableCellMinWidth(row[columnIndex] ?? "")),
    ),
  );
  const minimumContentWidth = sumNumbers(minWidths);
  if (innerWidth < borderAndPaddingWidth + minimumContentWidth) {
    return undefined;
  }

  const widths = Array.from({ length: columnCount }, (_, columnIndex) =>
    Math.max(
      minWidths[columnIndex],
      measureTableCell(header[columnIndex] ?? ""),
      ...rows.map((row) => measureTableCell(row[columnIndex] ?? "")),
    ),
  );

  const maxTotalCellWidth = innerWidth - borderAndPaddingWidth;
  while (sumNumbers(widths) > maxTotalCellWidth) {
    let widestIndex = 0;
    for (let index = 1; index < widths.length; index += 1) {
      if (widths[index] > widths[widestIndex]) {
        widestIndex = index;
      }
    }
    if (widths[widestIndex] <= minWidths[widestIndex]) {
      return undefined;
    }
    widths[widestIndex] -= 1;
  }

  return widths;
}

function measureTableCell(cell: string) {
  return parseMarkdownLine(cell).reduce((total, segment) => total + displayWidth(segment.text), 0);
}

function measureTableCellMinWidth(cell: string): number {
  let maxWidth = 1;
  for (const segment of parseMarkdownLine(cell)) {
    for (const char of segment.text) {
      maxWidth = Math.max(maxWidth, charWidth(char));
    }
  }
  return maxWidth;
}

function renderTableRule(widths: number[], position: "top" | "middle" | "bottom"): StyledSegment[] {
  const [left, sep, right] =
    position === "top"
      ? ["┌", "┬", "┐"]
      : position === "middle"
        ? ["├", "┼", "┤"]
        : ["└", "┴", "┘"];
  return [{ text: `${left}${widths.map((width) => "─".repeat(width + 2)).join(sep)}${right}`, style: "tableBorder" }];
}

function renderTableDataRow(cells: string[], widths: number[], alignments: TableAlignment[], isHeader: boolean) {
  const wrappedCells = cells.map((cell, index) => {
    const parsed = parseMarkdownLine(cell);
    const segments = isHeader ? emphasizeTableHeader(parsed) : parsed;
    return wrapSegments(segments, widths[index]);
  });
  const height = Math.max(1, ...wrappedCells.map((rows) => rows.length));
  const result: StyledSegment[][] = [];

  for (let rowIndex = 0; rowIndex < height; rowIndex += 1) {
    const row: StyledSegment[] = [{ text: "│", style: "tableBorder" }];
    for (let columnIndex = 0; columnIndex < widths.length; columnIndex += 1) {
      const cellRow = wrappedCells[columnIndex][rowIndex] ?? [];
      row.push({ text: " ", style: "normal" });
      row.push(...alignTableSegments(cellRow, widths[columnIndex], alignments[columnIndex]));
      row.push({ text: " ", style: "normal" });
      row.push({ text: "│", style: "tableBorder" });
    }
    result.push(row);
  }

  return result;
}

function emphasizeTableHeader(segments: StyledSegment[]) {
  return segments.map((segment) => {
    if (segment.style === "normal" || segment.style === "italic") {
      return { ...segment, style: "bold" as const };
    }
    return segment;
  });
}

function alignTableSegments(segments: StyledSegment[], width: number, alignment: TableAlignment) {
  const visible = segments.reduce((total, segment) => total + displayWidth(segment.text), 0);
  const padding = Math.max(0, width - visible);
  let leftPadding = 0;
  let rightPadding = padding;
  if (alignment === "right") {
    leftPadding = padding;
    rightPadding = 0;
  } else if (alignment === "center") {
    leftPadding = Math.floor(padding / 2);
    rightPadding = padding - leftPadding;
  }

  const result: StyledSegment[] = [];
  if (leftPadding > 0) {
    result.push({ text: " ".repeat(leftPadding), style: "normal" });
  }
  result.push(...segments);
  if (rightPadding > 0) {
    result.push({ text: " ".repeat(rightPadding), style: "normal" });
  }
  return result;
}

function sumNumbers(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}

function parseMarkdownLine(line: string): StyledSegment[] {
  const heading = /^(#{1,6})\s+(.+)$/.exec(line);
  if (heading) {
    return [{ text: heading[2], style: "heading" }];
  }

  const segments: StyledSegment[] = [];
  let index = 0;
  let normal = "";

  const flushNormal = () => {
    if (normal) {
      segments.push({ text: normal, style: "normal" });
      normal = "";
    }
  };

  while (index < line.length) {
    if (line.startsWith("`", index)) {
      const end = line.indexOf("`", index + 1);
      if (end !== -1) {
        flushNormal();
        segments.push({ text: line.slice(index + 1, end), style: "code" });
        index = end + 1;
        continue;
      }
    }

    if (line.startsWith("**", index)) {
      const end = line.indexOf("**", index + 2);
      if (end !== -1) {
        flushNormal();
        segments.push({ text: line.slice(index + 2, end), style: "bold" });
        index = end + 2;
        continue;
      }
    }

    if (line.startsWith("*", index)) {
      const end = line.indexOf("*", index + 1);
      if (end !== -1) {
        flushNormal();
        segments.push({ text: line.slice(index + 1, end), style: "italic" });
        index = end + 1;
        continue;
      }
    }

    normal += line[index];
    index += 1;
  }

  flushNormal();
  return segments.length > 0 ? segments : [{ text: "", style: "normal" }];
}

type InputLayout = {
  lines: string[];
  cursorLine: number;
  cursorCol: number;
  /** Given a visual (line, col) position, return the character offset into the input text. */
  charOffsetAt: (line: number, col: number) => number;
};

/**
 * Wraps input text for display and computes cursor position within the
 * wrapped layout. Also provides a reverse mapping from visual coordinates
 * back to character offsets, used for Up/Down/Home/End cursor movement.
 *
 * `cursorPos` is a character (grapheme) offset into `text`, ranging from
 * 0 to Array.from(text).length inclusive.
 */
function wrapInputTextWithCursor(text: string, width: number, cursorPos: number): InputLayout {
  const allChars = Array.from(text);
  const maxWidth = Math.max(1, width);

  // We process the text line-by-line (split on \n), wrapping each line.
  // For each character we track which visual row/col it maps to, and
  // build the reverse mapping at the same time.

  const lines: string[] = [];
  // For each visual line, store the char offset of its first character
  const lineStartOffsets: number[] = [];
  // For each visual line, store an array of { charOffset, cellStart } for
  // each character on that line, to enable reverse lookup.
  const lineCharMaps: { charOffset: number; cellStart: number; cellEnd: number }[][] = [];

  let cursorLine = 0;
  let cursorCol = 0;
  let globalCharIndex = 0; // index into allChars

  const rawLines = text.split("\n");
  for (let lineIdx = 0; lineIdx < rawLines.length; lineIdx++) {
    const rawLine = rawLines[lineIdx];
    const lineChars = Array.from(rawLine);
    const lineStartGlobal = globalCharIndex;

    // Wrap this single line, tracking character positions
    const wrappedRows = wrapInputLineWithOffsets(lineChars, maxWidth, lineStartGlobal);

    if (wrappedRows.length === 0) {
      // Empty line
      const row = lines.length;
      lines.push("");
      lineStartOffsets.push(lineStartGlobal);
      lineCharMaps.push([]);

      // Check if cursor is at this position (at the \n or end of text)
      if (cursorPos === globalCharIndex) {
        cursorLine = row;
        cursorCol = 0;
      }
    } else {
      for (const wrappedRow of wrappedRows) {
        const row = lines.length;
        lines.push(wrappedRow.text);
        lineStartOffsets.push(wrappedRow.startOffset);
        lineCharMaps.push(wrappedRow.charMap);

        // Check if cursor falls within this row
        for (const entry of wrappedRow.charMap) {
          if (entry.charOffset === cursorPos) {
            cursorLine = row;
            cursorCol = entry.cellStart;
          }
        }

        // Cursor might be at the end of this row (after the last char)
        const lastEntry = wrappedRow.charMap[wrappedRow.charMap.length - 1];
        if (lastEntry && lastEntry.charOffset + 1 === cursorPos) {
          // Only set if this is the last wrapped row for this raw line,
          // or if cursorPos points to a \n
          const isLastWrappedRow = wrappedRow === wrappedRows[wrappedRows.length - 1];
          if (isLastWrappedRow) {
            cursorLine = row;
            cursorCol = lastEntry.cellEnd;
          }
        }
      }
    }

    // Account for the \n between raw lines
    globalCharIndex = lineStartGlobal + lineChars.length;
    if (lineIdx < rawLines.length - 1) {
      // There's a \n separator
      if (cursorPos === globalCharIndex) {
        // Cursor is right on the \n — show at end of last wrapped row of this line
        const row = lines.length - 1;
        const map = lineCharMaps[row];
        const lastEntry = map?.[map.length - 1];
        cursorLine = row;
        cursorCol = lastEntry ? lastEntry.cellEnd : 0;
      }
      globalCharIndex += 1; // skip the \n
    }
  }

  // Handle cursor at very end of text
  if (cursorPos >= allChars.length && lines.length > 0) {
    const lastRow = lines.length - 1;
    const map = lineCharMaps[lastRow];
    const lastEntry = map?.[map.length - 1];
    cursorLine = lastRow;
    cursorCol = lastEntry ? lastEntry.cellEnd : 0;
  }

  const charOffsetAt = (line: number, col: number): number => {
    const clampedLine = Math.max(0, Math.min(lines.length - 1, line));
    const map = lineCharMaps[clampedLine];
    if (!map || map.length === 0) {
      return lineStartOffsets[clampedLine] ?? 0;
    }

    // Find the character whose cell range contains `col`, or the closest one
    let best = map[0].charOffset;
    for (const entry of map) {
      if (col >= entry.cellEnd) {
        best = entry.charOffset + 1;
      } else if (col >= entry.cellStart) {
        best = entry.charOffset;
        break;
      } else {
        break;
      }
    }

    return Math.min(best, allChars.length);
  };

  return { lines, cursorLine, cursorCol, charOffsetAt };
}

type WrappedRowInfo = {
  text: string;
  startOffset: number;
  charMap: { charOffset: number; cellStart: number; cellEnd: number }[];
};

/**
 * Wraps a single line's characters into visual rows, tracking the global
 * character offset for each character placed.
 */
function wrapInputLineWithOffsets(
  chars: string[],
  maxWidth: number,
  globalStart: number,
): WrappedRowInfo[] {
  const rows: WrappedRowInfo[] = [];
  let index = 0;

  if (chars.length === 0) {
    return [];
  }

  while (index < chars.length) {
    // Skip leading whitespace on continuation rows
    while (rows.length > 0 && isInputWrapWhitespace(chars[index])) {
      index += 1;
    }
    if (index >= chars.length) {
      break;
    }

    let end = index;
    let used = 0;
    let lastWhitespace = -1;

    while (end < chars.length) {
      const charCells = charWidth(chars[end]);
      if (used > 0 && used + charCells > maxWidth) {
        break;
      }

      used += charCells;
      if (isInputWrapWhitespace(chars[end])) {
        lastWhitespace = end;
      }
      end += 1;
    }

    if (end >= chars.length) {
      // Last row — take everything
      const rowChars = chars.slice(index, end);
      const charMap: WrappedRowInfo["charMap"] = [];
      let cell = 0;
      for (let i = 0; i < rowChars.length; i++) {
        const w = charWidth(rowChars[i]);
        charMap.push({ charOffset: globalStart + index + i, cellStart: cell, cellEnd: cell + w });
        cell += w;
      }
      rows.push({ text: rowChars.join(""), startOffset: globalStart + index, charMap });
      break;
    }

    let rowEnd = end;
    let next = end;
    if (lastWhitespace > index) {
      rowEnd = lastWhitespace;
      while (rowEnd > index && isInputWrapWhitespace(chars[rowEnd - 1])) {
        rowEnd -= 1;
      }
      next = lastWhitespace + 1;
    }

    if (rowEnd === index) {
      rowEnd = index + 1;
      next = rowEnd;
    }

    const rowChars = chars.slice(index, rowEnd);
    const charMap: WrappedRowInfo["charMap"] = [];
    let cell = 0;
    for (let i = 0; i < rowChars.length; i++) {
      const w = charWidth(rowChars[i]);
      charMap.push({ charOffset: globalStart + index + i, cellStart: cell, cellEnd: cell + w });
      cell += w;
    }
    rows.push({ text: rowChars.join(""), startOffset: globalStart + index, charMap });
    index = next;
  }

  return rows;
}

function isInputWrapWhitespace(char: string | undefined) {
  return char === " " || char === "\t";
}

function wrapSegments(segments: StyledSegment[], width: number) {
  const chars = segments.flatMap((segment) =>
    Array.from(segment.text).map((char) => ({
      text: char,
      style: segment.style,
      color: segment.color,
      fontStyle: segment.fontStyle,
      width: charWidth(char),
    })),
  );

  if (chars.length === 0) {
    return [[]];
  }

  const rows: StyledSegment[][] = [];
  let index = 0;

  while (index < chars.length) {
    if (rows.length > 0) {
      while (chars[index]?.text === " ") {
        index += 1;
      }
      if (index >= chars.length) {
        break;
      }
    }

    let end = index;
    let used = 0;
    let lastSpace = -1;

    while (end < chars.length && used + chars[end].width <= width) {
      used += chars[end].width;
      if (chars[end].text === " ") {
        lastSpace = end;
      }
      end += 1;
    }

    let next = end;
    if (end < chars.length && lastSpace > index) {
      end = lastSpace;
      next = lastSpace + 1;
    } else if (end === index) {
      end = index + 1;
      next = end;
    }

    const rowChars = chars.slice(index, end);
    while (rowChars[rowChars.length - 1]?.text === " ") {
      rowChars.pop();
    }

    rows.push(coalesceSegments(rowChars));
    index = next;
  }

  return rows;
}

function coalesceSegments(chars: StyledSegment[]) {
  const segments: StyledSegment[] = [];
  for (const char of chars) {
    const previous = segments[segments.length - 1];
    if (previous?.style === char.style && previous.color === char.color && previous.fontStyle === char.fontStyle) {
      previous.text += char.text;
    } else {
      segments.push({ ...char });
    }
  }
  return segments;
}

function renderBar(text: string, columns: number, bgColor: number, fgColor: number, preSanitized = false) {
  const clean = preSanitized ? text : sanitizeSingleLine(text);
  const clipped = takeRight(clean, columns);
  const pad = Math.max(0, columns - displayWidth(clipped));
  return `${bg(bgColor)}${fg(fgColor)}${clipped}${" ".repeat(pad)}${RESET}`;
}

let cachedBlackLine = "";
let cachedBlackLineColumns = -1;

function blackLine(columns: number) {
  if (columns !== cachedBlackLineColumns) {
    cachedBlackLineColumns = columns;
    cachedBlackLine = `${bg(currentTheme.canvas.bg)}${" ".repeat(columns)}${RESET}`;
  }
  return cachedBlackLine;
}

function overlayLine(content: string, columns: number) {
  const pad = Math.max(0, columns - visibleLength(content));
  return `${bg(currentTheme.overlay.bg)}${content}${" ".repeat(pad)}${RESET}`;
}

function overlayChromeLine(content: string, columns: number) {
  const pad = Math.max(0, columns - visibleLength(content));
  return `${bg(currentTheme.overlay.chromeBg)}${content}${" ".repeat(pad)}${RESET}`;
}

/** Render a model id, brightening fuzzy-matched character positions. */
function highlightModelId(id: string, positions: number[], baseFg: number, matchFg: number): string {
  if (positions.length === 0) {
    return `${fg(baseFg)}${id}`;
  }
  const matched = new Set(positions);
  let out = "";
  for (let i = 0; i < id.length; i++) {
    if (matched.has(i)) {
      out += `${BOLD}${fg(matchFg)}${id[i]}${NO_BOLD}`;
    } else {
      out += `${fg(baseFg)}${id[i]}`;
    }
  }
  return out;
}

/** Format a per-MTok price, dropping trailing decimals for whole numbers. */
function formatPrice(price: number): string {
  return Number.isInteger(price) ? String(price) : price.toFixed(2);
}

function formatSessionOverlayTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return timestamp.replace("T", " ").slice(0, 16);
  }

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

type SessionOverlayColumns = {
  columns: number;
  bgColor: number;
  date: string;
  id: string;
  name: string;
  entries: string;
  cost: string;
  fgColor: number;
  activeColor: number;
  starMarker?: string;
  activeMarker?: string;
};

function renderSessionOverlayColumns(options: SessionOverlayColumns): string {
  const dateWidth = 16;
  const idWidth = 8;
  const entriesWidth = 4;
  const costWidth = 9;
  const gap = 2;
  const leftPadding = 2;
  const starWidth = 1;
  const markerWidth = 1;
  const fixedWidth = leftPadding + starWidth + gap + markerWidth + gap + dateWidth + gap + idWidth + gap + gap + entriesWidth + gap + costWidth;
  const nameWidth = Math.max(0, options.columns - fixedWidth);

  const starMarker = options.starMarker ?? " ";
  const marker = options.activeMarker ?? " ";
  const date = padRight(truncateToWidth(options.date, dateWidth), dateWidth);
  const id = padRight(truncateToWidth(options.id, idWidth), idWidth);
  const name = padRight(truncateToWidth(options.name, nameWidth), nameWidth);
  const entries = padRight(truncateToWidth(options.entries, entriesWidth), entriesWidth);
  const cost = padLeft(truncateToWidth(options.cost, costWidth), costWidth);
  const visible = leftPadding + starWidth + gap + markerWidth + gap + dateWidth + gap + idWidth + gap + nameWidth + gap + entriesWidth + gap + costWidth;
  const trailing = Math.max(0, options.columns - visible);

  return `${bg(options.bgColor)}${" ".repeat(leftPadding)}${fg(currentTheme.starColor)}${starMarker}${fg(options.fgColor)}${" ".repeat(gap)}${fg(options.activeColor)}${marker}${fg(options.fgColor)}${" ".repeat(gap)}${date}${" ".repeat(gap)}${id}${fg(currentTheme.blocks.user.accent)}${" ".repeat(gap)}${name}${fg(options.fgColor)}${" ".repeat(gap)}${entries}${" ".repeat(gap)}${fg(currentTheme.status.costFg)}${cost}${" ".repeat(trailing)}${RESET}`;
}

function padRight(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - displayWidth(text)));
}

function padLeft(text: string, width: number): string {
  return " ".repeat(Math.max(0, width - displayWidth(text))) + text;
}

function plainLine(text: string, columns: number) {
  const textWidth = text.length > 0 ? visibleLength(text) : 0;
  const pad = Math.max(0, columns - textWidth);
  return `${bg(currentTheme.canvas.bg)}${text}${" ".repeat(pad)}${RESET}`;
}

function padAnsi(text: string, columns: number) {
  const pad = Math.max(0, columns - visibleLength(text));
  if (pad <= 0) return text;
  return `${text}${bg(currentTheme.canvas.bg)}${" ".repeat(pad)}${RESET}`;
}

function sanitizeContent(text: string) {
  return String(text)
    .replace(ANSI_PATTERN, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\t/g, "  ")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

function sanitizeSingleLine(text: string) {
  return sanitizeContent(text).replace(/\n/g, " ");
}

function takeRight(text: string, width: number) {
  // We need to iterate from the right, which requires knowing character
  // boundaries. Use a single Array.from pass only when the text is long
  // enough that it might exceed the width; short strings (common case)
  // can skip the right-truncation entirely.
  const textWidth = displayWidth(text);
  if (textWidth <= width) {
    return text;
  }

  // Need to truncate from the left — iterate characters from the right
  const chars = Array.from(text);
  let result = "";
  let used = 0;

  for (let index = chars.length - 1; index >= 0; index -= 1) {
    const char = chars[index];
    const widthToAdd = charWidth(char);
    if (used + widthToAdd > width) {
      break;
    }

    result = char + result;
    used += widthToAdd;
  }

  return result;
}

function visibleLength(text: string) {
  return displayWidth(stripAnsi(text));
}

function stripAnsi(text: string) {
  return text.replace(ANSI_PATTERN, "");
}

function clipAnsi(text: string, width: number) {
  let result = "";
  let used = 0;
  let index = 0;
  const len = text.length;

  while (index < len) {
    const code = text.charCodeAt(index);

    // Fast path: check for ESC (0x1b) to detect ANSI sequences
    if (code === 0x1b) {
      const ansi = ANSI_AT_START.exec(text.substring(index));
      if (ansi) {
        result += ansi[0];
        index += ansi[0].length;
        continue;
      }
    }

    // Extract the next character (handle surrogate pairs)
    let char: string;
    if (code >= 0xd800 && code <= 0xdbff && index + 1 < len) {
      // Surrogate pair
      char = text.substring(index, index + 2);
    } else {
      char = text[index];
    }

    const widthToAdd = charWidth(char);
    if (used + widthToAdd > width) {
      break;
    }

    result += char;
    used += widthToAdd;
    index += char.length;
  }

  return `${result}${RESET}`;
}

function displayWidth(text: string) {
  let width = 0;
  for (const char of text) {
    width += charWidth(char);
  }
  return width;
}

function charWidth(char: string) {
  const codePoint = char.codePointAt(0) ?? 0;
  if (codePoint === 0 || codePoint < 32 || (codePoint >= 0x7f && codePoint < 0xa0)) {
    return 0;
  }

  if (isCombining(codePoint) || codePoint === 0x200d || (codePoint >= 0xfe00 && codePoint <= 0xfe0f)) {
    return 0;
  }

  // Some symbols in the emoji block are rendered as single-cell glyphs by
  // common terminals. Treat them as narrow so table borders do not drift.
  if (codePoint === 0x1f5a7 || codePoint === 0x1f326) {
    return 1;
  }

  return isWide(codePoint) || isEmojiPresentation(codePoint) ? 2 : 1;
}

function isCombining(codePoint: number) {
  return (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe20 && codePoint <= 0xfe2f)
  );
}

function isWide(codePoint: number) {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2329 && codePoint <= 0x232a) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f000 && codePoint <= 0x1faff)
  );
}

function isEmojiPresentation(codePoint: number) {
  return (
    codePoint === 0x2b50 ||
    codePoint === 0x231a ||
    codePoint === 0x231b ||
    (codePoint >= 0x23e9 && codePoint <= 0x23ec) ||
    codePoint === 0x23f0 ||
    codePoint === 0x23f3 ||
    (codePoint >= 0x25fd && codePoint <= 0x25fe) ||
    (codePoint >= 0x2614 && codePoint <= 0x2615) ||
    (codePoint >= 0x2648 && codePoint <= 0x2653) ||
    codePoint === 0x267f ||
    codePoint === 0x2693 ||
    codePoint === 0x26a1 ||
    (codePoint >= 0x26aa && codePoint <= 0x26ab) ||
    (codePoint >= 0x26bd && codePoint <= 0x26be) ||
    (codePoint >= 0x26c4 && codePoint <= 0x26c5) ||
    codePoint === 0x26ce ||
    codePoint === 0x26d4 ||
    codePoint === 0x26ea ||
    (codePoint >= 0x26f2 && codePoint <= 0x26f3) ||
    codePoint === 0x26f5 ||
    codePoint === 0x26fa ||
    codePoint === 0x26fd ||
    codePoint === 0x2705 ||
    (codePoint >= 0x270a && codePoint <= 0x270b) ||
    codePoint === 0x2728 ||
    codePoint === 0x274c ||
    codePoint === 0x274e ||
    (codePoint >= 0x2753 && codePoint <= 0x2755) ||
    codePoint === 0x2757 ||
    (codePoint >= 0x2795 && codePoint <= 0x2797) ||
    codePoint === 0x27b0 ||
    codePoint === 0x27bf ||
    (codePoint >= 0x2b1b && codePoint <= 0x2b1c) ||
    codePoint === 0x2b55
  );
}

function formatContextInfo(info: ContextInfo): string {
  const used = formatTokenCount(info.usedTokens);
  const percent = info.contextWindow > 0
    ? Math.round((info.usedTokens / info.contextWindow) * 100)
    : 0;
  return `${used} (${percent}%)`;
}

function fg(code: number) {
  return `\x1b[38;5;${code}m`;
}

function bg(code: number) {
  return `\x1b[48;5;${code}m`;
}
