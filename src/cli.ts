import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { parseArgs } from "node:util";
import { Agent, DEFAULT_MODEL, type AgentOptions, type Args } from "./agent.js";
import { describePlatform } from "./platform.js";
import { PermissionEngine } from "./policy/engine.js";
import { FLAG_OPTIONS, anyPermissionFlag, permissionHelp, policyFromFlags, type FlagValues } from "./policy/flags.js";
import { PolicyError } from "./policy/load.js";

export interface Runnable {
  run(task: string): Promise<string>;
}

export interface CliIo {
  /** Print a line to stdout. */
  out: (s: string) => void;
  /** Ask a question; resolves null on EOF / Ctrl-D. */
  prompt: (q: string) => Promise<string | null>;
  createAgent: (opts: AgentOptions) => Runnable;
  /** Streams for the default line reader (tests). */
  input?: Readable;
  output?: Writable;
}

/**
 * Queue-based line reader: works for a TTY and for piped stdin, and survives EOF.
 * @param input - Readable input stream.
 * @param output - Writable output stream.
 * @returns A line reader with an `ask` method.
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
  --policy-show   print the effective permissions and exit

Without any permission flag the agent uses its built-in prompts for dangerous commands. With one, the
permission engine decides what the agent may do (see below).

${permissionHelp()}
  --info          print the detected platform and exit
  -h, --help      this help`;

/**
 *
 * @param argv - Command-line arguments.
 * @param io - I/O overrides.
 * @returns The process exit code.
 */
export async function main(argv: string[] = process.argv.slice(2), io?: Partial<CliIo>): Promise<number> {
  let values;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        model: { type: "string", default: DEFAULT_MODEL },
        gui: { type: "boolean", default: false },
        "no-search": { type: "boolean", default: false },
        "confirm-all": { type: "boolean", default: false },
        "max-steps": { type: "string", default: "40" },
        info: { type: "boolean", default: false },
        ...FLAG_OPTIONS,
        "policy-show": { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    }));
  } catch (e) {
    console.error(`osagent: ${(e as Error).message}`);
    return 2;
  }
  const out = io?.out ?? console.log;
  if (values.help) {
    out(HELP);
    return 0;
  }
  if (values.info) {
    out(describePlatform());
    return 0;
  }
  const maxSteps = Number.parseInt(values["max-steps"] as string, 10);
  if (!Number.isInteger(maxSteps) || maxSteps < 1) {
    console.error("osagent: --max-steps must be a positive integer");
    return 2;
  }

  let engine: PermissionEngine | undefined;
  if (anyPermissionFlag(values as FlagValues) || values["policy-show"]) {
    try {
      engine = new PermissionEngine((await policyFromFlags(values as FlagValues)).policy);
    } catch (e) {
      console.error(`osagent: ${e instanceof PolicyError ? e.message : (e as Error).message}`);
      return 2;
    }
    if (values["policy-show"]) {
      const { buildToolset } = await import("./tools/index.js");
      const e = engine;
      out(e.describe([...(await buildToolset(values.gui as boolean, !values["no-search"])).values()].filter((t) => e.isVisible(t.name))));
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
    const agent = create({
      model: values.model as string,
      gui: values.gui as boolean,
      search: !(values["no-search"] as boolean),
      confirm: ask,
      confirmAll: values["confirm-all"] as boolean,
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
