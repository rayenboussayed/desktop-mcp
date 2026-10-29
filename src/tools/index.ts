import { type Tool } from "./base.js";
import { listDirTool, readFileTool, writeFileTool } from "./files.js";
import { desktopTools, thinkTool, webTools } from "./registry.js";
import { runCommandTool } from "./shell.js";

/**
 * The agent's toolset (the MCP server exposes the larger one: see mcpServer.ts).
 * @param gui - Whether to include GUI tools.
 * @param search - Whether to include web search tools.
 * @returns The agent toolset keyed by tool name.
 */
export async function buildToolset(gui = false, search = true): Promise<Map<string, Tool>> {
  const tools: Tool[] = [thinkTool, runCommandTool, readFileTool, writeFileTool, listDirTool];
  if (search) tools.push(...webTools);
  if (gui) tools.push(...(await desktopTools()));
  return new Map(tools.map((t) => [t.name, t]));
}

export type { Tool } from "./base.js";
