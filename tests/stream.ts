import { PassThrough } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { vi } from "vitest";
import { main } from "../src/mcpServer.js";

/** A client transport over a pair of streams, for driving main() in-process. */
class StreamTransport implements Transport {
  onmessage?: (m: JSONRPCMessage) => void;
  onclose?: () => void;
  onerror?: (e: Error) => void;
  private buf = new ReadBuffer();
  constructor(private toServer: PassThrough, private fromServer: PassThrough) {}
  async start(): Promise<void> {
    this.fromServer.on("data", (d: Buffer) => {
      this.buf.append(d);
      for (let m = this.buf.readMessage(); m; m = this.buf.readMessage()) this.onmessage?.(m);
    });
  }

  async send(m: JSONRPCMessage): Promise<void> { this.toServer.write(serializeMessage(m)); }
  async close(): Promise<void> { this.toServer.end(); this.onclose?.(); }
}

export interface Running { client: Client; stderr: string[]; names: () => Promise<string[]>; close: () => Promise<number> }

/**
 * Run the real omcps main() with these arguments and connect an MCP client to it.
 * @param argv - Command-line arguments.
 * @param capabilities - Client capabilities.
 * @returns A handle for the running server.
 */
export async function runOmcps(argv: string[], capabilities: object = {}): Promise<Running> {
  const stderr: string[] = [];
  vi.spyOn(console, "error").mockImplementation((...a) => void stderr.push(a.join(" ")));
  const toServer = new PassThrough();
  const fromServer = new PassThrough();
  const done = main(argv, { stdin: toServer, stdout: fromServer });
  const client = new Client({ name: "t", version: "1" }, { capabilities });
  await client.connect(new StreamTransport(toServer, fromServer));
  return {
    client, stderr,
    names: async () => (await client.listTools()).tools.map((t) => t.name),
    close: async () => { await client.close(); return done; },
  };
}

export const textOf = (r: unknown): string => ((r as { content: { type: string; text?: string }[] }).content).map((c) => c.text ?? `<${c.type}>`).join("");
