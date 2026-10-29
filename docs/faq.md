# Frequently asked questions

## Why is access denied by default?

`desktop-mcp` is designed so that nothing runs unless explicitly allowed. This allows
safe local operation.

## Does it install a cloud SDK?

No, for the MCP server. The optional peer `@anthropic-ai/sdk` is only for the
standalone `osagent` command, is never installed with desktop-mcp, and is never
loaded.

## Does OCR download anything?

No. OCR and image matching are local. If the language is missing, an error explains
which package to install.

## Can it run on Windows?

Yes, native Windows support is provided. The test suite on Linux does not itself build
Windows.

## Can it run headless?

The server can start, but GUI and desktop tools need a display.

## Why no `npm install desktop-mcp` after a rename?

The published npm name for this repository is now `desktop-mcp`.

## Is Wayland supported?

nut.js uses X11; Wayland-only is not supported. XWayland or an X session is required.

## Why are some nut.js plugins unavailable?

Many nut.js plugins are proprietary. Local substitutes are provided.
EOF