import { writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { describe, expect, it } from "vitest";
import { FLAG_OPTIONS, GROUPS, anyPermissionFlag, permissionHelp, policyFromFlags } from "../src/policy/flags.js";
import { PermissionEngine } from "../src/policy/engine.js";
import { PolicyError } from "../src/policy/load.js";
import { SENSITIVE_PATHS, preset } from "../src/policy/presets.js";
import { CAPABILITIES, type Capability } from "../src/policy/schema.js";
import { tmpDir } from "./helpers.js";

const parse = (argv: string[]): Record<string, unknown> => parseArgs({ args: argv, options: FLAG_OPTIONS }).values as Record<string, unknown>;
const policy = async (...argv: string[]) => (await policyFromFlags(parse(argv))).policy;
const allowed = (p: { capabilities: Partial<Record<Capability, string>> }, mode = "allow"): Capability[] => CAPABILITIES.filter((c) => p.capabilities[c] === mode);

describe("deny by default", () => {
  it("no flags: nothing is allowed", async () => {
    const r = await policyFromFlags(parse([]));
    expect(r).toMatchObject({ hasBase: false, granted: [] });
    expect(r.policy.name).toBe("locked");
    expect(r.policy.default).toBe("deny");
    expect(allowed(r.policy)).toEqual([]);
    const e = new PermissionEngine(r.policy);
    for (const tool of ["read_file", "run_command", "click", "screenshot", "window_list", "web_search", "system_info"]) expect(e.isVisible(tool), tool).toBe(false);
    expect(e.isVisible("permissions_describe")).toBe(true);
  });
});

describe("every group grants exactly its documented capabilities", () => {
  it.each(Object.keys(GROUPS))("--allow-%s", async (g) => {
    const p = await policy(`--allow-${g}`);
    expect(allowed(p).sort()).toEqual([...(GROUPS[g]?.caps ?? [])].sort());
    expect(p.name).toBe("flags");
  });
  it.each(Object.keys(GROUPS))("--ask-%s", async (g) => {
    expect(allowed(await policy(`--ask-${g}`), "ask").sort()).toEqual([...(GROUPS[g]?.caps ?? [])].sort());
  });
  it("--allow-all covers every capability", async () => {
    expect(allowed(await policy("--allow-all"))).toEqual([...CAPABILITIES]);
  });
  it("combining groups, and allow beats ask for the same feature", async () => {
    expect(allowed(await policy("--allow-mouse", "--allow-keyboard")).sort()).toEqual(["input.keyboard", "input.mouse"]);
    const p = await policy("--ask-all", "--allow-mouse");
    expect(p.capabilities["input.mouse"]).toBe("allow");
    expect(p.capabilities["fs.write"]).toBe("ask");
  });
});

describe("safety nets for flag-built policies", () => {
  it("deny credential paths and dangerous commands by default", async () => {
    const p = await policy("--allow-files", "--allow-shell");
    expect(p.paths.deny).toEqual(SENSITIVE_PATHS);
    expect(p.commands.blockDangerous).toBe(true);
  });
  it("each can be switched off explicitly", async () => {
    const p = await policy("--allow-files", "--allow-shell", "--allow-sensitive-paths", "--allow-dangerous-commands");
    expect(p.paths.deny).toEqual([]);
    expect(p.commands.blockDangerous).toBe(false);
  });
  it("a preset or policy file is trusted as written (no extra nets)", async () => {
    const p = await policy("--preset", "safe", "--allow-files");
    expect(p.paths.deny).toEqual([]);
    expect(p.name).toBe("safe");
  });
  it("locked with no grants adds nothing", async () => {
    expect((await policy()).paths.deny).toEqual([]);
  });
});

describe("layering on a base", () => {
  it("--preset + flags", async () => {
    const r = await policyFromFlags(parse(["--preset", "readonly", "--allow-mouse"]));
    expect(r.hasBase).toBe(true);
    expect(r.policy.name).toBe("readonly");
    expect(r.policy.capabilities["input.mouse"]).toBe("allow");
    expect(r.policy.capabilities["fs.read"]).toBe("allow");
    expect(r.policy.paths.deny).toEqual(preset("readonly").paths.deny); // not doubled
  });
  it("--config and --policy are the same thing; legacy --safe / --read-only are bases", async () => {
    const f = path.join(tmpDir(), "p.json");
    writeFileSync(f, '{"name":"mine","default":"deny","capabilities":{"fs.read":"allow"}}');
    for (const flag of ["--config", "--policy"]) {
      const p = await policy(flag, f, "--allow-clipboard");
      expect(p.name).toBe("mine");
      expect(p.capabilities["fs.read"]).toBe("allow");
      expect(p.capabilities["clipboard.write"]).toBe("allow");
    }
    expect((await policy("--safe")).name).toBe("safe");
    expect((await policy("--read-only", "--safe")).name).toBe("readonly");
    await expect(policy("--config", "/nonexistent/p.json")).rejects.toThrow(PolicyError);
    await expect(policy("--preset", "nope")).rejects.toThrow(/unknown preset/);
  });
});

describe("scoping flags", () => {
  it("map onto the policy and add to a base's own lists", async () => {
    const p = await policy(
      "--allow-all", "--allow-path", "~/work", "--deny-path", "~/work/secret", "--readonly-path", "~/work/docs",
      "--allow-command", "^git ", "--deny-command", "curl", "--allow-host", "example\\.com$", "--deny-host", "evil",
      "--allow-window", "^Notes", "--region", "0,0,800,600", "--region", " 10 , 20 , 30 , 40 ", "--block-key", "ctrl+alt+delete",
      "--block-text", "\\d{16}", "--max-type-chars", "100", "--rate-limit", "30", "--max-actions", "500",
      "--audit-file", "/tmp/a.log", "--audit-args", "--ask-fallback", "allow", "--allow-tool", "think", "--deny-tool", "delete_path",
    );
    expect(p.paths).toMatchObject({ allow: ["~/work"], readOnly: ["~/work/docs"] });
    expect(p.paths.deny).toEqual(["~/work/secret", ...SENSITIVE_PATHS]);
    expect(p.commands).toMatchObject({ allow: ["^git "], deny: ["curl"], blockDangerous: true });
    expect(p.network).toEqual({ allowHosts: ["example\\.com$"], denyHosts: ["evil"] });
    expect(p.gui).toMatchObject({ windows: ["^Notes"], blockedKeys: ["ctrl+alt+delete"], blockedText: ["\\d{16}"], maxTypeChars: 100 });
    expect(p.gui.regions).toEqual([{ x: 0, y: 0, width: 800, height: 600 }, { x: 10, y: 20, width: 30, height: 40 }]);
    expect(p.limits).toEqual({ maxActionsPerMinute: 30, maxTotalActions: 500 });
    expect(p.audit).toEqual({ file: "/tmp/a.log", logArgs: true });
    expect(p.askFallback).toBe("allow");
    expect(p.tools).toEqual({ think: "allow", delete_path: "deny" });
  });
  it("audit file alone, and audit-args alone", async () => {
    expect((await policy("--audit-file", "/x")).audit).toEqual({ file: "/x", logArgs: false });
    expect((await policy("--audit-args")).audit).toMatchObject({ logArgs: true });
  });
  it("rejects malformed values with a clear message", async () => {
    for (const [argv, re] of [
      [["--region", "1,2,3"], /--region must be x,y,width,height/], [["--region", "a,b,c,d"], /--region/], [["--region", "0,0,0,5"], /--region/],
      [["--rate-limit", "0"], /--rate-limit must be a positive integer/], [["--max-actions", "x"], /--max-actions/], [["--max-type-chars", "1.5"], /--max-type-chars/],
      [["--ask-fallback", "maybe"], /invalid permission flags: askFallback/],
    ] as [string[], RegExp][]) await expect(policy(...argv), argv.join(" ")).rejects.toThrow(re);
  });
});

describe("programmatic use (values not produced by parseArgs)", () => {
  it("missing keys mean nothing is set, and non-list values for list flags are ignored", async () => {
    const r = await policyFromFlags({});
    expect(r.policy.name).toBe("locked");
    expect(allowed(r.policy)).toEqual([]);
    const odd = await policyFromFlags({ "allow-mouse": true, "allow-path": "not-a-list", region: undefined });
    expect(odd.policy.paths.allow).toEqual([]);
    expect(odd.policy.capabilities["input.mouse"]).toBe("allow");
  });
});

describe("helpers", () => {
  it("anyPermissionFlag", () => {
    expect(anyPermissionFlag(parse([]))).toBe(false);
    expect(anyPermissionFlag(parse(["--allow-mouse"]))).toBe(true);
    expect(anyPermissionFlag(parse(["--deny-tool", "x"]))).toBe(true);
    expect(anyPermissionFlag(parse(["--rate-limit", "5"]))).toBe(true);
  });
  it("the help text lists every group and scope flag", () => {
    const h = permissionHelp();
    for (const g of Object.keys(GROUPS)) expect(h).toContain(`--allow-${g}`);
    for (const f of ["--allow-path", "--region", "--allow-window", "--block-key", "--rate-limit", "--audit-file", "--preset", "--config", "--allow-sensitive-paths", "--allow-dangerous-commands", "--ask-<group>"]) expect(h, f).toContain(f);
    expect(h).toContain("nothing is allowed unless you say so");
  });
});
