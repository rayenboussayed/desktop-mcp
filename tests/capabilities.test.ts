import { describe, expect, it } from "vitest";
import { TOOL_META } from "../src/policy/capabilities.js";
import { CAPABILITIES } from "../src/policy/schema.js";

const R = { x: 1, y: 2, width: 3, height: 4 };
const region = { x: 1, y: 2, width: 3, height: 4 };

/** tool -> [sample arguments, expected scope]. Pins what the permission engine is told about every call. */
const CASES: Record<string, [Record<string, unknown>, Record<string, unknown>]> = {
  run_command: [{ command: "ls", cwd: "/w" }, { command: "ls", reads: ["/w"] }],
  read_file: [{ path: "/a" }, { reads: ["/a"] }],
  list_dir: [{ path: "/a" }, { reads: ["/a"] }],
  find_files: [{ root: "/r" }, { reads: ["/r"] }],
  search_in_files: [{ root: "/r" }, { reads: ["/r"] }],
  write_file: [{ path: "/a" }, { writes: ["/a"] }],
  edit_file: [{ path: "/a" }, { reads: ["/a"], writes: ["/a"] }],
  make_dir: [{ path: "/a" }, { writes: ["/a"] }],
  copy_path: [{ src: "/s", dst: "/d" }, { reads: ["/s"], writes: ["/d"] }],
  move_path: [{ src: "/s", dst: "/d" }, { writes: ["/d"], deletes: ["/s"] }],
  delete_path: [{ path: "/a" }, { deletes: ["/a"] }],
  open_path: [{ target: "/a" }, { reads: ["/a"] }],
  fetch_url: [{ url: "https://x" }, { url: "https://x" }],
  clipboard_set: [{ text: "t" }, { text: "t" }],
  clipboard_paste: [{ text: "t" }, { text: "t" }],
  move_mouse: [{ x: 5, y: 6 }, { points: [{ x: 5, y: 6 }] }],
  click: [{ x: 5, y: 6 }, { points: [{ x: 5, y: 6 }] }],
  mouse_drag: [{ from_x: 1, from_y: 2, to_x: 3, to_y: 4 }, { points: [{ x: 1, y: 2 }, { x: 3, y: 4 }] }],
  type_text: [{ text: "t" }, { text: "t" }],
  press_key: [{ keys: ["a"] }, { keys: ["a"] }],
  key_down: [{ keys: ["a"] }, { keys: ["a"] }],
  screenshot: [R, { region, capture: true }],
  screenshot_save: [{ ...R, path: "/p" }, { region, capture: true, writes: ["/p"] }],
  screen_color_at: [{ x: 5, y: 6 }, { points: [{ x: 5, y: 6 }] }],
  screen_highlight: [R, { region }],
  screen_find_image: [{ ...R, template: "/t" }, { reads: ["/t"], region, capture: true }],
  screen_find_images: [{ ...R, template: "/t" }, { reads: ["/t"], region, capture: true }],
  screen_wait_for_image: [{ ...R, template: "/t" }, { reads: ["/t"], region, capture: true }],
  click_image: [{ ...R, template: "/t" }, { reads: ["/t"], region, capture: true }],
  screen_read_text: [R, { region, capture: true }],
  screen_find_text: [R, { region, capture: true }],
  screen_wait_for_text: [R, { region, capture: true }],
  click_text: [R, { region, capture: true }],
  screen_find_color: [R, { region, capture: true }],
  screen_record: [{ ...R, out_dir: "/o" }, { region, capture: true, writes: ["/o"] }],
};

describe("capability metadata", () => {
  it("pins the scope every tool reports to the permission engine", () => {
    for (const [tool, [args, expected]] of Object.entries(CASES)) {
      expect(TOOL_META[tool]?.scope?.(args), tool).toEqual(expected);
    }
    // every tool with a scope extractor is covered by a case
    const scoped = Object.entries(TOOL_META).filter(([, m]) => m.scope).map(([n]) => n).sort();
    expect(Object.keys(CASES).sort()).toEqual(scoped);
  });

  it("region arguments: absent or partial means 'whole screen', never a made-up rectangle", () => {
    const shot = TOOL_META.screenshot!.scope!;
    expect(shot({})).toEqual({ region: undefined, capture: true });
    expect(shot({ x: 1, y: 2 })).toEqual({ region: undefined, capture: true });
    expect(shot({ x: 1, y: 2, width: 3 })).toEqual({ region: undefined, capture: true });
    expect(shot({ x: 0, y: 0, width: 1, height: 1 }).region).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });

  it("open_path treats URLs as non-files and missing paths as no reads", () => {
    const open = TOOL_META.open_path!.scope!;
    for (const url of ["https://a.b", "http://x", "file:///etc/passwd", "ftp://h/f", "custom+scheme://x"]) expect(open({ target: url }), url).toEqual({ reads: [] });
    expect(open({ target: "C:\\dir" })).toEqual({ reads: ["C:\\dir"] }); // a Windows path is a file, not a URL
    expect(TOOL_META.run_command!.scope!({ command: "ls" })).toEqual({ command: "ls", reads: [] });
    expect(TOOL_META.read_file!.scope!({})).toEqual({ reads: [] });
  });

  it("every tool declares known capabilities; tools that act on input are marked", () => {
    for (const [name, meta] of Object.entries(TOOL_META)) {
      for (const c of meta.caps) expect(CAPABILITIES, name).toContain(c);
    }
    const inputTools = Object.entries(TOOL_META).filter(([, m]) => m.input).map(([n]) => n).sort();
    expect(inputTools).toEqual(["click", "click_image", "click_text", "clipboard_copy", "clipboard_paste", "key_down", "key_up", "mouse_drag", "mouse_move_relative", "mouse_press", "mouse_release", "move_mouse", "press_key", "scroll", "type_text"]);
    // everything that can send input needs an input capability
    for (const n of inputTools) expect(TOOL_META[n]!.caps.some((c) => c.startsWith("input.")), n).toBe(true);
  });
});
