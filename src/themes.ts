export type BlockRole = "user" | "assistant" | "reasoning" | "tool" | "error";

export type BlockTheme = {
  fg: number;
  bg: number;
  accent: number;
  bold: number;
};

export type SyntaxTheme = {
  /** Markdown heading text. */
  heading: number;
  /** Inline `code` spans. */
  code: number;
  /** Shell syntax tokens. */
  keyword: number;
  string: number;
  number: number;
  comment: number;
  type: number;
  function: number;
  operator: number;
  punctuation: number;
  property: number;
};

export type TuiTheme = {
  name: string;
  blocks: Record<BlockRole, BlockTheme> & { inlineTool: BlockTheme };
  syntax: SyntaxTheme;
  canvas: { bg: number; panelBg: number };
  overlay: { bg: number; chromeBg: number; selBg: number; fg: number; dimFg: number; brightFg: number };
  suggestion: { bg: number };
  status: {
    bg: number;
    fg: number;
    runningFg: number;
    contextFg: number;
    contextWarnFg: number;
    costFg: number;
    modelFg: number;
  };
  input: { bg: number; bashBg: number; fg: number; bashFg: number };
  glyphs: { done: { glyph: string; color: number }; error: { glyph: string; color: number } };
  logoColor: number;
  starColor: number;
  shikiTheme: string;
};

export const BUILT_IN_THEMES: Record<string, TuiTheme> = {
  dark: {
    name: "dark",
    blocks: {
      user: { fg: 231, bg: 24, accent: 117, bold: 230 },
      assistant: { fg: 255, bg: 234, accent: 221, bold: 215 },
      reasoning: { fg: 245, bg: 234, accent: 179, bold: 179 },
      tool: { fg: 252, bg: 235, accent: 117, bold: 230 },
      error: { fg: 231, bg: 88, accent: 217, bold: 223 },
      inlineTool: { fg: 245, bg: 234, accent: 117, bold: 230 },
    },
    syntax: {
      heading: 220,
      code: 120,
      keyword: 204,
      string: 151,
      number: 179,
      comment: 245,
      type: 81,
      function: 117,
      operator: 186,
      punctuation: 250,
      property: 187,
    },
    canvas: { bg: 234, panelBg: 235 },
    overlay: { bg: 235, chromeBg: 237, selBg: 238, fg: 245, dimFg: 244, brightFg: 252 },
    suggestion: { bg: 235 },
    status: { bg: 235, fg: 250, runningFg: 229, contextFg: 245, contextWarnFg: 217, costFg: 187, modelFg: 109 },
    input: { bg: 236, bashBg: 237, fg: 252, bashFg: 179 },
    glyphs: { done: { glyph: "✓", color: 151 }, error: { glyph: "✗", color: 217 } },
    logoColor: 117,
    starColor: 220,
    shikiTheme: "dark-plus",
  },
  light: {
    name: "light",
    // OpenCode light palette (https://github.com/opencode-ai/opencode):
    // text #2a2a2a→235, muted #8a8a8a→245, primary/blue #3b7dd8→68,
    // secondary/purple #7b5bb6→97, accent/orange #d68c27→172, red #d1383d→167,
    // green #3d9a57→65, cyan #318795→66, yellow #b0851f→136,
    // selection #e5e5e6→253, border #d3d3d3→252, bg-secondary #f0f0f0→255.
    blocks: {
      user: { fg: 235, bg: 153, accent: 68, bold: 68 },
      assistant: { fg: 235, bg: 231, accent: 172, bold: 172 },
      reasoning: { fg: 245, bg: 231, accent: 136, bold: 136 },
      tool: { fg: 235, bg: 255, accent: 68, bold: 68 },
      error: { fg: 231, bg: 167, accent: 224, bold: 230 },
      inlineTool: { fg: 245, bg: 231, accent: 68, bold: 68 },
    },
    syntax: {
      heading: 97,
      code: 65,
      keyword: 97,
      string: 65,
      number: 172,
      comment: 245,
      type: 136,
      function: 68,
      operator: 66,
      punctuation: 235,
      property: 167,
    },
    canvas: { bg: 231, panelBg: 255 },
    overlay: { bg: 255, chromeBg: 252, selBg: 253, fg: 235, dimFg: 245, brightFg: 235 },
    suggestion: { bg: 255 },
    status: { bg: 253, fg: 238, runningFg: 28, contextFg: 240, contextWarnFg: 160, costFg: 28, modelFg: 31 },
    input: { bg: 254, bashBg: 255, fg: 235, bashFg: 172 },
    glyphs: { done: { glyph: "✓", color: 65 }, error: { glyph: "✗", color: 167 } },
    logoColor: 68,
    starColor: 172,
    shikiTheme: "light-plus",
  },
};

/**
 * Resolve a theme name to a TuiTheme. Falls back to the dark theme when the
 * name is not recognised.
 */
export function resolveTheme(name: string): TuiTheme {
  return BUILT_IN_THEMES[name] ?? BUILT_IN_THEMES.dark;
}
