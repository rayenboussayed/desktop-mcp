/** `npx omcps` from a packed tarball: the install path users will actually take. */
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";
import { tmpDir } from "../helpers.js";

// needs the npm registry to fetch the package's own dependencies
const registryUp = spawnSync("npm", ["view", "jimp", "version"], { encoding: "utf8", timeout: 60_000 }).status === 0;

describe.skipIf(!registryUp)("npx omcps", () => {
  const work = path.resolve("node_modules/.cache/omcps-npx-test");
  mkdirSync(work, { recursive: true });
  const cache = path.join(work, "npm-cache");
  const isPack = (f: string): boolean => /^desktop-mcp-\d+\.\d+\.\d+\.tgz$/.test(f);
  for (const f of readdirSync(work).filter(isPack)) rmSync(path.join(work, f), { force: true });
  // --ignore-scripts: `prepare` (husky) prints warnings in a non-git checkout and rewrites nothing we need; dist is
  // already built by pretest, so the tarball only has to be assembled.
  spawnSync("npm", ["pack", "--pack-destination", work, "--silent", "--ignore-scripts"], { encoding: "utf8", timeout: 120_000 });
  // stdout can carry lifecycle noise, so find the artifact on disk instead of parsing it.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const packed = readdirSync(work).filter(isPack).map((f) => ({ f, mtime: statSync(path.join(work, f)).mtimeMs })).sort((a, b) => a.mtime - b.mtime).pop();
  const tgz = path.join(work, packed?.f ?? "missing.tgz");
  const env = { ...process.env, npm_config_cache: cache, npm_config_update_notifier: "false", npm_config_fund: "false", npm_config_audit: "false" } as Record<string, string>;
  const npx = (args: string[]) => spawnSync("npx", ["--yes", `--package=${tgz}`, "desktop-mcp", ...args], { encoding: "utf8", env, timeout: 280_000, cwd: tmpDir() });

  it("is named omcps and exposes the omcps command", () => {
    expect(tgz).toMatch(/desktop-mcp-\d+\.\d+\.\d+\.tgz$/);
  });

  it("npx omcps --version / --help install the package and run it", () => {
    const v = npx(["--version"]);
    expect(v.status, v.stderr).toBe(0);
    expect(v.stdout).toMatch(/^desktop-mcp \d+\.\d+\.\d+ on OS: /);
    const h = npx(["--help"]);
    expect(h.stdout).toContain("npx desktop-mcp@latest --allow-all");
    expect(h.stdout).toContain("--allow-mouse");
  }, 290_000);

  it("is a working MCP server when launched exactly like an MCP client config would", async () => {
    // {"command":"npx","args":["omcps@latest","--allow-system"]}  (here pointed at the local tarball)
    const t = new StdioClientTransport({ command: "npx", args: ["--yes", `--package=${tgz}`, "desktop-mcp", "--allow-system", "--allow-files-read"], env, stderr: "pipe" });
    const stderr: string[] = [];
    t.stderr?.on("data", (d) => stderr.push(String(d)));
    const c = new Client({ name: "npx-client", version: "1" });
    await c.connect(t);
    const names = (await c.listTools()).tools.map((x) => x.name);
    expect(names).toContain("system_info");
    expect(names).toContain("read_file");
    expect(names).not.toContain("run_command");
    const r = await c.callTool({ name: "system_info", arguments: {} });
    expect(JSON.stringify(r)).toContain("CPU cores");
    await c.close();
    expect(stderr.join("")).toContain('permissions "flags"');
  }, 290_000);
});
