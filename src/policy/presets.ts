import type { Policy, PolicyInput } from "./schema.js";
import { PolicySchema } from "./schema.js";

/** Credentials and key material the AI should not touch unless you say so. */
export const SENSITIVE_PATHS = [
  "~/.ssh", "~/.aws", "~/.gnupg", "~/.config/gcloud", "~/.azure", "~/.kube", "~/.docker/config.json",
  "~/.netrc", "~/.npmrc", "~/.pypirc", "~/.git-credentials", "/etc/shadow", "/etc/sudoers", "/etc/ssh",
  "~/Library/Keychains", "~/AppData/Roaming/Microsoft/Credentials",
];

const READ: PolicyInput["capabilities"] = {
  "fs.read": "allow", "system.info": "allow", "env.read": "allow", "process.list": "allow", "net.web": "allow",
  "window.list": "allow", "screen.capture": "allow", "screen.read": "allow",
};

export const PRESET_NAMES = ["locked", "readonly", "standard", "desktop", "safe", "full"] as const;
export type PresetName = (typeof PRESET_NAMES)[number];

const raw: Record<PresetName, PolicyInput> = {
  /** Nothing may run. Useful as a base to build on with `tools`/`capabilities`. */
  locked: { name: "locked", default: "deny" },
  /** Look, never touch: read files, inspect the system, see the screen, search the web. */
  readonly: {
    name: "readonly", default: "deny", capabilities: READ,
    paths: { deny: SENSITIVE_PATHS }, commands: { blockDangerous: true },
  },
  /** Reads are free; anything that changes state, runs code, or drives the desktop asks first. */
  standard: {
    name: "standard", default: "ask",
    capabilities: { ...READ, "clipboard.read": "ask" },
    paths: { deny: SENSITIVE_PATHS }, commands: { blockDangerous: true },
  },
  /** Desktop automation without prompts; shell, files, deletion, process control still ask. */
  desktop: {
    name: "desktop", default: "ask",
    capabilities: {
      ...READ, "input.mouse": "allow", "input.keyboard": "allow", "window.control": "allow",
      "clipboard.read": "allow", "clipboard.write": "allow", "screen.record": "ask",
    },
    paths: { deny: SENSITIVE_PATHS }, commands: { blockDangerous: true },
  },
  /** Everything except destructive operations; dangerous shell patterns refused. */
  safe: {
    name: "safe", default: "allow",
    capabilities: { "fs.delete": "deny", "process.kill": "deny" },
    commands: { blockDangerous: true },
  },
  /** No restrictions. */
  full: { name: "full", default: "allow" },
};

/**
 *
 * @param name - Name to use.
 * @returns The named preset policy.
 */
export function preset(name: PresetName): Policy {
  // eslint-disable-next-line security/detect-object-injection
  return PolicySchema.parse(raw[name]);
}
