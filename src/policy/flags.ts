/**
 * Command-line permission flags, in the style of other MCP servers:
 *
 *   omcps --allow-all
 *   omcps --allow-mouse --allow-keyboard --allow-screen
 *   omcps --allow-files --allow-path ~/projects --ask-shell
 *
 * `--allow-<group>` grants a group of features, `--ask-<group>` makes each use require approval. With no base
 * (`--preset` / `--policy` / `--config`) and no flags, nothing is allowed.
 */
import type { ParseArgsConfig } from "node:util";
import { PolicyError, resolvePolicy } from "./load.js";
import { SENSITIVE_PATHS, preset } from "./presets.js";
import { CAPABILITIES, PolicySchema, type Capability, type Policy, type PolicyInput } from "./schema.js";

/** Feature groups: the unit of an `--allow-*` / `--ask-*` flag. */
export const GROUPS: Record<string, { caps: readonly Capability[]; doc: string }> = {
  all: { caps: CAPABILITIES, doc: "every feature below" },
  gui: { caps: ["input.mouse", "input.keyboard", "screen.capture", "screen.read", "window.list", "window.control", "clipboard.read", "clipboard.write"], doc: "desktop automation: mouse, keyboard, screen, windows, clipboard" },
  mouse: { caps: ["input.mouse"], doc: "move, click, drag and scroll the mouse" },
  keyboard: { caps: ["input.keyboard"], doc: "type text and press keys" },
  clipboard: { caps: ["clipboard.read", "clipboard.write"], doc: "read, write, copy and paste through the clipboard" },
  "clipboard-read": { caps: ["clipboard.read"], doc: "read the clipboard only" },
  screen: { caps: ["screen.capture", "screen.read"], doc: "screenshots, OCR, image and colour search" },
  record: { caps: ["screen.record"], doc: "record the screen" },
  windows: { caps: ["window.list", "window.control"], doc: "list, focus, move, resize, minimise and close windows" },
  "windows-list": { caps: ["window.list"], doc: "list and inspect windows only" },
  files: { caps: ["fs.read", "fs.write"], doc: "read and write files" },
  "files-read": { caps: ["fs.read"], doc: "read files only" },
  delete: { caps: ["fs.delete"], doc: "delete and move files" },
  shell: { caps: ["shell.exec"], doc: "run shell commands" },
  processes: { caps: ["process.list", "process.kill"], doc: "list and kill processes" },
  "processes-list": { caps: ["process.list"], doc: "list processes only" },
  system: { caps: ["system.info", "env.read"], doc: "system information and environment variables" },
  web: { caps: ["net.web"], doc: "web search and fetching URLs (the only features that use the network)" },
  open: { caps: ["app.open"], doc: "open files, folders and URLs with the default application" },
};

type Options = NonNullable<ParseArgsConfig["options"]>;

const SCOPES: Record<string, string> = {
  "allow-path": "limit file access to this folder (repeatable; ~ allowed)",
  "deny-path": "never touch this path (repeatable)",
  "readonly-path": "readable but never changed (repeatable)",
  "allow-command": "shell commands must match this regex (repeatable)",
  "deny-command": "refuse shell commands matching this regex (repeatable)",
  "allow-host": "fetch_url only to hosts matching this regex (repeatable)",
  "deny-host": "never fetch from hosts matching this regex (repeatable)",
  "allow-window": "mouse/keyboard/window control only while a window titled like this regex is focused (repeatable)",
  region: "confine clicks and captures to x,y,width,height (repeatable)",
  "block-key": "never press this combination, e.g. ctrl+alt+delete (repeatable)",
  "block-text": "never type text matching this regex (repeatable)",
  "allow-tool": "allow a single tool by name (repeatable)",
  "deny-tool": "hide and refuse a single tool by name (repeatable)",
};

export const FLAG_OPTIONS: Options = {
  preset: { type: "string" },
  policy: { type: "string" },
  config: { type: "string" },
  safe: { type: "boolean", default: false },
  "read-only": { type: "boolean", default: false },
  "allow-sensitive-paths": { type: "boolean", default: false },
  "allow-dangerous-commands": { type: "boolean", default: false },
  "max-type-chars": { type: "string" },
  "rate-limit": { type: "string" },
  "max-actions": { type: "string" },
  "audit-file": { type: "string" },
  "audit-args": { type: "boolean", default: false },
  "ask-fallback": { type: "string" },
  ...Object.fromEntries(Object.keys(GROUPS).flatMap((g) => [[`allow-${g}`, { type: "boolean", default: false }], [`ask-${g}`, { type: "boolean", default: false }]])),
  ...Object.fromEntries(Object.keys(SCOPES).map((k) => [k, { type: "string", multiple: true, default: [] }])),
};

export type FlagValues = Record<string, unknown>;

const list = (v: unknown): string[] => (Array.isArray(v) ? (v as string[]) : []);

/**
 *
 * @param v - Parsed flag values.
 * @param name - Flag name.
 * @returns The parsed integer, or `undefined` when absent.
 */
function integer(v: FlagValues, name: string): number | undefined {
  const raw = v[name];
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new PolicyError(`--${name} must be a positive integer`);
  return n;
}

/**
 * True when any permission flag was given (so a policy, not the built-in defaults, should decide).
 * @param v - Parsed flag values.
 * @returns Whether any permission flag was supplied.
 */
export function anyPermissionFlag(v: FlagValues): boolean {
  return Object.keys(FLAG_OPTIONS).some((k) => (Array.isArray(v[k]) ? (v[k] as unknown[]).length > 0 : v[k] !== undefined && v[k] !== false));
}

