/** Cross-platform system tools: processes, system info, clipboard, opening files, file management. */
import { spawn } from "node:child_process";
import { cp, copyFile, lstat, mkdir, readFile, readdir, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { execText } from "../exec.js";
import { currentOs, describePlatform, resolveUserPath, which } from "../platform.js";
import { defineTool, truncate } from "./base.js";

const SKIP_DIRS = new Set([".git", "node_modules", "__pycache__"]);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- system info
/**
 *
 * @returns The numeric result.
 */
async function cpuLoadPercent(): Promise<number> {
  const snap = (): { idle: number; total: number } =>
    os.cpus().reduce(
      (a, c) => {
        const t = c.times;
        return { idle: a.idle + t.idle, total: a.total + t.user + t.nice + t.sys + t.idle + t.irq };
      },
      { idle: 0, total: 0 },
    );
  const a = snap();
  await sleep(200);
  const b = snap();
  const total = b.total - a.total;
  return total > 0 ? Math.round((1 - (b.idle - a.idle) / total) * 1000) / 10 : 0;
}

/**
 * OS, CPU, memory, disk and uptime summary.
 * @returns A formatted system summary.
 */
export async function systemInfo(): Promise<string> {
  const lines = [describePlatform()];
  lines.push(`CPU cores: ${os.cpus().length} logical`);
  lines.push(`CPU load: ${await cpuLoadPercent()}%`);
  const total = os.totalmem();
  lines.push(`Memory: ${Math.floor((total - os.freemem()) / 2 ** 20)} MiB used of ${Math.floor(total / 2 ** 20)} MiB`);
  try {
    const fs = await statfs(resolveUserPath("~"));
    lines.push(`Disk (home): ${Math.floor((fs.bavail * fs.bsize) / 2 ** 30)} GiB free of ${Math.floor((fs.blocks * fs.bsize) / 2 ** 30)} GiB`);
  } catch {
    /* statfs unsupported or path missing */
  }
  lines.push(`Uptime: ${Math.floor(os.uptime() / 3600)} h`);
  return lines.join("\n");
}

/**
 * Read one environment variable, or list all variable names when name is omitted.
 * @param name - Environment variable name.
 * @returns The variable value, or a newline-separated list of names.
 */
export function getEnv(name?: string): string {
  // eslint-disable-next-line security/detect-object-injection
  if (name) return process.env[name] ?? "[not set]";
  return Object.keys(process.env).sort().join("\n");
}

// ------------------------------------------------------------------ processes
interface ProcRow {
  pid: number;
  name: string;
  memMiB: number;
  user: string;
  stat: string;
}

/**
 *
 * @returns The running processes.
 */
async function processTable(): Promise<ProcRow[]> {
  if (currentOs() === "windows") {
    const r = await execText(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command",
       "Get-Process | Select-Object Id,ProcessName,WorkingSet64 | ConvertTo-Json -Compress"],
      { timeoutMs: 20_000 },
    );
    if (r.error) throw r.error;
    const parsed = JSON.parse(r.stdout.trim() || "[]") as unknown;
    const list = (Array.isArray(parsed) ? parsed : [parsed]) as { Id: number; ProcessName: string; WorkingSet64: number }[];
    return list.map((p) => ({ pid: p.Id, name: p.ProcessName, memMiB: Math.floor(p.WorkingSet64 / 2 ** 20), user: "", stat: "" }));
  }
  const userCol = currentOs() === "linux" ? "user:32=" : "user=";
  const r = await execText("ps", ["-axo", `pid=,rss=,${userCol},stat=,comm=`], { timeoutMs: 20_000 });
  if (r.error) throw r.error;
  const rows: ProcRow[] = [];
  for (const line of r.stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    rows.push({
      pid: Number(m[1]),
      memMiB: Math.floor(Number(m[2]) / 1024),
      user: m[3] as string,
      stat: m[4] as string,
      name: path.basename(m[5] as string),
    });
  }
  return rows;
}

