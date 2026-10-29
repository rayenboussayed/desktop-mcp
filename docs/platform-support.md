# Platform support

## Windows

- Uses native mouse, keyboard and screen operations.
- Supports window listing and control.
- `open_path` uses `explorer` style shell behaviour through `cmd`.
- Linux-specific fork/experimental sandbox behaviour is not used.

## macOS

- Native automation is available.
- The terminal host needs Accessibility and Screen Recording permissions.
- `open_path` uses the `open` command.

## Linux

- Windows and input use X11.
- RTL/Wayland-only sessions are not supported by nut.js.
- `open_path` uses `xdg-open`.
- Linux extras from desktop-mcp:
  - explicit per-character keystrokes because `keyboard.type` is unreliable;
  - horizontal scrolling is compensated for wheel button inversion;
  - window list and geometry use raw X clients;
  - screen grabs with regions are cropped by desktop-mcp since libnut ignores regions.
- Required utilities:
  - window list/active: `xprop`
  - geometry: `xwininfo`
  - minimize/restore: `xdotool`
  - polite close: `wmctrl`
  - clipboard: `xclip` (or `xsel`, `wl-copy`/`wl-paste`)
  - fail-safe display probe: `xdpyinfo`
  - `scroll` probe: `xev`
EOF