import { z } from "zod";
import { defineTool, type Tool } from "./base.js";
import { clipboardClearTool, clipboardCopyTool, clipboardPasteTool } from "./clipboard.js";
import { listDirTool, readFileTool, writeFileTool } from "./files.js";
import { fetchUrlTool, webSearchTool } from "./search.js";
import { runCommandTool } from "./shell.js";
import * as sys from "./system.js";

export const thinkTool = defineTool({
  name: "think",
  description: "Scratchpad. Write your step-by-step reasoning or updated plan here before acting. Has no side effects.",
  shape: { thought: z.string() },
  run: () => "ok",
  readOnly: true,
});

/** System, file, shell and clipboard tools: no display needed. */
export const coreTools: Tool[] = [
  sys.systemInfoTool, sys.getEnvTool, sys.listProcessesTool, readFileTool, listDirTool, sys.findFilesTool,
  sys.searchInFilesTool, sys.clipboardGetTool, runCommandTool, writeFileTool, sys.editFileTool, sys.makeDirTool,
  sys.copyPathTool, sys.movePathTool, sys.clipboardSetTool, sys.openPathTool, sys.deletePathTool, sys.killProcessTool,
  clipboardClearTool,
];
export const webTools: Tool[] = [webSearchTool, fetchUrlTool];

/**
 * Everything that needs a display: mouse, keyboard, screen, windows, vision plugins, clipboard shortcuts.
 * @returns The desktop automation tools.
 */
export async function desktopTools(): Promise<Tool[]> {
  const [gui, win, vision] = await Promise.all([import("./gui.js"), import("./window.js"), import("./vision.js")]);
  return [...gui.guiTools, ...win.windowTools, ...vision.visionTools, clipboardCopyTool, clipboardPasteTool];
}
