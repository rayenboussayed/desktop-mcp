/** Clipboard features beyond get/set: clear, copy-the-selection, paste-text (nut.js `clipboard` + keyboard). */
import { z } from "zod";
import { failsafe, nut, sleep } from "../nut/runtime.js";
import { shortcutModifier, tapKeys } from "../nut/keys.js";
import { defineTool } from "./base.js";
import { clipboardGet, clipboardSet } from "./system.js";

const failed = (s: string): boolean => s.startsWith("[error]");

/**
 * Put `text` on the clipboard, send the paste shortcut, then restore what was there before.
 * @param text - Text to process.
 * @param restore - Whether to restore the previous clipboard contents.
 */
export async function pasteText(text: string, restore = true): Promise<void> {
  const previous = restore ? await clipboardGet() : "[error]";
  const set = await clipboardSet(text);
  if (failed(set)) throw new Error(`cannot paste without a clipboard tool (${set.slice(8)}). Install xclip, xsel or wl-clipboard.`);
  await sleep(120);
  await tapKeys([shortcutModifier(), "v"]); // terminals usually need ctrl+shift+v: ask for that via press_key instead
  await sleep(250); // let the target application read the clipboard first
  if (!failed(previous)) {
    // xclip/Wayland return ownership asynchronously, under machine load more than once, so keep claiming it until the
    // restored value is readable or the deadline expires; never hand the selection back to the caller half-empty.
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && (await clipboardGet()) !== previous) await clipboardSet(previous);
    await clipboardSet(previous);
  }
}

/**
 *
 * @returns A human-readable result.
 */
export async function clipboardClear(): Promise<string> {
  const r = await clipboardSet("");
  return failed(r) ? r : "clipboard cleared";
}

/**
 * Press the copy shortcut in the focused window and return what ended up on the clipboard.
 * @returns A human-readable result.
 */
export async function clipboardCopy(): Promise<string> {
  const n = await nut();
  await failsafe(n);
  const marker = `osagent-${Date.now()}`;
  await clipboardSet(marker); // so we can tell "nothing was selected" from "selection equals old clipboard"
  await tapKeys([shortcutModifier(), "c"], 20, n);
  await sleep(200);
  let got = await clipboardGet();
  // Applications handle the copy shortcut asynchronously (large selections can take a while), so give them up to a
  // second more before deciding that nothing was selected.
  const deadline = Date.now() + 1000;
  while (got === marker && Date.now() < deadline) {
    await sleep(50);
    got = await clipboardGet();
  }
  return got === marker ? "[nothing was selected]" : got;
}

/**
 *
 * @param text - Text to process.
 * @param restore - Whether to restore the previous clipboard contents.
 * @returns A human-readable result.
 */
export async function clipboardPaste(text: string, restore = true): Promise<string> {
  const n = await nut();
  await failsafe(n);
  await pasteText(text, restore);
  return `pasted ${Array.from(text).length} chars`;
}

export const clipboardClearTool = defineTool({ name: "clipboard_clear", description: "Empty the system clipboard.", shape: {}, run: () => clipboardClear() });
export const clipboardCopyTool = defineTool({
  name: "clipboard_copy",
  description: "Press the copy shortcut in the focused window and return the copied text (what is selected).",
  shape: {}, run: () => clipboardCopy(), risky: true,
});
export const clipboardPasteTool = defineTool({
  name: "clipboard_paste",
  description: "Paste text into the focused window via the clipboard (fast, exact, works for any character). The previous clipboard is restored unless restore=false.",
  shape: { text: z.string(), restore: z.boolean().default(true) },
  run: ({ text, restore }) => clipboardPaste(text, restore), risky: true,
});
