import { mkdir, readFile as fsReadFile, readdir, stat, writeFile as fsWriteFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { resolveUserPath } from "../platform.js";
import { defineTool, truncate } from "./base.js";

// eslint-disable-next-line security/detect-non-literal-fs-filename
const isFile = async (p: string): Promise<boolean> => (await stat(p).catch(() => undefined))?.isFile() === true;
// eslint-disable-next-line security/detect-non-literal-fs-filename
const isDir = async (p: string): Promise<boolean> => (await stat(p).catch(() => undefined))?.isDirectory() === true;

/**
 * Lines like Python's str.splitlines for \n, \r\n and \r (no phantom last line).
 * @param text - Text to process.
 * @returns The lines without a phantom trailing line.
 */
export function splitLines(text: string): string[] {
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 *
 * @param p - File path.
 * @param offset - Line offset to start reading from.
 * @param limit - Maximum lines to read.
 * @returns The requested file content.
 */
export async function readFile(p: string, offset = 0, limit = 2000): Promise<string> {
  const full = resolveUserPath(p);
  if (!(await isFile(full))) return `[error] not a file: ${full}`;
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const lines = splitLines(await fsReadFile(full, "utf8"));
  const chunk = lines.slice(offset, offset + limit);
  const body = chunk.map((line, i) => `${offset + i + 1}\t${line}`).join("\n");
  const more = offset + limit < lines.length ? `\n[${lines.length - offset - chunk.length} more lines]` : "";
  return truncate(body + more);
}

/**
 *
 * @param p - File path.
 * @param content - Content to write.
 * @returns A human-readable result.
 */
export async function writeFile(p: string, content: string): Promise<string> {
  const full = resolveUserPath(p);
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  await mkdir(path.dirname(full), { recursive: true });
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  await fsWriteFile(full, content, "utf8");
  return `wrote ${Array.from(content).length} chars to ${full}`;
}

/**
 *
 * @param p - File path.
 * @returns The directory entries.
 */
export async function listDir(p = "."): Promise<string> {
  const full = resolveUserPath(p);
  if (!(await isDir(full))) return `[error] not a directory: ${full}`;
  const rows: string[] = [];
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  for (const name of (await readdir(full)).sort()) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const st = await stat(path.join(full, name)).catch(() => undefined);
    const dir = st?.isDirectory() === true;
    rows.push(`${dir ? "dir " : "file"}\t${dir ? "" : (st?.size ?? "")}\t${name}`);
  }
  return truncate(rows.join("\n") || "[empty]");
}

export const readFileTool = defineTool({
  name: "read_file",
  description: "Read a text file with line numbers.",
  shape: {
    path: z.string(),
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().positive().default(2000),
  },
  run: ({ path: p, offset, limit }) => readFile(p, offset, limit),
  readOnly: true,
});

export const writeFileTool = defineTool({
  name: "write_file",
  description: "Create or overwrite a text file (parent folders are created).",
  shape: { path: z.string(), content: z.string() },
  run: ({ path: p, content }) => writeFile(p, content),
  risky: true,
  destructive: true,
});

export const listDirTool = defineTool({
  name: "list_dir",
  description: "List files and folders in a directory.",
  shape: { path: z.string().default(".") },
  run: ({ path: p }) => listDir(p),
  readOnly: true,
});
