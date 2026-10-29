# Prerequisites

This page follows the runtime requirements of **nut.js** from
<https://github.com/nut-tree/nut.js>, translated to the `@nut-tree-fork/nut-js`
package used by `desktop-mcp`.

## Common requirements

- Node.js 20 or newer
- A desktop session on Windows, Linux, or macOS. `desktop-mcp` drives the physical
  mouse, keyboard and screen, so headless servers cannot act on a desktop.
- Console or MCP client permissions to run the process.

## Windows

- Windows 10 or newer.
- For the ImageFinder plugins on Windows 10 N, install the
  [Media Feature Pack](https://support.microsoft.com/en-us/topic/media-feature-pack-for-windows-10-n-may-2020-ebbdf559-b84c-0fc2-bd51-e23c9f6a4439).
- nut.js performs native desktop automation. No X runtime is required.
- Use a CPU architecture with a published prebuilt binary for `@nut-tree-fork/nut-js`.
- `ffmpeg` is optional for MP4 screen recording.

## macOS

- macOS with Xcode command-line tools installed:

```bash
xcode-select --install
```

- Grant the terminal or host application (for example iTerm, Visual Studio Code,
  IntelliJ) these privacy permissions:
  - Accessibility
  - Screen Recording
- Failure to grant the permissions is reported at runtime by nut.js.

## Linux

Required native package:

```bash
sudo apt-get install libxtst-dev
```

Other distributions have equivalent packages. The official nut.js dependency is X11:

- X11 is supported.
- Wayland-only sessions are **not** supported by nut.js.
- On Wayland compositors, log in to an X11 session or use XWayland where possible.
- For window control and reliable screenshots, an X11 display and usually an EWMH
  window manager are required.

`desktop-mcp` additionally uses these Linux tools:

```text
Xvfb, xprop, xwininfo, xdotool, wmctrl, xclip, xev, xsetroot
```

Install equivalents for your distribution, for example:

```bash
# Ubuntu / Debian
sudo apt-get install xvfb x11-utils xdotool wmctrl xclip x11-xserver-utils

# Fedora
sudo dnf install xorg-x11-server-Xvfb xorg-x11-utils xdotool wmctrl xclip xorg-x11-utils
```

## Building nut.js from source

If no prebuilt binary exists for your platform, nut.js must be built from source:

1. Build `@nut-tree/libnut-core`.
2. Update `nut.js` dependencies to point to your local build.
3. Build the official nut.js or community fork as a local dependency.

`desktop-mcp` itself uses the community fork `@nut-tree-fork/nut-js`, which is an
optional dependency. If it is missing, the server still runs for non-GUI features.

## `desktop-mcp` specific requirements

- Optional OCR dependencies: `tesseract.js` and `@tesseract.js-data/eng` are bundled
  as optional dependencies. They do not download data at runtime.
- Optional image-processing dependency: `jimp`.
- Optional recording converter: `ffmpeg` (MP4 output; PNG frames work without it).
- Anthropic SDK is optional and only used by the standalone `osagent` command, not
  by the MCP server.
EOF