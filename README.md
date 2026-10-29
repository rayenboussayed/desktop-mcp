# desktop-mcp — an MCP server that lets an AI use your computer

`desktop-mcp` gives Claude Desktop, Claude Code, VS Code, Cursor or any MCP client controlled access to your machine:
**shell, files, clipboard, mouse, keyboard, screen (OCR, image and colour search), windows.** Built on
[nut.js](https://nutjs.dev). Windows, Linux and macOS.

* **Everything runs on your device.** No cloud service, no API key, no model download. Only `web_search` and
  `fetch_url` use the network, and they are off unless you pass `--allow-web`.
* **Nothing is allowed unless you say so.** You grant features with flags: `--allow-all`, `--allow-mouse`,
  `--allow-clipboard`, ... and scope them (`--allow-path`, `--region`, `--allow-window`, ...).

```bash
npx desktop-mcp@latest --allow-all                                   # everything (with safety nets, see below)
npx desktop-mcp@latest --allow-mouse --allow-keyboard --allow-screen # drive the desktop, nothing else
npx desktop-mcp@latest --allow-files --allow-path ~/projects --ask-shell
npx desktop-mcp@latest --help
```

## Add it to your MCP client

The same pattern as other npx-based MCP servers: the command is `npx`, the flags are the permissions.

**Claude Desktop / Cursor** (`mcpServers` in the config file):

```json
{
  "mcpServers": {
    "desktop-mcp": { "command": "npx", "args": ["desktop-mcp@latest", "--allow-mouse", "--allow-keyboard", "--allow-screen", "--allow-windows"] }
  }
}
```

**Claude Code:** `claude mcp add desktop-mcp -- npx desktop-mcp@latest --allow-all`

**VS Code:** `code --add-mcp '{"name":"desktop-mcp","command":"npx","args":["desktop-mcp@latest","--allow-all"]}'`

Run it as an HTTP server instead of stdio: `npx desktop-mcp@latest --allow-all --transport streamable-http --port 8000`
(`http://127.0.0.1:8000/mcp`; binds to localhost and rejects foreign `Host` headers).

> The package is named `desktop-mcp`; until it is published to the npm registry, install from the tarball:
> `npx --package=./desktop-mcp-0.4.0.tgz desktop-mcp --allow-all`.

## Permissions

With no flags nothing is allowed: the AI sees one tool, `permissions_describe`, and stderr tells you what to add.
Every tool call passes through one engine that decides **allow / ask / deny** before anything runs; tools the AI is
not allowed to use are **not even listed**.

### Feature flags

`--allow-<group>` grants a group; `--ask-<group>` makes every use need your approval (through MCP elicitation, when
the client supports it). `allow` beats `ask` for the same feature.

| flag | grants |
|---|---|
| `--allow-all` | every feature below |
| `--allow-gui` | mouse + keyboard + screen + windows + clipboard |
| `--allow-mouse` | move, click, drag, scroll |
| `--allow-keyboard` | type text, press keys, hold keys |
| `--allow-clipboard` / `--allow-clipboard-read` | clipboard read + write / read only |
| `--allow-screen` | screenshots, OCR, image and colour search |
| `--allow-record` | screen recording |
| `--allow-windows` / `--allow-windows-list` | list, focus, move, resize, minimise, close / list only |
| `--allow-files` / `--allow-files-read` | read + write files / read only |
| `--allow-delete` | delete and move files |
| `--allow-shell` | run shell commands |
| `--allow-processes` / `--allow-processes-list` | list + kill / list only |
| `--allow-system` | system information, environment variables |
| `--allow-web` | `web_search`, `fetch_url` (the only network use) |
| `--allow-open` | open files, folders and URLs with the default app |

A few tools combine features, and need all of them: pasting needs clipboard **and** keyboard; `click_text` needs
screen **and** mouse; `screenshot_save` and `screen_record` also need file-write permission.

### Scoping flags (all repeatable)

`--allow-path DIR` `--deny-path P` `--readonly-path P` · `--allow-command REGEX` `--deny-command REGEX` ·
`--allow-host REGEX` `--deny-host REGEX` · `--allow-window REGEX` · `--region x,y,w,h` · `--block-key ctrl+alt+delete`
`--block-text REGEX` `--max-type-chars N` · `--rate-limit N` (per minute) `--max-actions N` ·
`--audit-file PATH` `--audit-args` · `--ask-fallback allow|deny` · `--allow-tool NAME` `--deny-tool NAME` ·
`--policy-show` (print what the AI may do and exit).

### Safety nets for flag-only setups

When you build permissions from flags alone, `desktop-mcp` also **denies credential locations** (`~/.ssh`, `~/.aws`,
`~/.gnupg`, `~/.kube`, `~/.netrc`, `/etc/shadow`, ...) and **refuses dangerous shell patterns** (`rm -rf`, `sudo`,
`mkfs`, `curl | sh`, ...). Opt out explicitly with `--allow-sensitive-paths` / `--allow-dangerous-commands`.

### Bases: presets and policy files

Flags can be layered on a base: `--preset locked|readonly|standard|desktop|safe|full`, or `--config policy.json`
(alias `--policy`; legacy `--safe`, `--read-only`). A preset or file is trusted as written (no extra safety nets).

```jsonc
// policy.json
{
  "name": "notes-helper", "default": "deny",
  "capabilities": { "fs.read": "allow", "fs.write": "ask", "shell.exec": "ask", "screen.capture": "allow" },
  "tools": { "delete_path": "deny" },
  "paths": { "allow": ["~/notes/**"], "deny": ["~/notes/private"], "readOnly": ["~/notes/archive"] },
  "commands": { "allow": ["^git (status|log|diff)\\b"], "blockDangerous": true },
  "gui": { "windows": ["^Notes"], "regions": [{ "x": 0, "y": 0, "width": 1280, "height": 720 }] },
  "limits": { "maxActionsPerMinute": 60 }, "audit": { "file": "~/desktop-mcp-audit.jsonl" }
}
```

### What the engine guarantees

* **Paths** are checked on the real, symlink-resolved path: a link inside an allowed folder cannot escape it.
* **Command allow-lists refuse chaining** (`; | & ` $( > <` newline) so `git status; rm -rf /` cannot pass `^git`.
* **Denial comes before asking**; approval prompts never show file contents or typed text (only their size).
* **Fail closed**: a tool without permission metadata is refused; an unwritable audit log refuses the call.
* Keys and buttons the AI left held are released when the client disconnects.

### What it does NOT do

It controls the **tool interface**, not the operating system. It is **not a sandbox**.
`run_command` can do anything your user can, and path rules do not apply to what a shell command touches
(`cat ~/.ssh/id_rsa` is a shell command): keep `--allow-shell` off, use `--ask-shell` or a command allow-list.
`--allow-window` checks the focused window at call time. `--region` limits pointer coordinates and
captures, not what a keystroke does. Applications started with `--allow-open` run with your full rights.

## Tools (62 with the desktop features)

| area | tools |
|---|---|
| **Mouse** | `mouse_position` `move_mouse` `mouse_move_relative` `click` (any button, `clicks=2` = double) `mouse_press` `mouse_release` `mouse_drag` `scroll` (vertical + horizontal) |
| **Keyboard** | `type_text` `press_key` (hotkeys, media keys, keypad) `key_down` `key_up` `list_keys` |
| **Screen** | `screenshot` (full or region) `screenshot_save` `screen_size` `screen_color_at` `screen_highlight` |
| **Windows** | `window_list` `window_active` `window_focus` `window_move` `window_resize` `window_minimize` `window_restore` `window_close` `window_wait_for` |
| **Clipboard** | `clipboard_get` `clipboard_set` `clipboard_clear` `clipboard_copy` `clipboard_paste` |
| **Image search** | `screen_find_image` `screen_find_images` `screen_wait_for_image` `click_image` (multi-scale, alpha-mask aware) |
| **OCR** | `screen_read_text` `screen_find_text` (exact / contains / **fuzzy**) `screen_wait_for_text` `click_text` |
| **Colour** | `screen_find_color` (regions of a colour, largest first) |
| **Recording** | `screen_record` (PNG frames; MP4 too if `ffmpeg` is installed) |
| **System** | `system_info` `get_env` `list_processes` `kill_process` `run_command` `open_path` `plugin_status` `permissions_describe` |
| **Files / web** | `read_file` `write_file` `edit_file` `list_dir` `find_files` `search_in_files` `make_dir` `copy_path` `move_path` `delete_path` `web_search` `fetch_url` |

Coordinates are in **logical** screen pixels (what clicks expect), also on HiDPI displays.

## Runs locally — and how that is checked

* OCR is `tesseract.js` (WebAssembly) with English data shipped in the package. **It never downloads models**: a
  language that is not installed is an error telling you which `@tesseract.js-data/<lang>` to install (or set
  `OSAGENT_OCR_LANG_PATH`). Image matching, colour search, recording and windows are pure local code.
* There is **no cloud provider and no API key** anywhere in the MCP server. The standalone `osagent` agent (a
  separate command in the same package) is the only part that talks to an LLM API; its SDK is an *optional peer
  dependency* that `desktop-mcp` never installs or loads.
* Tests prove it: a static test fails if any file other than the web tools and the standalone agent contains
  network-client code or a cloud-SDK reference, and an end-to-end test runs the server with **every feature allowed
  inside a network-less namespace** (real desktop, OCR, image/colour search, clipboard, files, shell: all work;
  only `web_search` / `fetch_url` fail, cleanly).

### nut.js plugins

All ten plugins on nutjs.dev are sold behind a private registry and none is on public npm. Local equivalents are
built in and registered with nut.js, so its own `screen.find(...)` works with them. `plugin_status` prints this table.

| official plugin | here |
|---|---|
| nl-matcher, template-matcher | **built in**: pure-JS image matcher |
| plugin-ocr | **built in**: tesseract.js, offline |
| plugin-screenrecording | **built in**: frames, MP4 with ffmpeg |
| window search | **built in** |
| plugin-ai-sdk | **deliberately not included**: it needs a cloud LLM and an API key. Use `screen_find_text` (fuzzy), `screen_find_image`, `screen_find_color` |
| plugin-azure | not available: a cloud OCR service |
| element-inspector, playwright-bridge, selenium-bridge, plugin-rdp, bolt | not available: proprietary |

## What was verified on a real X server, and what it changed

Tested against Xvfb with a real window manager (openbox) and real X clients (`xev`, `xterm`, `xclip`). nut.js needed
compensation:

| finding (Linux / X11) | what desktop-mcp does |
|---|---|
| `keyboard.type` types shifted punctuation as the base key (`!`→`1`), drops other characters and all non-ASCII | never used on Linux: each character is an explicit key (+Shift); non-ASCII is pasted. All 95 printable ASCII characters verified in a real terminal |
| `scrollRight` sends X button 6 (= wheel-**left**) | swapped on Linux |
| `getWindows()` returns the WM's frames and 1×1 helpers with empty titles | lists real clients from `_NET_CLIENT_LIST` |
| window geometry is frame-relative | reads absolute geometry with `xwininfo` |
| `minimize`/`restore` not implemented in libnut | `xdotool`; `wmctrl` for a polite close |
| `screen.grab(region)` ignores the region | crops itself |
| `Key.Enter` is the keypad Enter | `enter` → `Key.Return` |
| libnut **aborts the process** if the display can't be opened; needs `DISPLAY` in the *initial* environment | checks by connecting to the X socket on every call |

Linux needs an X11 display (real or Xvfb) and, for window tools, an EWMH window manager plus `xprop`/`xwininfo`
(x11-utils), `xdotool`, `wmctrl`. Wayland-only sessions are not supported by nut.js. macOS needs Screen Recording and
Accessibility permission for the terminal. The mouse in a **screen corner** is a human fail-safe that blocks all
input (an agent that parks the pointer there locks itself out until a person moves it).

## Standalone agent

`osagent "task"` is a small agent loop (plan → act → verify) that uses the same tools and permission flags. It is the
only component that needs an LLM API: `npm install @anthropic-ai/sdk` and set `ANTHROPIC_API_KEY`.

## Testing

```bash
npm test      # builds, then vitest with coverage; thresholds are 100% for statements, branches, functions, lines
```

Tests run against a private Xvfb + openbox started once in `tests/globalSetup.ts` (never your real desktop). Real,
not mocked, where it matters: subprocesses and process-tree kills, files and symlink escapes, a local HTTP server, MCP
clients over in-memory/stdio/HTTP, MCP elicitation approvals, the real `main()` with real flags, real windows, real
key/mouse events observed by `xev`, typed text checked in a real `xterm`, real OCR, pixel and colour matching, the
real clipboard, a network-less namespace, and `npx` installing the packed tarball.

Coverage notes: `src/bin/*` (two-line launchers) and `src/index.ts` (re-export barrel) are excluded, and one line in
`policy/engine.ts` carries a `v8 ignore` (the filesystem root always resolves).

**Not verified here:** Windows and macOS themselves (their paths are tested against a fake nut.js and fake
`powershell`/`cmd`: that checks desktop-mcp's logic, not those platforms); the proprietary nut.js plugins (not obtainable);
`screen_highlight`'s overlay (the call is
tested; the overlay can't be observed headlessly); publishing to the npm registry.