export interface FlagPolicy {
  policy: Policy;
  /** A preset / policy file / legacy flag supplied the base (otherwise the base is `locked`). */
  hasBase: boolean;
  /** Names of the groups granted with --allow-* or --ask-*. */
  granted: string[];
}

/**
 * Build the effective policy from parsed command-line values.
 * @param v - Parsed flag values.
 * @returns The effective flag policy.
 */
export async function policyFromFlags(v: FlagValues): Promise<FlagPolicy> {
  const file = (v.policy ?? v.config) as string | undefined;
  const hasBase = Boolean(file || v.preset || v.safe || v["read-only"]);
  const base = hasBase ? await resolvePolicy({ file, preset: v.preset as string | undefined, safe: v.safe as boolean, readOnly: v["read-only"] as boolean }) : preset("locked");
  const raw: PolicyInput = JSON.parse(JSON.stringify(base)) as PolicyInput;
  const caps = { ...base.capabilities };
  const granted: string[] = [];
  for (const mode of ["ask", "allow"] as const) {
    for (const g of Object.keys(GROUPS)) {
      if (v[`${mode}-${g}`] !== true) continue;
      granted.push(`${mode}-${g}`);
      for (const c of (GROUPS[g] as { caps: readonly Capability[] }).caps) caps[c] = mode;
    }
  }
  raw.capabilities = caps;
  if (!hasBase) raw.name = granted.length > 0 ? "flags" : "locked";

  const paths = { allow: [...(base.paths.allow), ...list(v["allow-path"])], deny: [...(base.paths.deny), ...list(v["deny-path"])], readOnly: [...(base.paths.readOnly), ...list(v["readonly-path"])] };
  const commands = { ...base.commands, allow: [...(base.commands.allow), ...list(v["allow-command"])], deny: [...(base.commands.deny), ...list(v["deny-command"])] };
  if (!hasBase && granted.length > 0) {
    // safety nets for flag-built policies; the policy file / preset author is trusted to have chosen their own
    if (v["allow-sensitive-paths"] !== true) paths.deny.push(...SENSITIVE_PATHS);
    if (v["allow-dangerous-commands"] !== true) commands.blockDangerous = true;
  }
  raw.paths = paths;
  raw.commands = commands;
  raw.network = { allowHosts: [...(base.network.allowHosts), ...list(v["allow-host"])], denyHosts: [...(base.network.denyHosts), ...list(v["deny-host"])] };

  const regions = list(v.region).map((r) => {
    const n = r.split(",").map((x) => Number(x.trim()));
    if (n.length !== 4 || n.some((x) => !Number.isInteger(x)) || (n[2] as number) < 1 || (n[3] as number) < 1) throw new PolicyError(`--region must be x,y,width,height (got ${JSON.stringify(r)})`);
    return { x: n[0] as number, y: n[1] as number, width: n[2] as number, height: n[3] as number };
  });
  raw.gui = {
    ...base.gui,
    regions: [...(base.gui.regions), ...regions],
    windows: [...(base.gui.windows), ...list(v["allow-window"])],
    blockedKeys: [...(base.gui.blockedKeys), ...list(v["block-key"])],
    blockedText: [...(base.gui.blockedText), ...list(v["block-text"])],
    ...(integer(v, "max-type-chars") === undefined ? {} : { maxTypeChars: integer(v, "max-type-chars") }),
  };
  raw.limits = { ...base.limits, ...(integer(v, "rate-limit") === undefined ? {} : { maxActionsPerMinute: integer(v, "rate-limit") }), ...(integer(v, "max-actions") === undefined ? {} : { maxTotalActions: integer(v, "max-actions") }) };
  if (v["audit-file"] !== undefined || v["audit-args"] === true) raw.audit = { ...base.audit, ...(v["audit-file"] === undefined ? {} : { file: v["audit-file"] as string }), ...(v["audit-args"] === true ? { logArgs: true } : {}) };
  if (v["ask-fallback"] !== undefined) raw.askFallback = v["ask-fallback"] as "allow" | "deny";
  const tools = { ...base.tools };
  for (const t of list(v["allow-tool"])) tools[t] = "allow";
  for (const t of list(v["deny-tool"])) tools[t] = "deny";
  raw.tools = tools;

  const parsed = PolicySchema.safeParse(raw);
  if (!parsed.success) throw new PolicyError(`invalid permission flags: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  return { policy: parsed.data, hasBase, granted };
}

/**
 * `--help` text for the permission flags.
 * @returns The permission-flag help text.
 */
export function permissionHelp(): string {
  const w = Math.max(...Object.keys(GROUPS).map((g) => g.length)) + 8;
  const groups = Object.entries(GROUPS).map(([g, { doc }]) => `  --allow-${g}`.padEnd(w + 4) + doc).join("\n");
  const scopes = Object.entries(SCOPES).map(([k, d]) => `  --${k} <v>`.padEnd(w + 4) + d).join("\n");
  return `Permissions (nothing is allowed unless you say so):
${groups}

  Every --allow-<group> also exists as --ask-<group>: each use then needs your approval
  (through MCP elicitation when the client supports it).

Scope what is allowed:
${scopes}
  --max-type-chars <n>   --rate-limit <n per minute>   --max-actions <n>
  --audit-file <path>    --audit-args    --ask-fallback allow|deny

Bases (flags are layered on top of them):
  --preset <name>        locked | readonly | standard | desktop | safe | full
  --config <file>        a JSON permission policy (alias: --policy)
  --safe / --read-only   shorthands for the safe / readonly presets

Safety nets for flag-only setups (opt out when you mean it):
  --allow-sensitive-paths     do not deny ~/.ssh, ~/.aws, ~/.gnupg, ... 
  --allow-dangerous-commands  do not refuse rm -rf, sudo, curl | sh, ...`;
}
