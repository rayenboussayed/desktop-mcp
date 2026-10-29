/**
 * What every tool needs in order to run: the capabilities it exercises and the arguments the engine must scope.
 * A tool that is not listed here is REFUSED by the engine (fail closed); a test checks the two sets match.
 */
import type { Capability, RegionLike } from "./schema.js";

interface Point { x: number; y: number }

export interface Scope {
  reads?: string[];
  writes?: string[];
  deletes?: string[];
  command?: string;
  url?: string;
  points?: Point[];
  /** A screen region the tool captures or reads; `undefined` with `capture` means the whole screen. */
  region?: RegionLike;
  capture?: boolean;
  keys?: string[];
  text?: string;
}

export interface ToolMeta {
  caps: Capability[];
  /** Extracts the scoped arguments from the (already validated) tool input. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  scope?: (args: any) => Scope;
  /** Needs the active window to match `gui.windows` (input tools). */
  input?: boolean;
}

const p = (path?: string): string[] => (path === undefined ? [] : [path]);
const pt = (a: { x: number; y: number }): Point[] => [{ x: a.x, y: a.y }];
const region = (a: { x?: number; y?: number; width?: number; height?: number }): RegionLike | undefined =>
  a.x === undefined || a.y === undefined || a.width === undefined || a.height === undefined
    ? undefined
    : { x: a.x, y: a.y, width: a.width, height: a.height };

export const TOOL_META: Record<string, ToolMeta> = {
  // ---- system
  think: { caps: [] },
  system_info: { caps: ["system.info"] },
  get_env: { caps: ["env.read"] },
  list_processes: { caps: ["process.list"] },
  kill_process: { caps: ["process.kill"] },
  plugin_status: { caps: ["system.info"] },
  permissions_describe: { caps: [] }, // only reports the policy: always available, so the AI can learn its limits
  list_keys: { caps: ["system.info"] },
  // ---- shell and files
  run_command: { caps: ["shell.exec"], scope: (a) => ({ command: a.command, reads: p(a.cwd) }) },
  read_file: { caps: ["fs.read"], scope: (a) => ({ reads: p(a.path) }) },
  list_dir: { caps: ["fs.read"], scope: (a) => ({ reads: p(a.path) }) },
  find_files: { caps: ["fs.read"], scope: (a) => ({ reads: p(a.root) }) },
  search_in_files: { caps: ["fs.read"], scope: (a) => ({ reads: p(a.root) }) },
  write_file: { caps: ["fs.write"], scope: (a) => ({ writes: p(a.path) }) },
  edit_file: { caps: ["fs.read", "fs.write"], scope: (a) => ({ reads: p(a.path), writes: p(a.path) }) },
  make_dir: { caps: ["fs.write"], scope: (a) => ({ writes: p(a.path) }) },
  copy_path: { caps: ["fs.read", "fs.write"], scope: (a) => ({ reads: p(a.src), writes: p(a.dst) }) },
  move_path: { caps: ["fs.write", "fs.delete"], scope: (a) => ({ writes: p(a.dst), deletes: p(a.src) }) },
  delete_path: { caps: ["fs.delete"], scope: (a) => ({ deletes: p(a.path) }) },
  open_path: { caps: ["app.open"], scope: (a) => ({ reads: /^[a-z][a-z0-9+.-]*:\/\//i.test(a.target) ? [] : p(a.target) }) },
  // ---- web
  web_search: { caps: ["net.web"] },
  fetch_url: { caps: ["net.web"], scope: (a) => ({ url: a.url }) },
  // ---- clipboard
  clipboard_get: { caps: ["clipboard.read"] },
  clipboard_set: { caps: ["clipboard.write"], scope: (a) => ({ text: a.text }) },
  clipboard_clear: { caps: ["clipboard.write"] },
  clipboard_copy: { caps: ["input.keyboard", "clipboard.read"], input: true },
  clipboard_paste: { caps: ["input.keyboard", "clipboard.write"], input: true, scope: (a) => ({ text: a.text }) },
  // ---- mouse
  mouse_position: { caps: ["system.info"] },
  move_mouse: { caps: ["input.mouse"], input: true, scope: (a) => ({ points: pt(a) }) },
  mouse_move_relative: { caps: ["input.mouse"], input: true },
  click: { caps: ["input.mouse"], input: true, scope: (a) => ({ points: pt(a) }) },
  mouse_press: { caps: ["input.mouse"], input: true },
  mouse_release: { caps: ["input.mouse"], input: true },
  mouse_drag: {
    caps: ["input.mouse"], input: true,
    scope: (a) => ({ points: [{ x: a.from_x, y: a.from_y }, { x: a.to_x, y: a.to_y }] }),
  },
  scroll: { caps: ["input.mouse"], input: true },
  // ---- keyboard
  type_text: { caps: ["input.keyboard"], input: true, scope: (a) => ({ text: a.text }) },
  press_key: { caps: ["input.keyboard"], input: true, scope: (a) => ({ keys: a.keys }) },
  key_down: { caps: ["input.keyboard"], input: true, scope: (a) => ({ keys: a.keys }) },
  key_up: { caps: ["input.keyboard"], input: true },
  // ---- screen
  screen_size: { caps: ["system.info"] },
  screenshot: { caps: ["screen.capture"], scope: (a) => ({ region: region(a), capture: true }) },
  screenshot_save: { caps: ["screen.capture", "fs.write"], scope: (a) => ({ region: region(a), capture: true, writes: p(a.path) }) },
  screen_color_at: { caps: ["screen.read"], scope: (a) => ({ points: pt(a) }) },
  screen_highlight: { caps: ["screen.read"], scope: (a) => ({ region: region(a) }) },
  screen_find_image: { caps: ["screen.read"], scope: (a) => ({ reads: p(a.template), region: region(a), capture: true }) },
  screen_find_images: { caps: ["screen.read"], scope: (a) => ({ reads: p(a.template), region: region(a), capture: true }) },
  screen_wait_for_image: { caps: ["screen.read"], scope: (a) => ({ reads: p(a.template), region: region(a), capture: true }) },
  click_image: { caps: ["screen.read", "input.mouse"], input: true, scope: (a) => ({ reads: p(a.template), region: region(a), capture: true }) },
  screen_read_text: { caps: ["screen.read"], scope: (a) => ({ region: region(a), capture: true }) },
  screen_find_text: { caps: ["screen.read"], scope: (a) => ({ region: region(a), capture: true }) },
  screen_wait_for_text: { caps: ["screen.read"], scope: (a) => ({ region: region(a), capture: true }) },
  click_text: { caps: ["screen.read", "input.mouse"], input: true, scope: (a) => ({ region: region(a), capture: true }) },
  screen_find_color: { caps: ["screen.read"], scope: (a) => ({ region: region(a), capture: true }) },
  screen_record: { caps: ["screen.record", "fs.write"], scope: (a) => ({ region: region(a), capture: true, writes: p(a.out_dir) }) },
  // ---- windows
  window_list: { caps: ["window.list"] },
  window_active: { caps: ["window.list"] },
  window_wait_for: { caps: ["window.list"] },
  window_focus: { caps: ["window.control"] },
  window_move: { caps: ["window.control"] },
  window_resize: { caps: ["window.control"] },
  window_minimize: { caps: ["window.control"] },
  window_restore: { caps: ["window.control"] },
  window_close: { caps: ["window.control"] },
};
