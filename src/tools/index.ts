import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { ToolDefinition } from "../provider";
import { formatSkillsForToolDescription } from "../skill";
import { formatAgentsForToolDescription } from "../agent";
import { registerTool, tools, type ToolDescriptor } from "./core";
import { readTool, writeTool, editTool } from "./files";
import { bashTool } from "./bash";
import { toolComposerTool } from "./tool-composer";
import { webFetchTool } from "./web-fetch";
import { webSearchTool } from "./web-search";
import { skillTool, setCurrentSkills, getCurrentSkills } from "./skill";
import {
  agentTool,
  getCurrentAgents,
  setCurrentAgents,
  setAgentRuntime,
  filterToolsForAgent,
} from "./agent";

const builtInTools: ToolDescriptor[] = [
  readTool,
  writeTool,
  editTool,
  bashTool,
  //toolComposerTool,
  webFetchTool,
  webSearchTool,
  skillTool,
  agentTool,
];

builtInTools.forEach(registerTool);

export * from "./core";
export { truncateToolOutputIfNeeded } from "./output";
export { setCurrentSkills };
export { setCurrentAgents, setAgentRuntime, filterToolsForAgent };

function makeAnthropicToolsFromCustomTools() {
  let transformedTools: Anthropic.Tool[] = [];
  for (let i = 0; i < tools.length; i++) {
    transformedTools.push({
      name: tools[i].name,
      description: tools[i].description,
      input_schema: z.toJSONSchema(tools[i].inputSchema) as Anthropic.Tool["input_schema"],
    });
  }
  return transformedTools;
}

export const toolsTransformedToAnthropicStyle: Anthropic.Tool[] = makeAnthropicToolsFromCustomTools();

/**
 * Augment a tool's description with dynamic listings (skills, agents).
 */
function augmentToolDescription(tool: ToolDescriptor): string {
  let description = tool.description;

  // Dynamically append skill listing to the skill tool
  if (tool.name === "skill" && getCurrentSkills().length > 0) {
    const listing = formatSkillsForToolDescription(getCurrentSkills());
    if (listing) {
      description = `${description}\n\nAvailable skills:\n${listing}`;
    }
  }

  // Dynamically append agent listing to the agent tool
  if (tool.name === "agent" && getCurrentAgents().length > 0) {
    const listing = formatAgentsForToolDescription(getCurrentAgents());
    if (listing) {
      description = `${description}\n\nAvailable agents:\n${listing}`;
    }
  }

  return description;
}

/**
 * Provider-agnostic tool definitions for a specific tool list.
 * Used by the provider abstraction layer so each provider can serialise
 * tools into its own API format.
 */
export function toProviderToolDefinitions(toolList: ToolDescriptor[]): ToolDefinition[] {
  return toolList.map((t) => ({
    name: t.name,
    description: augmentToolDescription(t),
    inputSchema: z.toJSONSchema(t.inputSchema) as Record<string, unknown>,
  }));
}

/** Provider-agnostic tool definitions for the main agent. */
export function getProviderToolDefinitions(): ToolDefinition[] {
  return toProviderToolDefinitions(tools);
}
