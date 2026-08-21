/**
 * Bridge MCP servers into Pace's tool system.
 *
 * Loads MCP config, connects to enabled servers, registers their tools
 * under prefixed names, and provides lifecycle management.
 */

import { z } from "zod";
import { loadMcpConfig, getEnabledServers, type McpConfig, type McpServerConfig } from "./mcp-config";
import { McpStdioTransport, McpHttpTransport } from "./mcp-transport";
import { McpClient, type McpTool } from "./mcp-client";
import { registerTool, unregisterTool, tools as toolRegistry, type ToolDescriptor, type ToolOutput } from "./tool";

// ── State ────────────────────────────────────────────────────────────────────

export type ConnectedMcpServer = {
  name: string;
  client: McpClient;
  tools: McpTool[];
  registeredToolNames: string[];
};

const connectedServers: ConnectedMcpServer[] = [];

// ── Connection ───────────────────────────────────────────────────────────────

export type McpConnectionError = { name: string; error: string };

export type InitMcpResult = {
  connected: ConnectedMcpServer[];
  errors: McpConnectionError[];
};

export async function initMcpServers(
  enabledOverrides?: Record<string, boolean>,
  signal?: AbortSignal,
): Promise<InitMcpResult> {
  const config = await loadMcpConfig();
  const enabled = getEnabledServers(config, enabledOverrides);

  const connected: ConnectedMcpServer[] = [];
  const errors: McpConnectionError[] = [];

  for (const { name } of enabled) {
    const error = await connectMcpServer(name, signal);
    if (error) {
      errors.push(error);
    } else {
      const server = connectedServers.find((s) => s.name === name);
      if (server) {
        connected.push(server);
      }
    }
  }

  return { connected, errors };
}

/**
 * Connect a single MCP server: initialize the client, discover its tools, and
 * register them under prefixed names. Idempotent — returns null if the server
 * is already connected, or an error object on failure.
 */
export async function connectMcpServer(name: string, signal?: AbortSignal): Promise<McpConnectionError | null> {
  if (connectedServers.some((s) => s.name === name)) {
    return null;
  }

  let config: McpConfig;
  try {
    config = await loadMcpConfig();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { name, error: `Failed to load MCP config: ${message}` };
  }
  const serverConfig = config[name];
  if (!serverConfig) {
    return { name, error: `No MCP server named "${name}" in config` };
  }

  try {
    const client = createClient(name, serverConfig);
    await client.initialize(signal);
    const toolList = await client.listTools(signal);
    const registeredNames = registerMcpTools(name, client, toolList);

    connectedServers.push({ name, client, tools: toolList, registeredToolNames: registeredNames });
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { name, error: message };
  }
}

/**
 * Disconnect a single MCP server: unregister its tools and close the client.
 * Idempotent — a no-op when the server is not connected.
 */
