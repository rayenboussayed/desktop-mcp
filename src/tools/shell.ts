import { z } from "zod";
import { execText, signalCode } from "../exec.js";
import { currentOs, expandUser } from "../platform.js";
import { defineTool, truncate } from "./base.js";

/**
 * Run a command in the OS native shell and return exit code, stdout and stderr.
 * @param command - Command line to run.
 * @param timeout - Timeout in seconds.
 * @param cwd - Working directory for the command.
 * @returns A human-readable result.
 */
export async function runCommand(command: string, timeout = 60, cwd?: string): Promise<string> {
  let r;
  try {
    if (currentOs() === "windows") {
      r = await execText("powershell", ["-NoProfile", "-NonInteractive", "-Command", command], {
        cwd: cwd ? expandUser(cwd) : undefined,
        timeoutMs: timeout * 1000,
      });
    } else {
      r = await execText(command, [], { shell: true, cwd: cwd ? expandUser(cwd) : undefined, timeoutMs: timeout * 1000 });
    }
  } catch (e) {
    return `[error] ${(e as Error).message}`;
  }
  if (r.timedOut) return truncate(`[timeout after ${timeout}s]\n${r.stdout}`);
  if (r.error) return `[error] ${r.error.message}`;
  const code = r.code ?? signalCode(r.signal);
  return truncate(`exit_code: ${code}\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`);
}

export const runCommandTool = defineTool({
  name: "run_command",
  description:
    "Run a command in the host OS shell (bash/zsh on Linux and macOS, PowerShell on Windows). " +
    "Use it to inspect the system, install software, run programs and tests. Returns exit code, " +
    "stdout and stderr. Commands must be non-interactive.",
  shape: {
    command: z.string().describe("The command line to run."),
    timeout: z.number().int().default(60).describe("Seconds before the command is killed (default 60)."),
    cwd: z.string().optional().describe("Working directory (optional)."),
  },
  run: ({ command, timeout, cwd }) => runCommand(command, timeout, cwd),
  risky: true,
  destructive: true,
});
