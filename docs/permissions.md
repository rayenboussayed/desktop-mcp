# Permissions model

`desktop-mcp` has a deny-by-default permission engine. With no permission flags, only
`permissions_describe` is exposed, and the process prints permission guidance on stderr.

## core rules

1. Every tool has capability metadata. Tools without metadata are refused.
2. Factories run through a single `PermissionEngine`.
3. Denial is checked before asking for approval.
4. Approval prompts are designed not to expose file paths, contents, or typed text.
5. Policies can be built from flags, from a preset, or from a JSON policy file.
6. Scopes such as allowed paths, command patterns and regions are enforced before the
   tool runs.

## Capability groups

| flag | capability set |
|---|---|
| `--allow-all` | every capability |
| `--allow-gui` | mouse, keyboard, screen capture/read, windows, clipboard |
| `--allow-mouse` | mouse movement, clicks, drags and scroll |
| `--allow-keyboard` | typing and key presses |
| `--allow-clipboard` | clipboard read and write |
| `--allow-clipboard-read` | clipboard read only |
| `--allow-screen` | screenshots and screen search |
| `--allow-record` | screen recording |
| `--allow-windows` | list, focus, move, resize, minimise, close |
| `--allow-windows-list` | list and inspect only |
| `--allow-files` | read and write files |
| `--allow-files-read` | read files only |
| `--allow-delete` | delete and move paths |
| `--allow-shell` | shell execution |
| `--allow-processes` | list and kill processes |
| `--allow-processes-list` | list processes only |
| `--allow-system` | system information and environment variables |
| `--allow-web` | web search and fetching |
| `--allow-open` | open files, folders and URLs |

## Scoping flags

- `--allow-path DIR`: limits file access to a folder.
- `--deny-path P`: never touch a path.
- `--readonly-path P`: readable but never changed.
- `--allow-command REGEX`: allows shell commands matching a pattern.
- `--deny-command REGEX`: refuses shell commands matching a pattern.
- `--allow-host REGEX`: fetch URLs only from matching hosts.
- `--deny-host REGEX`: denies matching hosts.
- `--allow-window REGEX`: input and window control only when the focused window
  matches.
- `--region x,y,w,h`: confines pointer and captures to a rectangle.
- `--block-key`: refuses a key combination.
- `--block-text`: refuses typed text matching a pattern.
- `--max-type-chars`: maximum characters per `type_text`.
- `--rate-limit`: maximum actions per minute.
- `--max-actions`: maximum actions in one server lifetime.
- `--audit-file`: append calls to a JSONL file.
- `--audit-args`: include arguments in the audit log.
- `--ask-fallback`: behaviour when a client cannot prompt (`allow` or `deny`).
- `--allow-tool`: allow a named tool explicitly.
- `--deny-tool`: deny or hide a named tool explicitly.
- `--policy-show`: print effective permissions and exit.

## Safety nets for flags

When permissions are built from flags, `desktop-mcp` adds default protections:

- denied credential paths: `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`, `~/.netrc`,
  `/etc/shadow`, and special container secret paths;
- dangerous command patterns: `rm -rf`, `sudo`, `mkfs`, `dd`, `curl | sh`,
  reverse shells, writing `/dev/sd*`, etc.

Opt out explicitly with:

- `--allow-sensitive-paths`
- `--allow-dangerous-commands`

## Policy files

```jsonc
{
  "name": "notes-helper",
  "default": "deny",
  "capabilities": {
    "fs.read": "allow",
    "fs.write": "ask",
    "shell.exec": "ask",
    "screen.capture": "allow"
  },
  "tools": { "delete_path": "deny" },
  "paths": {
    "allow": ["~/notes/**"],
    "deny": ["~/notes/private"],
    "readOnly": ["~/notes/archive"]
  },
  "commands": {
    "allow": ["^git (status|log|diff)\\b"],
    "blockDangerous": true
  },
  "gui": {
    "windows": ["^Notes"],
    "regions": [{ "x": 0, "y": 0, "width": 1280, "height": 720 }]
  },
  "limits": { "maxActionsPerMinute": 60 },
  "audit": { "file": "~/desktop-mcp-audit.jsonl" }
}
```

Presets are selected with `--preset locked|readonly|standard|desktop|safe|full`.

## Guarantees and warnings

- Paths are resolved through symlinks before matching.
- Command allow-lists refuse chaining with `;`, `|`, `&`, `$`, backticks, `<`, `>`
  and newlines.
- Denial beats approval.
- Audit files are append-only JSON lines; failure to write the audit log fails the
  call.
- `run_command` is not a sandbox and can reach anything the user can.
- `--allow-open` starts programs with your rights.
- The screen-corner fail-safe can block all input if the mouse sits there.
