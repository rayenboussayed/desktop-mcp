import { readFile } from "node:fs/promises";
import { PermissionEngine, type EngineDeps } from "./engine.js";
import { PRESET_NAMES, preset, type PresetName } from "./presets.js";
import { PolicySchema, type Policy } from "./schema.js";

export class PolicyError extends Error {
  override name = "PolicyError";
}

/**
 * Parse and validate a policy document (JSON text).
 * @param text - JSON policy document.
 * @param origin - Origin label for error messages.
 * @returns The validated policy.
 */
export function parsePolicy(text: string, origin = "policy"): Policy {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new PolicyError(`${origin}: not valid JSON (${(e as Error).message})`);
  }
  const r = PolicySchema.safeParse(raw);
  if (!r.success) {
    const issues = r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new PolicyError(`${origin}: invalid policy: ${issues}`);
  }
  return r.data;
}

export interface PolicySource {
  /** Path of a JSON policy file. */
  file?: string;
  preset?: string;
  /** Legacy flags: --safe and --read-only. */
  safe?: boolean;
  readOnly?: boolean;
  /** `--deny-tool` / `--allow-tool` style quick overrides. */
  denyTools?: string[];
  allowTools?: string[];
}

/**
 * Resolve a policy from CLI-style options. Precedence: file > preset > legacy flags > `full`.
 * @param src - Policy source options.
 * @returns The resolved policy.
 */
export async function resolvePolicy(src: PolicySource = {}): Promise<Policy> {
  let base: Policy;
  if (src.file) {
    let text: string;
    try {
      text = await readFile(src.file, "utf8");
    } catch (e) {
      throw new PolicyError(`cannot read policy file ${src.file}: ${(e as Error).message}`);
    }
    base = parsePolicy(text, src.file);
  } else if (src.preset) {
    if (!(PRESET_NAMES as readonly string[]).includes(src.preset)) {
      throw new PolicyError(`unknown preset '${src.preset}' (choose: ${PRESET_NAMES.join(", ")})`);
    }
    base = preset(src.preset as PresetName);
  } else base = preset(src.readOnly ? "readonly" : src.safe ? "safe" : "full");
  const tools = { ...base.tools };
  for (const t of src.allowTools ?? []) tools[t] = "allow";
  for (const t of src.denyTools ?? []) tools[t] = "deny";
  return { ...base, tools };
}

/**
 *
 * @param src - Policy source options.
 * @param deps - Engine dependencies.
 * @returns The configured permission engine.
 */
export async function createEngine(src: PolicySource = {}, deps: EngineDeps = {}): Promise<PermissionEngine> {
  return new PermissionEngine(await resolvePolicy(src), deps);
}
