import { z } from "zod";

type TextBlock = { type: "text"; text: string };
type ImageBlock = { type: "image"; source: { type: "base64"; media_type: "image/png"; data: string } };
export type ContentBlock = TextBlock | ImageBlock;
/** A tool returns either a string or a list of content blocks (e.g. an image). */
export type ToolResult = string | ContentBlock[];

const MAX_OUTPUT = 20_000;

/**
 *
 * @param text - Text to process.
 * @param limit - Maximum output length.
 * @returns The truncated text.
 */
export function truncate(text: string, limit: number = MAX_OUTPUT): string {
  if (text.length <= limit) return text;
  const half = Math.floor(limit / 2);
  return text.slice(0, half) + `\n...[truncated ${text.length - limit} chars]...\n` + text.slice(-half);
}

export type Shape = z.ZodRawShape;

/**
 * One definition feeds both the Anthropic API tool list (agent) and the MCP server:
 * the zod shape is the single source of truth for arguments.
 * `defineTool` types each `run` callback from its own shape, then erases it to `Tool` so tools can be collected.
 */
export interface Tool {
  name: string;
  description: string;
  shape: Shape;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  run: (args: any) => ToolResult | Promise<ToolResult>;
  /** risky tools are gated by `confirmAll` in the agent. */
  risky: boolean;
  readOnly: boolean;
  destructive: boolean;
}

export interface ToolDef<S extends Shape> {
  name: string;
  description: string;
  shape: S;
  run: (args: z.infer<z.ZodObject<S>>) => ToolResult | Promise<ToolResult>;
  risky?: boolean;
  readOnly?: boolean;
  destructive?: boolean;
}

/**
 *
 * @param def - Tool definition.
 * @returns The executable tool.
 */
export function defineTool<S extends Shape>(def: ToolDef<S>): Tool {
  return { risky: false, readOnly: false, destructive: false, ...def };
}

export interface ApiTool {
  name: string;
  description: string;
  input_schema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
}

/**
 * zod 4 emits ±Number.MAX_SAFE_INTEGER bounds for `.int()`: pure noise for the model.
 * @param node - Zod schema node.
 * @returns Nothing.
 */
function stripSafeIntBounds(node: unknown): void {
  if (Array.isArray(node)) return node.forEach(stripSafeIntBounds);
  if (node === null || typeof node !== "object") return;
  const o = node as Record<string, unknown>;
  if (o.minimum === -Number.MAX_SAFE_INTEGER) delete o.minimum;
  if (o.maximum === Number.MAX_SAFE_INTEGER) delete o.maximum;
  Object.values(o).forEach(stripSafeIntBounds);
}

/**
 *
 * @param tool - Tool definition to convert.
 * @returns The model-facing tool schema.
 */
export function toApi(tool: Tool): ApiTool {
  const schema = z.toJSONSchema(z.object(tool.shape), { io: "input" }) as Record<string, unknown>;
  delete schema.$schema;
  delete schema.additionalProperties;
  stripSafeIntBounds(schema);
  return { name: tool.name, description: tool.description, input_schema: schema as ApiTool["input_schema"] };
}

/**
 * Invoke a tool with raw (model-supplied) arguments: validates, applies defaults.
 * @param tool - Tool to invoke.
 * @param rawArgs - Raw model-supplied arguments.
 * @returns The validated tool result.
 */
export async function callTool(tool: Tool, rawArgs: unknown): Promise<ToolResult> {
  const args = z.object(tool.shape).parse(rawArgs ?? {});
  return tool.run(args);
}
