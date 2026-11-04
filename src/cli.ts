import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { Command, CommanderError } from "commander";
import { z } from "zod";
import { Agent, DEFAULT_MODEL, type AgentOptions, type Args } from "./agent.js";
import { describePlatform } from "./platform.js";
import { PermissionEngine } from "./policy/engine.js";
import { addPermissionOptions, anyPermissionFlag, permissionHelp, policyFromFlags, toKebabOptions, type FlagValues } from "./policy/flags.js";
import { PolicyError } from "./policy/load.js";

export interface Runnable {
  run(task: string): Promise<string>;
}

export interface CliIo {
  out: (s: string) => void;
  prompt: (q: string) => Promise<string | null>;
  createAgent: (opts: AgentOptions) => Runnable;
  input?: Readable;
  output?: Writable;
}

/**
 *
 * @param input
 * @param output
 */
/**
 *
 * @param input - Readable input stream.
 * @param output - Writable output stream.
 * @returns A line reader with `ask` and `close`.
 */
export function makeLineReader(input: Readable = process.stdin, output: Writable = process.stdout): { ask: (q: string) => Promise<string | null>; close: () => void } {
  const rl = createInterface({ input, output, terminal: (input as { isTTY?: boolean }).isTTY === true });
  const lines: string[] = [];
  const waiters: ((s: string | null) => void)[] = [];
  let closed = false;
  rl.on("line", (l) => (waiters.shift() ?? ((s) => lines.push(s as string)))(l));
  rl.on("close", () => {
    closed = true;
    while (waiters.length) waiters.shift()?.(null);
  });
  return {
    ask: (q) => {
      output.write(q);
      if (lines.length) return Promise.resolve(lines.shift() as string);
      if (closed) return Promise.resolve(null);
      return new Promise((r) => waiters.push(r));
    },
    close: () => rl.close(),
  };
}

/**
 *
 * @param kind
 * @param data
 * @param out
 */
/**
 *
 * @param kind - Event kind.
 * @param data - Event payload to display.
 * @param out - Output writer.
 */
export function show(kind: string, data: unknown, out: (s: string) => void = console.log): void {
  if (kind === "text") out(`\n${data as string}`);
  else if (kind === "tool_call") {
    const [name, args] = data as [string, Args];
    const shown = args.thought ?? args.command ?? JSON.stringify(args);
    out(`\n> ${name}: ${shown as string}`);
  } else if (kind === "tool_result") {
    const [name, res] = data as [string, unknown];
    if (typeof res === "string" && name !== "think") out("  " + res.slice(0, 600).replace(/\n/g, "\n  "));
  }
}

const HELP = `osagent - AI agent that controls your OS

Usage: osagent [options] [task...]
  (no task)       interactive mode
  --model <id>    model (default ${DEFAULT_MODEL})
  --gui           enable screenshot/mouse/keyboard control (nut.js)
  --no-search     disable web search
  --confirm-all   ask before every state-changing action
  --max-steps <n> step cap (default 40)
  --policy-show   print effective permissions and exit

Without any permission flag the agent uses its built-in prompts for dangerous commands. With one, the
permission engine decides what the agent may do (see below).

${permissionHelp()}
  --info          print detected platform and exit
  -h, --help      this help`;

const MaxStepsSchema = z.coerce.number().int().positive();

/**
 *
 * @param argv
 * @param io
 */
/**
 *
 * @param argv - Command-line arguments.
 * @param io - I/O overrides.
 * @returns The process exit code.
 */
export async function main(argv: string[] = process.argv.slice(2), io?: Partial<CliIo>): Promise<number> {
  const out = io?.out ?? console.log;
  if (argv.includes("--help") || argv.includes("-h")) {
    out(HELP);
    return 0;
  }
  const program = new Command();
  program.exitOverride();
  program.name("osagent");
  program.usage("[options] [task...]");
  program.option("--model <id>", "model", "llama3.2");
  program.option("--gui", "enable screenshot/mouse/keyboard control", false);
  program.option("--no-search", "disable web search");
  program.option("--confirm-all", "ask before every state-changing action", false);
  program.option("--max-steps <n>", "step cap", "40");
  program.option("--info", "print detected platform", false);
  program.option("--policy-show", "print effective permissions and exit", false);
  program.helpOption("-h, --help", "show help");
  addPermissionOptions(program);
  program.argument("[task...]", "task");
  program.configureOutput({ writeErr: (s) => console.error(s.trimEnd()) });

  let parsed: Record<string, unknown>;
  let positionals: string[];
  try {
    program.parse(argv, { from: "user" });
    const raw = program.opts<Record<string, unknown>>();
    parsed = toKebabOptions(raw);
    positionals = program.args;
  } catch (e) {
    if (e instanceof CommanderError) {
      if (e.code === "commander.helpDisplayed") return 0;
      return 2;
    }
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`osagent: ${msg}`);
    return 2;
  }

  if (parsed.info === true) {
    out(describePlatform());
    return 0;
  }
  const maxStepsRaw = parsed["max-steps"];
  let maxSteps: number;
  try {
    maxSteps = MaxStepsSchema.parse(maxStepsRaw ?? "40");
  } catch {
    console.error("osagent: --max-steps must be a positive integer");
    return 2;
  }
  let engine: PermissionEngine | undefined;
  if (anyPermissionFlag(parsed as FlagValues) || parsed["policy-show"] === true) {
    try {
      engine = new PermissionEngine((await policyFromFlags(parsed as FlagValues)).policy);
    } catch (e) {
      console.error(`osagent: ${e instanceof PolicyError ? e.message : (e instanceof Error ? e.message : String(e))}`);
      return 2;
    }
    if (parsed["policy-show"] === true) {
      const { buildToolset } = await import("./tools/index.js");
      const e = engine;
      out(e.describe([...(await buildToolset(parsed.gui === true, parsed.search !== false)).values()].filter((t) => e.isVisible(t.name))));
      return 0;
    }
  }
  const reader = io?.prompt ? undefined : makeLineReader(io?.input, io?.output);
  const prompt = io?.prompt ?? reader!.ask;
  try {
    const ask = async (name: string, args: Args): Promise<boolean> => {
      out(`\n[approval needed] ${name}: ${JSON.stringify(args)}`);
      return ["y", "yes"].includes(((await prompt("Allow? [y/N] ")) ?? "").trim().toLowerCase());
    };
    const create = io?.createAgent ?? ((o: AgentOptions): Runnable => new Agent(o));
    const model = (parsed.model as string) ?? DEFAULT_MODEL;
    const agent = create({
      model,
      gui: parsed.gui === true,
      search: parsed.search !== false,
      confirm: ask,
      confirmAll: parsed["confirm-all"] === true,
      policy: engine,
      maxSteps,
      onEvent: (k, d) => show(k, d, out),
    });
    if (positionals.length) {
      out("\n" + (await agent.run(positionals.join(" "))));
      return 0;
    }
    out("osagent interactive mode. Ctrl-D to quit.");
    for (;;) {
      const task = (await prompt("\nTask> "))?.trim();
      if (task === undefined) return 0;
      if (task) out("\n" + (await agent.run(task)));
    }
  } finally {
    reader?.close();
  }
}