/**
 * List running processes (pid, name, memory MiB), busiest memory first.
 * @param nameFilter - Substring used to filter process names.
 * @param limit - Maximum number of results.
 * @returns A human-readable result.
 */
export async function listProcesses(nameFilter?: string, limit = 50): Promise<string> {
  const f = nameFilter?.toLowerCase();
  const rows = (await processTable())
    .filter((p) => !f || p.name.toLowerCase().includes(f))
    .sort((a, b) => b.memMiB - a.memMiB || b.pid - a.pid)
    .slice(0, limit);
  return truncate("pid\tname\tmemory\tuser\n" + rows.map((p) => `${p.pid}\t${p.name}\t${p.memMiB} MiB\t${p.user}`).join("\n"));
}

/**
 *
 * @param pid - Process ID.
 * @returns The process row, or `undefined` when absent.
 */
async function processInfo(pid: number): Promise<ProcRow | undefined> {
  return (await processTable()).find((p) => p.pid === pid);
}

/**
 * Terminate a process by PID (terminate, or kill when force=true).
 * @param pid - Process ID.
 * @param force - Whether to force the operation.
 * @returns A human-readable result.
 */
export async function killProcess(pid: number, force = false): Promise<string> {
  if (pid === process.pid) return "[refused] will not kill the MCP server itself";
  const info = await processInfo(pid);
  if (!info) return `[error] no such process ${pid}`;
  const verb = force ? "killed" : "terminated";
  try {
    process.kill(pid, force ? "SIGKILL" : "SIGTERM");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return `[error] no such process ${pid}`;
    if (code === "EPERM") return `[error] access denied for pid ${pid}`;
    throw e;
  }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const now = await processInfo(pid);
    // A dead process whose parent has not reaped it is a zombie: it is gone for our purposes.
    if (!now || now.stat.startsWith("Z")) return `${verb} ${pid} (${info.name})`;
    await sleep(100);
  }
  return `signalled ${pid} (${info.name}) but it is still running; retry with force=true`;
}

// ------------------------------------------------------------------ clipboard
type Argv = string[];
/**
 *
 * @returns The clipboard get/put commands available on this platform.
 */
function clipCmds(): { get?: Argv; put?: Argv } {
  const os_ = currentOs();
  if (os_ === "macos") return { get: ["pbpaste"], put: ["pbcopy"] };
  if (os_ === "windows") return { get: ["powershell", "-NoProfile", "-Command", "Get-Clipboard"], put: ["clip"] };
  const candidates: [Argv, Argv][] = [
    [["wl-paste", "-n"], ["wl-copy"]],
    [["xclip", "-selection", "clipboard", "-o"], ["xclip", "-selection", "clipboard"]],
    [["xsel", "-b", "-o"], ["xsel", "-b", "-i"]],
  ];
  for (const [get, put] of candidates) if (which(get[0] as string)) return { get, put };
  return {};
}

const NO_CLIP = "[error] no clipboard tool found (install wl-clipboard, xclip or xsel)";

/**
 * Read text from the system clipboard.
 * @returns A human-readable result.
 */
export async function clipboardGet(): Promise<string> {
  const { get } = clipCmds();
  if (!get) return NO_CLIP;
  const r = await execText(get[0] as string, get.slice(1), { timeoutMs: 10_000 });
  if (r.error) return `[error] ${r.error.message}`;
  return r.code === 0 ? truncate(r.stdout) : `[error] ${r.stderr.trim()}`;
}

/**
 * Put text on the system clipboard.
 * @param text - Text to place on the clipboard.
 * @returns A human-readable result.
 */
export async function clipboardSet(text: string): Promise<string> {
  const { put } = clipCmds();
  if (!put) return NO_CLIP;
  const r = await execText(put[0] as string, put.slice(1), { input: text, timeoutMs: 10_000 });
  if (r.error) return `[error] ${r.error.message}`;
  return r.code === 0 ? `copied ${Array.from(text).length} chars` : `[error] ${r.stderr.trim()}`;
}