export async function disconnectMcpServer(name: string): Promise<void> {
  const index = connectedServers.findIndex((s) => s.name === name);
  if (index === -1) {
    return;
  }

  const [server] = connectedServers.splice(index, 1);
  for (const toolName of server.registeredToolNames) {
    unregisterTool(toolName);
  }

  try {
    await server.client.close();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[MCP] Error closing server "${name}": ${message}`);
  }
}

export type McpServerListing = {
  name: string;
  type: "local" | "remote";
  enabled: boolean;
  connected: boolean;
  toolCount: number;
};

/**
 * List all configured MCP servers with their effective enabled state and
 * current connection status, for the picker overlay. Returns an empty list
 * when the config file is missing or malformed.
 */
export async function listMcpServers(enabledOverrides?: Record<string, boolean>): Promise<McpServerListing[]> {
  let config: McpConfig;
  try {
    config = await loadMcpConfig();
  } catch {
    return [];
  }

  const connectedByName = new Map(connectedServers.map((s) => [s.name, s]));
  return Object.entries(config).map(([name, serverConfig]) => {
    const connected = connectedByName.get(name);
    return {
      name,
      type: serverConfig.type,
      enabled: enabledOverrides?.[name] ?? serverConfig.enabled !== false,
      connected: connected !== undefined,
      toolCount: connected?.tools.length ?? 0,
    };
  });
}

function createClient(name: string, config: McpServerConfig): McpClient {
  if (config.type === "local") {
    const transport = new McpStdioTransport(config.command, config.environment);
    return new McpClient(name, transport);
  }
  const transport = new McpHttpTransport(config.url, config.headers);
  return new McpClient(name, transport);
}

// ── Tool registration ────────────────────────────────────────────────────────

function registerMcpTools(serverName: string, client: McpClient, mcpTools: McpTool[]): string[] {
  const registered: string[] = [];

  for (const mcpTool of mcpTools) {
    const prefixedName = `mcp__${serverName}__${mcpTool.name}`;

    // Build a permissive schema from the MCP inputSchema if present,
    // otherwise accept any object.
    const schema = buildSchemaFromMcpInputSchema(mcpTool.inputSchema);

    const descriptor: ToolDescriptor = {
      name: prefixedName,
      description: mcpTool.description ?? `MCP tool "${mcpTool.name}" from server "${serverName}"`,
      inputSchema: schema,
      concurrency: "safe",
      titleFormatter: (input: unknown) => {
        // Prefer extracting the first string key as a summary
        if (input && typeof input === "object") {
          const obj = input as Record<string, unknown>;
          for (const key of Object.keys(obj)) {
            const val = obj[key];
            if (typeof val === "string") {
              return `${prefixedName}: ${val}`;
            }
          }
        }
        return prefixedName;
      },
      showContent: true,
      execute: async (input: unknown, signal?: AbortSignal): Promise<ToolOutput> => {
        const args = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
        const result = await client.callTool(mcpTool.name, args, signal);

        const content: ToolOutput["content"] = [];
        for (const block of result.content) {
          if (block.type === "text") {
            content.push({ type: "text", text: block.text });
          } else if (block.type === "image") {
            content.push({ type: "text", text: `[Image content (${block.mimeType ?? "unknown"})]` });
          } else if (block.type === "resource") {
            const resText = block.resource.text ?? `[Resource: ${block.resource.uri}]`;
            content.push({ type: "text", text: resText });
          }
        }

        return { content, is_error: result.isError };
      },
    };

    // Safety check: avoid duplicates (should not happen with prefixing)
    if (toolRegistry.some((t) => t.name === prefixedName)) {
      console.warn(`[MCP] Tool "${prefixedName}" already registered, skipping`);
      continue;
    }

    registerTool(descriptor as ToolDescriptor);
    registered.push(prefixedName);
  }

  return registered;
}

/**
 * Convert an MCP JSON Schema into a Zod object schema.
 *
 * If the schema is missing or malformed, falls back to z.record(z.any())
 * so the model can still attempt to call the tool.
 */
function buildSchemaFromMcpInputSchema(
  inputSchema?: Record<string, unknown>,
): z.ZodObject<z.core.$ZodShape> {
  if (!inputSchema || typeof inputSchema !== "object") {
    return z.object({}).passthrough();
  }

  try {
    // Attempt a lightweight conversion for common cases
    const properties = inputSchema.properties as Record<string, unknown> | undefined;
    const required = Array.isArray(inputSchema.required)
      ? (inputSchema.required as string[])
      : [];

    if (!properties || typeof properties !== "object") {
      return z.object({}).passthrough();
    }

    const shape: Record<string, z.ZodTypeAny> = {};

    for (const [key, propRaw] of Object.entries(properties)) {
      const prop = propRaw as Record<string, unknown>;
      const isRequired = required.includes(key);
      let field: z.ZodTypeAny = jsonSchemaPropToZod(prop, isRequired);

      if (!isRequired) {
        field = field.optional();
      }

      // Add description from the property schema for the model
      const description = typeof prop.description === "string" ? prop.description : undefined;
      if (description) {
        field = field.describe(description);
      }

      shape[key] = field;
    }

    return z.object(shape).passthrough();
  } catch {
    return z.object({}).passthrough();
  }
}

function jsonSchemaPropToZod(prop: Record<string, unknown>, required: boolean): z.ZodTypeAny {
  const type = prop.type;

  if (type === "string") {
    if (typeof prop.enum === "object" && Array.isArray(prop.enum)) {
      const values = prop.enum.filter((v): v is string => typeof v === "string");
      if (values.length > 0) {
        return z.enum(values as [string, ...string[]]);
      }
    }
    return z.string();
  }

  if (type === "number" || type === "integer") {
    return z.number();
  }

  if (type === "boolean") {
    return z.boolean();
  }

  if (type === "array" && typeof prop.items === "object" && prop.items !== null) {
    const itemSchema = jsonSchemaPropToZod(prop.items as Record<string, unknown>, true);
    return z.array(itemSchema);
  }

  if (type === "object" && typeof prop.properties === "object" && prop.properties !== null) {
    return buildSchemaFromMcpInputSchema(prop as Record<string, unknown>);
  }

  if (typeof prop.anyOf === "object" && Array.isArray(prop.anyOf)) {
    const variants = prop.anyOf
      .filter((v): v is Record<string, unknown> => typeof v === "object" && v !== null)
      .map((v) => jsonSchemaPropToZod(v, required));
    if (variants.length === 0) return z.any();
    if (variants.length === 1) return variants[0];
    return z.union(variants as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
  }

  if (typeof prop.oneOf === "object" && Array.isArray(prop.oneOf)) {
    const variants = prop.oneOf
      .filter((v): v is Record<string, unknown> => typeof v === "object" && v !== null)
      .map((v) => jsonSchemaPropToZod(v, required));
    if (variants.length === 0) return z.any();
    if (variants.length === 1) return variants[0];
    return z.union(variants as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
  }

  return z.any();
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

export async function shutdownMcpServers(): Promise<void> {
  for (const server of connectedServers) {
    try {
      await server.client.close();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[MCP] Error closing server "${server.name}": ${message}`);
    }
  }
  connectedServers.length = 0;
}

export function getConnectedMcpServers(): ConnectedMcpServer[] {
  return [...connectedServers];
}

export function formatMcpListing(): string {
  if (connectedServers.length === 0) {
    return "No MCP servers connected.";
  }

  const lines: string[] = [];
  for (const server of connectedServers) {
    lines.push(`## ${server.name}`);
    lines.push(`  ${server.tools.length} tool(s):`);
    for (const tool of server.tools) {
      lines.push(`    - mcp__${server.name}__${tool.name}`);
    }
  }
  return lines.join("\n");
}
