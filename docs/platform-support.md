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
- Wayland-only sessions are not supported by nut.js.
- desktop-mcp refuses unsupported Linux runtimes at the tool level: a GUI call on a
  Wayland-only or display-less session returns an explicit error instead of trying to
  capture through libnut. Run it under X11, XWayland, or `xvfb-run`.
- `open_path` uses `xdg-open`.
- If `DISPLAY` points at a headless or non-interactive runtime, GUI features fail
  individually; non-GUI tools continue to work.
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
