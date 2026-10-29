/** The permission policy: what the AI may and may not control on this machine. */
import { z } from "zod";

/** Every sensitive thing a tool can do. Each tool declares the capabilities it needs (see capabilities.ts). */
export const CAPABILITIES = [
  "fs.read", "fs.write", "fs.delete", "shell.exec", "process.list", "process.kill", "system.info", "env.read",
  "net.web", "app.open", "clipboard.read", "clipboard.write",
  "screen.capture", "screen.read", "screen.record", "input.mouse", "input.keyboard",
  "window.list", "window.control",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

const MODES = ["allow", "ask", "deny"] as const;
export type Mode = (typeof MODES)[number];

const RegionSchema = z.object({
  x: z.number().int(), y: z.number().int(), width: z.number().int().positive(), height: z.number().int().positive(),
}).strict();
export type RegionLike = z.infer<typeof RegionSchema>;

const strings = () => z.array(z.string()).default([]);

export const PolicySchema = z.object({
  version: z.literal(1).default(1),
  name: z.string().default("custom"),
  /** Mode for any capability that is not listed in `capabilities`. */
  default: z.enum(MODES).default("deny"),
  capabilities: z.partialRecord(z.enum(CAPABILITIES), z.enum(MODES)).default({}),
  /** Per-tool override: beats the capability table, both ways (`deny` hides the tool entirely). */
  tools: z.record(z.string(), z.enum(MODES)).default({}),
  /** File-system scope, checked on the real (symlink-resolved) path. `~` is expanded. */
  paths: z.object({
    /** When non-empty, only paths under these may be touched. */
    allow: strings(),
    /** Never touched, whatever else allows it. */
    deny: strings(),
    /** Readable but never written, deleted or overwritten. */
    readOnly: strings(),
  }).prefault({}),
  /** Shell scope. Patterns are regular expressions (case-insensitive). */
  commands: z.object({
    /** When non-empty, a command must match at least one. */
    allow: strings(),
    deny: strings(),
    /** Also refuse the built-in dangerous patterns (rm -rf, sudo, mkfs, curl | sh, ...). */
    blockDangerous: z.boolean().default(false),
    /** With an allow-list, shell control operators (; | & ` $( > < newline) are refused unless this is true. */
    allowChaining: z.boolean().default(false),
  }).prefault({}),
  /** Hosts fetch_url may contact. Patterns are regular expressions matched against the host name. */
  network: z.object({ allowHosts: strings(), denyHosts: strings() }).prefault({}),
  /** Scope for mouse, keyboard, screen and window tools. */
  gui: z.object({
    /** When non-empty: clicks, moves, drags and captures must fall inside one of these screen regions. */
    regions: z.array(RegionSchema).default([]),
    /** When non-empty: input and window control only while the target window title matches one of these regexes. */
    windows: strings(),
    /** Hotkeys that are never pressed, e.g. "ctrl+alt+delete", "meta+l". Order-insensitive. */
    blockedKeys: strings(),
    /** Text patterns (regex) that may never be typed or pasted, e.g. a credit-card number. */
    blockedText: strings(),
    maxTypeChars: z.number().int().positive().optional(),
  }).prefault({}),
  limits: z.object({
    maxActionsPerMinute: z.number().int().positive().optional(),
    maxTotalActions: z.number().int().positive().optional(),
  }).prefault({}),
  audit: z.object({
    /** JSON-lines audit log. Every decision is recorded; typed text and file contents never are. */
    file: z.string().optional(),
    /** Also record argument values (paths, commands, coordinates). Off by default. */
    logArgs: z.boolean().default(false),
  }).prefault({}),
  /** What `ask` becomes when nobody can be asked (no elicitation support, no interactive terminal). */
  askFallback: z.enum(["allow", "deny"]).default("deny"),
}).strict();

export type Policy = z.infer<typeof PolicySchema>;
export type PolicyInput = z.input<typeof PolicySchema>;
