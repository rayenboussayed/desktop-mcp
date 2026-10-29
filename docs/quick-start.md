# Quick start

Start the server with no permissions first:

```bash
desktop-mcp
```

The AI sees `permissions_describe` only. Add permissions with flags.

## Desktop automation

```bash
desktop-mcp --allow-mouse --allow-keyboard --allow-screen --allow-windows --allow-clipboard
```

## File work

```bash
desktop-mcp --allow-files --allow-path ~/projects --allow-shell
```

## Safer interactive mode

```bash
desktop-mcp --allow-files --allow-path ~/projects --ask-shell --allow-mouse --allow-keyboard
```

## Full local desktop control

```bash
desktop-mcp --allow-all
```

## Use with an MCP client

```json
{
  "mcpServers": {
    "desktop-mcp": {
      "command": "npx",
      "args": ["desktop-mcp@latest", "--allow-all"]
    }
  }
}
```

## Test without changing your desktop

The test suite starts a private virtual display. For manual experiments, use Xvfb:

```bash
Xvfb :99 -screen 0 1280x800x24 &
export DISPLAY=:99
desktop-mcp --allow-all
```