// ------------------------------------------------------------- open / launch
/**
 * Open a file, folder or URL with the OS default application.
 * @param target - Target to open.
 * @returns A human-readable result.
 */
export function openPath(target: string): Promise<string> {
  const os_ = currentOs();
  const [cmd, args]: [string, string[]] =
    os_ === "windows" ? ["cmd", ["/c", "start", "", target]] : os_ === "macos" ? ["open", [target]] : ["xdg-open", [target]];
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.once("error", (e) => resolve(`[error] ${e.message}`));
    child.once("spawn", () => {
      child.unref();
      resolve(`opened ${target}`);
    });
  });
}

// ------------------------------------------------------------ file management
/**
 * fnmatch-style glob (* ? [seq] [!seq]) to RegExp.
 * @param pattern - Glob or pattern to match.
 * @returns The compiled regular expression.
 */
export function globToRegExp(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    // eslint-disable-next-line security/detect-object-injection
    const c = pattern[i] as string;
    if (c === "*") re += ".*";
    else if (c === "?") re += ".";
    else if (c === "[") {
      let j = i + 1;
      // eslint-disable-next-line security/detect-object-injection
      if (pattern[j] === "!" || pattern[j] === "^") j++;
      // eslint-disable-next-line security/detect-object-injection
      if (pattern[j] === "]") j++;
      // eslint-disable-next-line security/detect-object-injection
      while (j < pattern.length && pattern[j] !== "]") j++;
      if (j >= pattern.length) {
        re += "\\[";
      } else {
        let body = pattern.slice(i + 1, j).replace(/\\/g, "\\\\").replace(/\]/g, "\\]");
        if (body[0] === "!" || body[0] === "^") body = "^" + body.slice(1);
        re += `[${body}]`;
        i = j;
      }
    } else re += c.replace(/[.+^${}()|\\\]]/g, "\\$&");
  }
  // eslint-disable-next-line security/detect-non-literal-regexp
  return new RegExp(`^${re}$`, "s");
}

/**
 * Depth-first walk: files of a folder first, then its sub-folders; skips .git, node_modules.
 * @param root - Root directory to search.
 * @yields Each path produced by the walk.
 */
async function* walk(root: string): AsyncGenerator<string> {
  let entries;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name))); // byte order, like a plain sort
  const dirs: string[] = [];
  for (const e of entries) {
    const full = path.join(root, e.name);
    let isDir = e.isDirectory();
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    if (e.isSymbolicLink()) isDir = (await stat(full).catch(() => undefined))?.isDirectory() === true;
    if (isDir) {
      if (!SKIP_DIRS.has(e.name) && !e.isSymbolicLink()) dirs.push(full);
    } else yield full;
  }
  for (const d of dirs) yield* walk(d);
}

/**
 * Find files by glob pattern (e.g. '*.py') under a folder, recursively.
 * @param pattern - Glob or pattern to match.
 * @param root - Root directory to search.
 * @param maxResults - Maximum results to return.
 * @returns A human-readable result.
 */
export async function findFiles(pattern: string, root = ".", maxResults = 200): Promise<string> {
  const re = globToRegExp(pattern.toLowerCase());
  const hits: string[] = [];
  for await (const file of walk(resolveUserPath(root))) {
    if (re.test(path.basename(file).toLowerCase())) {
      hits.push(file);
      if (hits.length >= maxResults) return hits.join("\n") + `\n[stopped at ${maxResults} results]`;
    }
  }
  return hits.join("\n") || "[no matches]";
}

const MAX_SEARCH_FILE = 10 * 1024 * 1024;

/**
 * Search file contents for a literal string; returns path:line: text.
 * @param text - Literal text to search for.
 * @param root - Root directory to search.
 * @param glob - Glob used to filter file names.
 * @param maxResults - Maximum results to return.
 * @returns A human-readable result.
 */
