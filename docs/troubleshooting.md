# Troubleshooting

## `DISPLAY is not set`

Run under Xvfb:

```bash
Xvfb :99 -screen 0 1280x800x24 &
export DISPLAY=:99
```

Wayland-only sessions are not supported by nut.js.

## Nut.js cannot find modules

Install optional dependencies:

```bash
npm install @nut-tree-fork/nut-js @tesseract.js-data/eng jimp tesseract.js
```

## `Win32` on Linux virtual display

Install X11 utilities, `xdotool`, `wmctrl`, and `xclip`. See
[prerequisites](./prerequisites.md).

## Wayland clipboard

`xclip` works under X11 or XWayland. Native Wayland `wl-copy`/`wl-paste` support
depends on the system.

## OCR language errors

Install another data package and set `OSAGENT_OCR_LANG_PATH`.

## Fail-safe lockout

Move the mouse away from the screen corner.

## Policy asks but the client cannot prompt

Use `--ask-fallback allow` or `--ask-fallback deny`.

## Screenshot area exceeds bounds

Resize the region or use full screen.

## Audit log failure

Ensure the directory exists and is writable. Failures are treated as failures in
the tool path.
EOF