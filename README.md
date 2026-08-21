# Pace

**A really nice terminal-based coding agent.**

![Screenshot of Pace in action](docs/screenshot-1.png)

![Screenshot of Pace in action](docs/screenshot-2.png)

## Quick start

```
npm install
npm run build
node apps/pace/dist/app.js
```

Set at least one API key:

```sh
export ANTHROPIC_API_KEY=sk-ant-...    # anthropic/* models
export OPENAI_API_KEY=sk-...           # openai/* models
export OPENCODE_ZEN_API_KEY=...        # opencode/* models via OpenCode Zen
export FIREWORKS_API_KEY=...           # fireworks/* models
```

## Features

- Interactive TUI
- Sessions
- Undo
- Bash, web search, web fetch, read, write, edit
- Paste image for vision models
- MCP
- Skills
- Subagents
- AGENTS.md
- Mouse support (scroll, select to copy)
- Slash commands
- Tables
- Token usage and cost in your currency
- Fast boot
- Table rendering

## Models

Switch models at any time with **Tab** or `/model <model-id>`. Model IDs use the full `provider/model` string. Models default to an unset variant, so Pace sends no explicit reasoning effort, thinking level, or similar provider-native options unless you select a variant. For models with variants, use **Ctrl+T** or `/variant <variant>` to cycle provider-native options such as OpenAI reasoning effort; the cycle includes the unset variant.

