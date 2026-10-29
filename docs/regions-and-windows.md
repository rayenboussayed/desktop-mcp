# Regions and windows

## Regions

`--region x,y,w,h` can be repeated. Actions outside the allowed region are refused, and
captured regions are clipped correctly even where libnut ignores the requested edge.

## Windows

`--allow-window REGEX` scopes interactive automation to focused window titles. The
engine resolves the focused window at call time. The list usually excludes empty
titles and WM helper frames, according to the window list behaviour.

## Mouse and keyboard safety

- The mouse in a screen corner acts as a human fail-safe and blocks input.
- Keys and buttons that desktop-mcp holds are released when disconnecting.
- `--block-key` and `--block-text` refuse dangerous combinations or content.
