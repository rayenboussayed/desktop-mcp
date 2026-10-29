import { afterEach, describe, expect, it } from "vitest";
import * as cb from "../../src/tools/clipboard.js";
import * as gui from "../../src/tools/gui.js";
import * as sys from "../../src/tools/system.js";
import { callTool } from "../../src/tools/base.js";
import { hasBinary, isPosix, makeBin, sleep, tmpDir, withEnv, withPlatform } from "../helpers.js";
import { haveXev, startXev, stopAll } from "../x.js";

const haveClip = haveXev && hasBinary("xclip");
afterEach(async () => {
  stopAll();
  const n = await import("@nut-tree-fork/nut-js");
  if (haveXev) await n.mouse.setPosition(new n.Point(640, 400));
});

describe.skipIf(!haveClip)("clipboard shortcuts (real X clipboard, real key events)", () => {
  it("clipboard_clear empties the clipboard", async () => {
    await sys.clipboardSet("something");
    expect(await cb.clipboardClear()).toBe("clipboard cleared");
    expect(await sys.clipboardGet()).toBe("");
  });

  it("clipboard_paste sends the paste shortcut and restores the previous clipboard", async () => {
    const ev = await startXev();
    await gui.moveMouse(250, 250);
    await sys.clipboardSet("before");
    const seen = new Set<string>();
    let polling = true;
    const poll = (async () => { while (polling) { seen.add(await sys.clipboardGet()); await sleep(25); } })();
    expect(await cb.clipboardPaste("héllo → 世界")).toBe("pasted 10 chars");
    polling = false;
    await poll;
    await ev.settle();
    expect(seen.has("héllo → 世界")).toBe(true); // on the clipboard while Ctrl+V was sent
    expect(ev.keys()).toEqual(["Control_L", "v"]);
    expect(await sys.clipboardGet()).toBe("before");
  });

  it("restore=false leaves the pasted text on the clipboard", async () => {
    await startXev();
    await gui.moveMouse(250, 250);
    await sys.clipboardSet("before");
    await cb.clipboardPaste("kept", false);
    expect(await sys.clipboardGet()).toBe("kept");
  });

  it("uses the Command key on macOS", async () => {
    const ev = await startXev();
    await gui.moveMouse(250, 250);
    const shim = tmpDir(); // macOS clipboard commands, forwarded to xclip
    makeBin(shim, "pbpaste", "xclip -selection clipboard -o");
    makeBin(shim, "pbcopy", "xclip -selection clipboard");
    await withEnv({ PATH: `${shim}:${process.env.PATH}` }, () => withPlatform("darwin", () => cb.pasteText("x")));
    await ev.settle();
    expect(ev.keys()).toEqual(["Super_L", "v"]);
  });

  it("clipboard_copy returns what the focused application put on the clipboard", async () => {
    const ev = await startXev();
    await gui.moveMouse(250, 250);
    // stand-in for the application's copy handler: it answers the shortcut by setting the clipboard
    const app = sleep(100).then(() => sys.clipboardSet("selected text"));
    expect(await cb.clipboardCopy()).toBe("selected text");
    await app;
    await ev.settle();
    expect(ev.keys()).toEqual(["Control_L", "c"]);
  });

  it("clipboard_copy says so when nothing was selected", async () => {
    await startXev();
    await gui.moveMouse(250, 250);
    expect(await cb.clipboardCopy()).toBe("[nothing was selected]");
  });

  it("the tools validate arguments", async () => {
    await startXev();
    await gui.moveMouse(250, 250);
    expect(await callTool(cb.clipboardClearTool, {})).toBe("clipboard cleared");
    expect(await callTool(cb.clipboardPasteTool, { text: "t" })).toBe("pasted 1 chars");
    expect(await callTool(cb.clipboardCopyTool, {})).toBe("[nothing was selected]");
    await expect(callTool(cb.clipboardPasteTool, {})).rejects.toThrow();
    expect(cb.clipboardCopyTool.risky && cb.clipboardPasteTool.risky).toBe(true);
  });

  it("the fail-safe applies: nothing is pasted or copied while the pointer is in a corner", async () => {
    const n = await import("@nut-tree-fork/nut-js");
    await n.mouse.setPosition(new n.Point(0, 0));
    await expect(cb.clipboardPaste("x")).rejects.toThrow(/fail-safe/);
    await expect(cb.clipboardCopy()).rejects.toThrow(/fail-safe/);
  });
});

describe.skipIf(!isPosix)("clipboard failure modes", () => {
  it("clear reports a failing clipboard tool; paste explains the missing tool", async () => {
    const bad = tmpDir();
    makeBin(bad, "xclip", "echo nope >&2; exit 1");
    await withEnv({ PATH: bad }, async () => {
      expect(await cb.clipboardClear()).toBe("[error] nope");
      await expect(cb.pasteText("x")).rejects.toThrow(/cannot paste without a clipboard tool \(nope\)/);
    });
    await withEnv({ PATH: tmpDir() }, async () => {
      expect(await cb.clipboardClear()).toContain("no clipboard tool found");
    });
  });
});
