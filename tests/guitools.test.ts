/** Every desktop tool through its tool wrapper, and the MCP server driving the real desktop under a permission policy. */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/mcpServer.js";
import { PermissionEngine } from "../src/policy/engine.js";
import { PolicySchema } from "../src/policy/schema.js";
import { callTool } from "../src/tools/base.js";
import * as gui from "../src/tools/gui.js";
import { windowFocus } from "../src/tools/window.js";
import { sleep } from "./helpers.js";
import { haveWm, haveXev, openWindow, startXev, stopAll } from "./x.js";

const text = (r: unknown): string => (r as { content: { text?: string; type: string }[] }).content.map((c) => c.text ?? `<${c.type}>`).join("");
const tools = Object.fromEntries(gui.guiTools.map((t) => [t.name, t]));

const resetInputs = async (kill: boolean): Promise<void> => {
  if (kill) stopAll();
  await gui.releaseHeldInputs();
  if (haveXev) {
    const n = await import("@nut-tree-fork/nut-js");
    await n.mouse.setPosition(new n.Point(640, 400));
  }
};

describe.skipIf(!haveXev)("every desktop tool, called as the AI would", () => {
  afterEach(() => resetInputs(true));
  it("mouse tools", async () => {
    const ev = await startXev();
    expect(await callTool(tools.move_mouse!, { x: 250, y: 250 })).toBe("moved to (250,250)");
    expect(await callTool(tools.mouse_position!, {})).toBe("(250,250)");
    expect(await callTool(tools.mouse_move_relative!, { dx: 10, dy: 10 })).toContain("(260,260)");
    expect(await callTool(tools.click!, { x: 260, y: 260, clicks: 2 })).toBe("clicked (260,260) left x2");
    expect(await callTool(tools.mouse_press!, { button: "right" })).toContain("right button pressed");
    expect(await callTool(tools.mouse_release!, { button: "right" })).toBe("right button released");
    expect(await callTool(tools.mouse_drag!, { from_x: 200, from_y: 200, to_x: 300, to_y: 300 })).toContain("dragged");
    expect(await callTool(tools.scroll!, { amount: -2 })).toBe("scrolled -2");
    expect(await callTool(tools.screen_size!, {})).toContain("screen 1280x800");
    await ev.settle();
    expect(ev.buttons("ButtonPress")).toEqual(expect.arrayContaining(["1", "3", "5"]));
    expect(ev.buttons("ButtonRelease")).toContain("3");
  });

  it("keyboard tools", async () => {
    const ev = await startXev();
    await callTool(tools.move_mouse!, { x: 250, y: 250 });
    expect(await callTool(tools.type_text!, { text: "ab", interval: 0.01 })).toBe("typed 2 chars");
    expect(await callTool(tools.press_key!, { keys: ["tab"] })).toBe("pressed tab");
    expect(await callTool(tools.key_down!, { keys: ["shift"] })).toContain("holding shift");
    expect(await callTool(tools.key_up!, {})).toBe("released all held keys");
    expect(await callTool(tools.list_keys!, {})).toContain("volume_up");
    await ev.settle();
    expect(ev.keys()).toEqual(["a", "b", "Tab", "Shift_L"]);
  });

  it("screen tools", async () => {
    expect(await callTool(tools.screen_color_at!, { x: 5, y: 5 })).toMatch(/^rgb\(/);
    expect(await callTool(tools.screen_highlight!, { x: 10, y: 10, width: 20, height: 20, duration_ms: 20 })).toContain("highlighted");
    expect(await callTool(tools.screenshot!, { x: 0, y: 0, width: 8, height: 8 })).toHaveLength(2);
  });
});

describe.skipIf(!haveWm)("MCP server + permission policy driving the real desktop", () => {
  let wins = 0;
  beforeAll(async () => {
    await openWindow("mcp-scope", { geometry: "30x4+100+100" });
    await openWindow("mcp-other", { geometry: "30x4+600+100" });
    wins = 2;
  });
  afterAll(() => stopAll());
  afterEach(() => resetInputs(false)); // keep the two windows alive between tests

  /**
   *
   * @param policy - Policy document.
   * @returns The resulting value.
   */
  async function client(policy: object): Promise<Client> {
    const engine = new PermissionEngine(PolicySchema.parse(policy), { activeWindowTitle: (await import("../src/tools/window.js")).activeWindowTitle });
    const server = await buildServer({ engine, gui: true });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    const c = new Client({ name: "t", version: "1" });
    await c.connect(a);
    return c;
  }

  it("screenshots come back as an MCP text + image pair", async () => {
    const c = await client({ default: "allow" });
    const r = await c.callTool({ name: "screenshot", arguments: { max_width: 200 } });
    const blocks = r.content as { type: string; mimeType?: string; text?: string }[];
    expect(blocks.map((b) => b.type)).toEqual(["text", "image"]);
    expect(blocks[1]?.mimeType).toBe("image/png");
    expect(blocks[0]?.text).toContain("screen 1280x800");
    await c.close();
  });

  it("input is only allowed while an allowed window is focused", async () => {
    expect(wins).toBe(2);
    const c = await client({ default: "allow", gui: { windows: ["^mcp-scope$"] } });
    await windowFocus({ title: "^mcp-scope$" });
    await sleep(200);
    expect(text(await c.callTool({ name: "click", arguments: { x: 300, y: 300 } }))).toContain("clicked");
    await windowFocus({ title: "^mcp-other$" });
    await sleep(200);
    const denied = await c.callTool({ name: "type_text", arguments: { text: "x" } });
    expect(denied.isError).toBe(true);
    expect(text(denied)).toBe('[permission denied] the active window "mcp-other" is not in the allowed windows');
    // window tools are scoped too: the AI cannot even focus a window outside the allow-list
    const blocked = await c.callTool({ name: "window_focus", arguments: { title: "^mcp-other$" } });
    expect(text(blocked)).toContain('window "mcp-other" is not in the allowed windows');
    expect(text(await c.callTool({ name: "window_focus", arguments: { title: "^mcp-scope$" } }))).toContain("focused");
    await c.close();
  });
});
