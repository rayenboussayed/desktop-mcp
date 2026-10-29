# Architecture

## Layers

1. transports: stdio or streamable HTTP
2. MCP server: tool dispatch, logging, elicitation
3. permission engine: capabilities, scoping, approval
4. tools: source modules in `src/tools/*`
5. native subsystems: nut.js, screen, clipboard, files
6. optional plugins: matchers, OCR, colour, OCR provider state
7. standalone agent `osagent`, optional Anthropic SDK

## Main modules

- `src/cli.ts`: CLI parsing and main orchestration.
- `src/mcpServer.ts`: server setup, request handlers.
- `src/policy`: validation, schemas, presets, engine, capabilities.
- `src/nut/runtime.ts`: nut.js loading, X socket checks, fallbacks.
- `src/tools/*`: desktop, system, files and web tools.
- `src/plugins/*`: OCR, image matching, screen recording, colour.
- `src/exec.ts`: subprocess execution and process-tree kills.
- `src/platform.ts`: operating-system detection and paths.

## Runtime lifecycle

1. Parse flags / load policy.
2. Build toolset based on capabilities.
3. Create MCP server.
4. Accept calls and enforce limits, regions, windows.
5. Release held input and audit on exit.