Pace ships with a curated built-in model catalog and also loads new models from [models.dev](https://models.dev) into the model picker. Built-in metadata and variants win for known models; fetched metadata adds models that Pace does not already know about.

| Built-in Model ID |
|---|
| `anthropic/claude-haiku-4-5` |
| `anthropic/claude-sonnet-4-6` |
| `anthropic/claude-opus-4-6` |
| `anthropic/claude-opus-4-7` |
| `anthropic/claude-opus-4-8` |
| `opencode/claude-haiku-4-5` |
| `opencode/claude-sonnet-4-6` |
| `opencode/claude-opus-4-6` |
| `opencode/claude-opus-4-7` |
| `opencode/claude-opus-4-8` |
| `opencode/claude-fable-5` |
| `opencode/kimi-k2.6` |
| `opencode/kimi-k2.7-code` |
| `opencode/kimi-k3` |
| `opencode/deepseek-v4-pro` |
| `opencode/deepseek-v4-flash` |
| `opencode/deepseek-v4-flash-free` |
| `opencode/glm-5.2` |
| `fireworks/kimi-k2.6` |
| `fireworks/kimi-k2.7-code` |
| `opencode/gpt-5.5` |
| `openai/gpt-5.5` |
| `lmstudio/google/gemma-4-12b` |

Model catalog environment variables:

| Variable | Description |
|---|---|
| `PACE_MODELS_URL` | Override the models.dev source URL. Defaults to `https://models.dev`. |
| `PACE_MODELS_PATH` | Read/write a specific catalog JSON file instead of the default cache path. |
| `PACE_DISABLE_MODELS_FETCH` | Set to `1`, `true`, or `yes` to disable network refreshes. |

## Keyboard shortcuts

| Key | Action |
|---|---|
| **Tab** / **Shift+Tab** | Cycle models forward / backward |
| **Ctrl+T** | Cycle the current model's variant, including unset |
| **Escape** | Cancel the running prompt |
| **Ctrl+V** | Paste image from clipboard |
| **Ctrl+C** | Clear input, or press twice to exit |
| **Shift+Enter** | Insert a newline |
| **`!command`** | Run a shell command directly (e.g. `!ls -la`) |

## Slash commands

| Command | What it does |
|---|---|
| `/new` | Start a fresh conversation |
| `/model <model-id>[:variant]` | Switch model (or list models without args) |
| `/variant [variant|unset]` | Show, switch, or unset the current model's variant |
| `/sessions` | List saved sessions for this project |
| `/resume <id>` | Resume a saved session |
| `/undo` | Rewind to before the last user message |
| `/skills` | List available skills |
| `/skill:<name>` | Run a skill |
| `/agents` | List available subagents |
| `/mcp` | List connected MCP servers and tools |
| `/mcps` | Enable or disable MCP servers (Ctrl+E) |

## File and image references

- **`@filename`** — mention a project file (autocomplete with Tab)
- **`@image(./path.png)`** — attach an image inline
- Bare image paths like `./screenshot.png` are also auto-detected

## Configuration

Pace reads global configuration from `~/.config/pace/config.json`.

Pace also reads a global instructions file from `~/.config/pace/AGENTS.md` and merges it into the system prompt alongside the project `AGENTS.md` in the current working directory. Global instructions apply in every project; project-specific instructions take precedence. Create the file to set preferences that should always apply, such as:

```
Always talk in ASD-STE100 Simplified Technical English.
Always talk to me like I have ADHD.
```

Choose the startup model and the models that **Tab** / **Shift+Tab** cycle through with full `provider/model` IDs. Omit `:variant` for the unset/default selection, or use `provider/model:variant` to select a provider-native variant explicitly:

```json
{
  "defaultModel": "opencode/gpt-5.5:medium",
  "cycleModels": [
    "opencode/gpt-5.5:medium",
    "opencode/gpt-5.5:high",
    "opencode/kimi-k2.6",
    "openai/gpt-5.5:xhigh"
  ],
  "sessionTitleModel": "opencode/deepseek-v4-flash:nothink"
}
```

Pace remembers the last explicit variant used for each model in memory, so cycling away from a model and back restores that model's previous variant during the current run. Use Ctrl+T until the model label has no `:variant`, or run `/variant unset`, to return to the provider default without sending explicit variant options.

Pace uses `sessionTitleModel` to auto-name new sessions after the first user message. Choose a cheap, fast text model; for models with thinking variants, prefer a no-thinking variant such as `opencode/deepseek-v4-flash:nothink`. If title generation fails, Pace falls back to showing a preview of the first user message.

To display estimated costs in a specific currency, configure a USD conversion rate, display format, and how many fraction digits:

```json
{
  "cost": {
    "conversionRate": 10,
    "format": "{amount} kr",
    "fractionDigits": 1
  }
}
```

If `fractionDigits` is omitted, Pace uses dynamic precision similar to the default USD display.

## Omarchy theme synchronization

Pace detects the active Omarchy theme background and uses its built-in dark or light theme. To update a running Pace session when Omarchy changes theme, install the included hook once from the Pace repository:

```sh
install -Dm755 scripts/omarchy-theme-set-pace-hook \
  "$HOME/.config/omarchy/hooks/theme-set.d/pace-theme"
```

The hook sends Pace `SIGUSR2` after Omarchy changes its theme. Pace then reads `~/.config/omarchy/current/theme/colors.toml` and updates without a restart. The hook does not modify Pace configuration.

Pace follows the Omarchy dark or light mode. It does not copy individual Omarchy accent colors. A manual `/theme dark` or `/theme light` selection remains active until the next Omarchy theme change.

## Subagents

Subagents are specialized helpers that run in their own isolated context window. The main agent delegates tasks to them with the `agent` tool. Each subagent returns only its final result, so exploration and tool noise stay out of the main conversation.

Pace ships with one built-in agent:

- `explore` — fast, read-only codebase exploration

Define your own agents as Markdown files with YAML frontmatter:

- Project: `.agents/agents/<name>.md`
- Global: `~/.agents/agents/<name>.md`

```markdown
---
name: reviewer
description: Reviews code changes for bugs, security issues, and missing tests
tools: read, bash
---
You are a code reviewer. Analyze the given changes and report:
- Bugs and edge cases
- Security concerns
- Missing tests

Do not modify any files.
```

Frontmatter fields:

| Field | Description |
|---|---|
| `name` | Must match the file name |
| `description` | Tells the main agent when to delegate. Be specific about trigger conditions |
| `tools` | Comma-separated allowlist. Omit for all tools |
| `model` | Optional model id, e.g. `opencode/claude-haiku-4-5`. Defaults to the current model |

Subagents cannot spawn subagents. Use `/agents` to list available agents.

## MCP servers

Configure external tool servers in `~/.config/pace/mcp.json`:

```json
{
  "filesystem": {
    "type": "local",
    "command": ["npx", "-y", "@modelcontextprotocol/server-filesystem", "~"],
    "enabled": true
  },
  "remote-api": {
    "type": "remote",
    "url": "https://example.com/mcp",
    "headers": { "Authorization": "Bearer <token>" },
    "enabled": true
  }
}
```

MCP tools show up as `mcp__<server>__<tool>` and the agent uses them automatically when relevant.

`mcp.json` is a stable, manually-authored config file — Pace never writes to it. To enable or disable servers at runtime, press **Ctrl+E** or run `/mcps` to open a picker with checkboxes (like the model picker): space toggles a server, and the change takes effect immediately (the server connects or disconnects and its tools appear or disappear). The enabled/disabled state is saved to `~/.config/pace/prefs.json` and wins over the `enabled` field in `mcp.json`.

## Project structure

Pace is an npm workspaces monorepo with three packages, layered so each package only depends on the one below it:

```
apps/pace       →  @pace/agent  →  @pace/llm
(TUI app)          (runtime)        (LLM SDK)
```

| Workspace | Package | Purpose |
|---|---|---|
| `packages/llm` | `@pace/llm` | Provider-agnostic LLM SDK: streaming requests, tool calls, model catalog |
| `packages/agent` | `@pace/agent` | Agent runtime: agent loop, sessions, tools, MCP, skills, subagents |
| `apps/pace` | `pace` | The terminal experience: input, rendering, slash commands |

### packages/llm — LLM SDK

| Module | Purpose |
|---|---|
| `src/provider.ts` | Neutral message, stream-event, tool-result, and `Provider` interface types |
| `src/providers/anthropic.ts` | Anthropic Messages API provider |
| `src/providers/openai.ts` | OpenAI Responses API provider |
| `src/providers/openai-compatible.ts` | Shared Chat Completions/responses implementation for OpenAI-compatible endpoints |
| `src/providers/{opencode-zen,fireworks,lmstudio}.ts` | Thin configurations of the shared OpenAI-compatible provider |
| `src/registry.ts` | `resolveProvider()` model-to-provider routing with lazy instantiation |
| `src/models.ts`, `src/model-catalog.ts` | Built-in model catalog plus remote refresh from models.dev |
| `src/events.ts`, `src/fetch-retry.ts` | Typed event bus and fetch retry/backoff |

### packages/agent — agent runtime

| Module | Purpose |
|---|---|
| `src/loop.ts` | `runAgentLoop()`: the event-driven stream → tool-call → stream cycle, shared by the main prompt and subagents |
| `src/session.ts` | Tree-shaped session entries, turn drafts, undo, JSON persistence |
| `src/tools/` | Tool registry and built-in tools (`bash`, `read`, `write`, `edit`, `web-fetch`, `web-search`, `skill`, `agent`) |
| `src/mcp-config.ts`, `src/mcp-transport.ts`, `src/mcp-client.ts`, `src/mcp-tools.ts` | Hand-rolled MCP client and tool bridging |
| `src/skill.ts`, `src/agent.ts`, `src/subagent.ts` | Skill discovery, subagent definitions, headless subagent execution |
| `src/preferences.ts`, `src/frontmatter.ts` | Runtime preference storage and YAML frontmatter parsing |

### apps/pace — terminal app

| Module | Purpose |
|---|---|
| `src/app.ts` | Entry point: startup, slash commands, system prompt assembly, loop-event → UI wiring |
| `src/tui.ts` | ANSI renderer: blocks, input editor, overlays, mouse support |
| `src/view-model.ts` | Render-block types and formatters shared by live view and session replay |
| `src/themes.ts`, `src/syntax.ts`, `src/terminal-utils.ts`, `src/clipboard.ts`, `src/git.ts`, `src/fuzzy.ts`, `src/reasoning.ts`, `src/session-view.ts` | Supporting UI modules |

## Development

Install and build all workspaces:

```sh
npm install
npm run build
```

Type check:

```
npm run lint
```

Run the test suite (mock-provider tests for the agent loop):

```sh
npm test
```

Start the app from source:

```sh
npm start
```