export async function searchInFiles(text: string, root = ".", glob = "*", maxResults = 100): Promise<string> {
  const re = globToRegExp(glob);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const out: string[] = [];
  for await (const file of walk(resolveUserPath(root))) {
    if (!re.test(path.basename(file))) continue;
    let content: string;
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      if ((await stat(file)).size > MAX_SEARCH_FILE) continue;
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      content = decoder.decode(await readFile(file));
    } catch {
      continue; // unreadable or not UTF-8
    }
    const lines = content.split(/\r\n|\r|\n/);
    for (let n = 0; n < lines.length; n++) {
      // eslint-disable-next-line security/detect-object-injection
      if ((lines[n] as string).includes(text)) {
        // eslint-disable-next-line security/detect-object-injection
        out.push(`${file}:${n + 1}: ${(lines[n] as string).trim().slice(0, 200)}`);
        if (out.length >= maxResults) return out.join("\n") + `\n[stopped at ${maxResults} results]`;
      }
    }
  }
  return out.join("\n") || "[no matches]";
}

/**
 * Create a directory (and parents).
 * @param p - Path to operate on.
 * @returns A human-readable result.
 */
export async function makeDir(p: string): Promise<string> {
  const full = resolveUserPath(p);
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  await mkdir(full, { recursive: true });
  return `created ${full}`;
}

/**
 * Move or rename a file or folder.
 * @param src - Source path.
 * @param dst - Destination path.
 * @returns A human-readable result.
 */
export async function movePath(src: string, dst: string): Promise<string> {
  const s = resolveUserPath(src);
  const d = resolveUserPath(dst);
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await rename(s, d);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
    await cp(s, d, { recursive: true }); // different filesystem: copy, then remove
    await rm(s, { recursive: true, force: true });
  }
  return `moved ${s} -> ${d}`;
}

/**
 * Copy a file or folder.
 * @param src - Source path.
 * @param dst - Destination path.
 * @returns A human-readable result.
 */
export async function copyPath(src: string, dst: string): Promise<string> {
  const s = resolveUserPath(src);
  const d = resolveUserPath(dst);
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  if ((await stat(s)).isDirectory()) await cp(s, d, { recursive: true, force: true });
  else {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await mkdir(path.dirname(d), { recursive: true });
    await copyFile(s, d);
  }
  return `copied ${s} -> ${d}`;
}

/**
 * Delete a file, or a folder when recursive=true. Refuses filesystem roots and the home folder.
 * @param p - Path to operate on.
 * @param recursive - Whether to delete directories recursively.
 * @returns A human-readable result.
 */
export async function deletePath(p: string, recursive = false): Promise<string> {
  const full = resolveUserPath(p);
  const visible = full; // the path as the user sees it
  const protectedPaths = new Set([path.sep, os.homedir(), path.parse(visible).root]);
  if (protectedPaths.has(visible)) return `[refused] will not delete ${visible}`;
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const st = await lstat(full).catch(() => undefined);
  if (!st) return `[error] not found: ${visible}`;
  if (st.isDirectory()) {
    if (!recursive) return "[error] it is a directory; pass recursive=true";
    await rm(full, { recursive: true });
  } else await rm(full);
  return `deleted ${visible}`;
}

/**
 * Replace exact text in a file. Fails if `old` is missing, or ambiguous without replace_all.
 * @param p - Path to operate on.
 * @param old - Text to replace.
 * @param neu - Replacement text.
 * @param replaceAll - Whether to replace every occurrence.
 * @returns A human-readable result.
 */
export async function editFile(p: string, old: string, neu: string, replaceAll = false): Promise<string> {
  const full = resolveUserPath(p);
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  if (!(await stat(full).catch(() => undefined))?.isFile()) return `[error] not a file: ${full}`;
  if (old === "") return "[error] text to replace must not be empty";
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const data = await readFile(full, "utf8");
  const n = data.split(old).length - 1;
  if (n === 0) return "[error] text to replace was not found";
  if (n > 1 && !replaceAll) return `[error] text appears ${n} times; add context or pass replace_all=true`;
  const updated = replaceAll ? data.split(old).join(neu) : data.replace(old, () => neu);
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  await writeFile(full, updated, "utf8");
  return `replaced ${replaceAll ? n : 1} occurrence(s) in ${full}`;
}


