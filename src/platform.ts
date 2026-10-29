/** Detect the host operating system so the agent can pick the right commands. */
import { accessSync, constants, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export type OsName = "windows" | "macos" | "linux";

/**
 *
 * @returns The current operating system name.
 */
export function currentOs(): OsName {
  if (process.platform === "win32") return "windows";
  if (process.platform === "darwin") return "macos";
  return "linux";
}

/**
 * Locate an executable on PATH (honours PATHEXT on Windows). Returns undefined when absent.
 * @param name - Executable name to find on PATH.
 * @returns The executable path, or `undefined` when absent.
 */
export function which(name: string): string | undefined {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const exts = process.platform === "win32" ? ["", ...(process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")] : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const full = path.join(dir, name + ext);
      try {
        // eslint-disable-next-line security/detect-non-literal-fs-filename
        if (!statSync(full).isFile()) continue;
        if (process.platform !== "win32") accessSync(full, constants.X_OK);
        return full;
      } catch {
        /* not here */
      }
    }
  }
  return undefined;
}

/**
 * `~` / `~/x` everywhere; `~\x` too on Windows (on POSIX a backslash is an ordinary filename character).
 * @param p - User-supplied path.
 * @returns The path with a leading `~` expanded.
 */
export function expandUser(p: string): string {
  const home = p === "~" || p.startsWith("~/") || (process.platform === "win32" && p.startsWith("~\\"));
  return home ? os.homedir() + p.slice(1) : p;
}

/**
 * Absolute, normalised path for a user-supplied path (`~` expanded, relative anchored at the CWD).
 * @param p - User-supplied path.
 * @returns The absolute normalised path.
 */
export function resolveUserPath(p: string): string {
  return path.resolve(expandUser(p));
}

/**
 *
 * @returns The default shell for this platform.
 */
export function defaultShell(): string {
  if (currentOs() === "windows") return which("powershell") ? "powershell" : "cmd";
  return process.env.SHELL ?? "/bin/sh";
}

/**
 *
 * @returns The current user name.
 */
function username(): string {
  try {
    return os.userInfo().username;
  } catch {
    return process.env.USER ?? process.env.USERNAME ?? "unknown";
  }
}

/**
 *
 * @returns A human-readable platform description.
 */
export function describePlatform(): string {
  return (
    `OS: ${currentOs()} (${os.type()} ${os.release()})\n` +
    `Arch: ${os.machine()}\n` +
    `Shell: ${defaultShell()}\n` +
    `User: ${username()}\n` +
    `Home: ${os.homedir()}\n` +
    `CWD: ${process.cwd()}\n` +
    `Node: ${process.version}`
  );
}
