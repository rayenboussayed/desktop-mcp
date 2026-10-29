/** Key names, key presses, and the Linux typing plan (see the note on `keysForChar`). */
import { currentOs } from "../platform.js";
import { nut, type Nut } from "./runtime.js";

const NAMED_KEYS: Record<string, string> = {
  enter: "Return", return: "Return", esc: "Escape", escape: "Escape", tab: "Tab", space: "Space",
  backspace: "Backspace", delete: "Delete", del: "Delete", insert: "Insert", home: "Home", end: "End",
  pageup: "PageUp", pgup: "PageUp", pagedown: "PageDown", pgdn: "PageDown",
  up: "Up", down: "Down", left: "Left", right: "Right",
  ctrl: "LeftControl", control: "LeftControl", shift: "LeftShift", alt: "LeftAlt", option: "LeftAlt", opt: "LeftAlt",
  win: "LeftSuper", windows: "LeftSuper", super: "LeftSuper", meta: "LeftSuper", command: "LeftSuper", cmd: "LeftSuper",
  rctrl: "RightControl", rshift: "RightShift", ralt: "RightAlt", rmeta: "RightSuper", menu: "Menu",
  capslock: "CapsLock", numlock: "NumLock", scrolllock: "ScrollLock", pause: "Pause",
  printscreen: "Print", prtsc: "Print",
  "-": "Minus", "=": "Equal", ",": "Comma", ".": "Period", "/": "Slash", ";": "Semicolon", "'": "Quote",
  "[": "LeftBracket", "]": "RightBracket", "\\": "Backslash", "`": "Grave",
  // keypad
  kp_add: "Add", kp_subtract: "Subtract", kp_multiply: "Multiply", kp_divide: "Divide", kp_decimal: "Decimal",
  kp_enter: "Enter",
  // multimedia
  mute: "AudioMute", volume_up: "AudioVolUp", volume_down: "AudioVolDown", play: "AudioPlay", media_play: "AudioPlay",
  media_pause: "AudioPause", media_stop: "AudioStop", media_next: "AudioNext", media_prev: "AudioPrev",
  media_rewind: "AudioRewind", media_forward: "AudioForward",
};

/**
 * Map a key name ('enter', 'ctrl', 'c', 'f5', '7', 'volume_up', 'kp_5') to a nut.js `Key`.
 * @param n - Nut.js module.
 * @param name - Key name to resolve.
 * @returns The nut.js key code.
 */
export function keyFromName(n: Nut, name: string): number {
  const k = name.trim().toLowerCase();
  const table = n.Key as unknown as Record<string, number | undefined>;
  let member: string | undefined = NAMED_KEYS[k];
  if (!member && /^[a-z]$/.test(k)) member = k.toUpperCase();
  else if (!member && /^[0-9]$/.test(k)) member = `Num${k}`; // top-row digits (NumPadN is the keypad)
  else if (!member && /^kp_[0-9]$/.test(k)) member = `NumPad${k.slice(3)}`;
  else if (!member && /^f([1-9]|1\d|2[0-4])$/.test(k)) member = k.toUpperCase();
  const value = member === undefined ? undefined : table[member];
  if (value === undefined) throw new Error(`unknown key '${name}'`);
  return value;
}

/**
 * Every key name `keyFromName` accepts that exists in this nut.js build.
 * @param n - Nut.js module.
 * @returns Every supported key name.
 */
export function listKeyNames(n: Nut): string[] {
  const names = [
    ...Object.keys(NAMED_KEYS),
    ..."abcdefghijklmnopqrstuvwxyz0123456789".split(""),
    ...Array.from({ length: 10 }, (_, i) => `kp_${i}`),
    ...Array.from({ length: 24 }, (_, i) => `f${i + 1}`),
  ];
  return names.filter((k) => {
    try {
      keyFromName(n, k);
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * Typing on Linux. libnut's `typeString` is unreliable on X11, verified against a real xterm (what an application
 * actually receives): it types shifted punctuation as the unshifted key (`!` -> `1`), drops non-ASCII and some
 * ASCII characters outright, and can leave a key stuck down. So on Linux we never call `keyboard.type`:
 * every character is mapped to an explicit key (+ Shift) on a US layout and pressed/released one key at a time;
 * text that has no key (non-ASCII) is pasted through the clipboard. Windows/macOS use other native input paths
 * and are passed straight to nut.js.
 */
const SHIFTED: Record<string, string> = {
  "!": "1", "@": "2", "#": "3", $: "4", "%": "5", "^": "6", "&": "7", "*": "8", "(": "9", ")": "0",
  _: "-", "+": "=", "{": "[", "}": "]", "|": "\\", ":": ";", '"': "'", "<": ",", ">": ".", "?": "/", "~": "`",
};

/**
 * Key name (as accepted by `keyFromName`) and whether Shift is needed, for one ASCII character.
 * @param ch - ASCII character to map.
 * @returns The key and Shift requirement, or `undefined` when unsupported.
 */
export function keysForChar(ch: string): { key: string; shift: boolean } | undefined {
  if (ch === "\n") return { key: "enter", shift: false };
  if (ch === "\t") return { key: "tab", shift: false };
  if (ch === " ") return { key: "space", shift: false };
  if (/^[a-z0-9]$/.test(ch) || "-=[]\\;',./`".includes(ch)) return { key: ch, shift: false };
  if (/^[A-Z]$/.test(ch)) return { key: ch.toLowerCase(), shift: true };
  const base = SHIFTED[ch];
  return base === undefined ? undefined : { key: base, shift: true };
}

export type Segment = { kind: "keys" | "paste"; text: string };

/**
 * Split text into runs typed key by key and runs (non-ASCII / control characters) that must be pasted.
 * @param text - Text to process.
 * @returns Typing and paste segments.
 */
export function segmentForLinux(text: string): Segment[] {
  const out: Segment[] = [];
  for (const ch of text.replace(/\r\n?/g, "\n")) {
    const kind: Segment["kind"] = keysForChar(ch) ? "keys" : "paste";
    const last = out[out.length - 1];
    if (last?.kind === kind) last.text += ch;
    else out.push({ kind, text: ch });
  }
  return out;
}

/**
 * Press keys in order, then release them in reverse order, one key per native call (so a failure can never leave
 * a modifier stuck: everything pressed is released in `finally`).
 * @param keys - Key names to use.
 * @param delayMs - Delay between key events in milliseconds.
 * @param nutModule - Nut.js module to use.
 */
export async function tapKeys(keys: string[], delayMs = 20, nutModule?: Nut): Promise<void> {
  const n = nutModule ?? (await nut());
  const codes = keys.map((k) => keyFromName(n, k));
  n.keyboard.config.autoDelayMs = delayMs;
  const down: number[] = [];
  try {
    for (const c of codes) {
      await n.keyboard.pressKey(c);
      down.push(c);
    }
  } finally {
    for (const c of down.reverse()) await n.keyboard.releaseKey(c);
  }
}

/**
 * The modifier that means "command" for copy/paste shortcuts on this OS.
 * @returns The platform's shortcut modifier key name.
 */
export const shortcutModifier = (): string => (currentOs() === "macos" ? "meta" : "ctrl");