// ------------------------------------------------------------------- tool table
export const systemInfoTool = defineTool({ name: "system_info", description: "OS, CPU, memory, disk and uptime summary.", shape: {}, run: () => systemInfo(), readOnly: true });
export const getEnvTool = defineTool({
  name: "get_env",
  description: "Read one environment variable, or list all variable names when name is omitted.",
  shape: { name: z.string().optional() }, run: ({ name }) => getEnv(name), readOnly: true,
});
export const listProcessesTool = defineTool({
  name: "list_processes",
  description: "List running processes (pid, name, memory MiB), busiest memory first.",
  shape: { name_filter: z.string().optional(), limit: z.number().int().default(50) },
  run: ({ name_filter, limit }) => listProcesses(name_filter, limit), readOnly: true,
});
export const findFilesTool = defineTool({
  name: "find_files",
  description: "Find files by glob pattern (e.g. '*.py') under a folder, recursively.",
  shape: { pattern: z.string(), root: z.string().default("."), max_results: z.number().int().default(200) },
  run: ({ pattern, root, max_results }) => findFiles(pattern, root, max_results), readOnly: true,
});
export const searchInFilesTool = defineTool({
  name: "search_in_files",
  description: "Search file contents for a literal string; returns path:line: text.",
  shape: { text: z.string(), root: z.string().default("."), glob: z.string().default("*"), max_results: z.number().int().default(100) },
  run: ({ text, root, glob, max_results }) => searchInFiles(text, root, glob, max_results), readOnly: true,
});
export const clipboardGetTool = defineTool({ name: "clipboard_get", description: "Read text from the system clipboard.", shape: {}, run: () => clipboardGet(), readOnly: true });
export const clipboardSetTool = defineTool({ name: "clipboard_set", description: "Put text on the system clipboard.", shape: { text: z.string() }, run: ({ text }) => clipboardSet(text) });
export const openPathTool = defineTool({ name: "open_path", description: "Open a file, folder or URL with the OS default application.", shape: { target: z.string() }, run: ({ target }) => openPath(target) });
export const makeDirTool = defineTool({ name: "make_dir", description: "Create a directory (and parents).", shape: { path: z.string() }, run: ({ path: p }) => makeDir(p) });
export const copyPathTool = defineTool({ name: "copy_path", description: "Copy a file or folder.", shape: { src: z.string(), dst: z.string() }, run: ({ src, dst }) => copyPath(src, dst) });
export const movePathTool = defineTool({ name: "move_path", description: "Move or rename a file or folder.", shape: { src: z.string(), dst: z.string() }, run: ({ src, dst }) => movePath(src, dst), destructive: true });
export const deletePathTool = defineTool({
  name: "delete_path",
  description: "Delete a file, or a folder when recursive=true. Refuses filesystem roots and the home folder.",
  shape: { path: z.string(), recursive: z.boolean().default(false) },
  run: ({ path: p, recursive }) => deletePath(p, recursive), destructive: true,
});
export const editFileTool = defineTool({
  name: "edit_file",
  description: "Replace exact text in a file. Fails if `old` is missing, or ambiguous without replace_all.",
  shape: { path: z.string(), old: z.string(), new: z.string(), replace_all: z.boolean().default(false) },
  run: ({ path: p, old, new: neu, replace_all }) => editFile(p, old, neu, replace_all), destructive: true,
});
export const killProcessTool = defineTool({
  name: "kill_process",
  description: "Terminate a process by PID (terminate, or kill when force=true).",
  shape: { pid: z.number().int(), force: z.boolean().default(false) },
  run: ({ pid, force }) => killProcess(pid, force), destructive: true,
});
