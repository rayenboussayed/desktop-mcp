import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach } from "vitest";

const dirs: string[] = [];
/**
 *
 * @returns A fresh temporary directory.
 */
export function tmpDir(): string {
  const d = mkdtempSync(path.join(os.tmpdir(), "osagent-test-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

/**
 * Create an executable shell script `name` in `dir`.
 * @param dir - Directory for the script.
 * @param name - Script file name.
 * @param body - Shell body to run.
 * @returns The executable script path.
 */
export function makeBin(dir: string, name: string, body: string): string {
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  chmodSync(p, 0o755);
  return p;
}

/**
 *
 * @param vars - Environment variables to set.
 * @param fn - Callback to invoke.
 * @returns The callback's return value.
 */
export function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  // eslint-disable-next-line security/detect-object-injection
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  const apply = (v: Record<string, string | undefined>): void => {
    for (const [k, val] of Object.entries(v)) {
      // eslint-disable-next-line security/detect-object-injection
      if (val === undefined) delete process.env[k];
      // eslint-disable-next-line security/detect-object-injection
      else process.env[k] = val;
    }
  };
  apply(vars);
  const restore = (): void => apply(saved);
  try {
    const r = fn();
    if (r instanceof Promise) return r.finally(restore) as T;
    restore();
    return r;
  } catch (e) {
    restore();
    throw e;
  }
}

/**
 *
 * @param platform - Platform value to simulate.
 * @param fn - Callback to invoke.
 * @returns The callback's return value.
 */
export function withPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
  const orig = Object.getOwnPropertyDescriptor(process, "platform") as PropertyDescriptor;
  Object.defineProperty(process, "platform", { value: platform });
  const restore = (): void => void Object.defineProperty(process, "platform", orig);
  try {
    const r = fn();
    if (r instanceof Promise) return r.finally(restore) as T;
    restore();
    return r;
  } catch (e) {
    restore();
    throw e;
  }
}

export const hasBinary = (name: string): boolean => spawnSync("sh", ["-c", `command -v ${name}`]).status === 0;
export const isPosix = process.platform !== "win32";

export interface Xvfb { display: string; stop: () => void }

/**
 * The run-wide private Xvfb started by tests/globalSetup.ts (already in this process's initial environment),
 * or undefined when Xvfb is not installed. Tests never start their own: see globalSetup for why.
 * @returns The started display, or `undefined` when Xvfb is unavailable.
 */
export async function startXvfb(): Promise<Xvfb | undefined> {
  const display = process.env.DISPLAY;
  return hasBinary("Xvfb") && display ? { display, stop: () => {} } : undefined;
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
