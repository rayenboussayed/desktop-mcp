# CLI reference

General form:

```bash
desktop-mcp [options]
```

Modes:

```bash
desktop-mcp [options]                 # stdio MCP transport
desktop-mcp [options] --transport streamable-http --port 8000
desktop-mcp [options] --policy-file policy.json --policy-show
```

## Essential options

| option | meaning |
|---|---|
| `--help`, `-h` | Print help |
| `--version` | Print version and platform |
| `--transport <stdio\|streamable-http>` | Transport type |
| `--port <n>` | HTTP port |
| `--allow-all` | Grant all documented permission groups |
| `--ask-fallback allow` or `deny` | Behaviour when the client does not support approval prompts |
| `--max-actions <n>` | Refuse after this many actions in a run |
| `--rate-limit <n>` | Maximum actions per minute |
| `--region x,y,w,h` | Confine pointer and screen actions to a region |
| `--audit-file <path>` | Write an audit log |
| `--audit-args` | Include tool arguments in audit log |
| `--policy-show` | Show effective permissions and exit |
| `--config`, `--policy <path>` | Load permissions from a policy file |
| `--preset <name>` | Start permissions from a named preset |
| `--allow-tool <name>` | Allow one additional named tool |
| `--deny-tool <name>` | Hide and refuse one named tool |

## Permission flags

Feature flags accept `--allow-<group>` and `--ask-<group>`. Feature groups:

- `all`
- `gui`
- `mouse`
- `keyboard`
- `clipboard`
- `clipboard-read`
- `screen`
- `record`
- `windows`
- `windows-list`
- `files`
- `files-read`
- `delete`
- `shell`
- `processes`
- `processes-list`
- `system`
- `web`
- `open`

Scoping flags can be repeated:

- `--allow-path`
- `--deny-path`
- `--readonly-path`
- `--allow-command`
- `--deny-command`
- `--allow-host`
- `--deny-host`
- `--allow-window`
- `--region`
- `--block-key`
- `--block-text`
- `--max-type-chars`
- `--rate-limit`
- `--max-actions`
- `--audit-file`
- `--ask-fallback`
- `--allow-tool`
- `--deny-tool`

Safety-net opt-outs:

- `--allow-sensitive-paths`
- `--allow-dangerous-commands`

See [Permissions](./permissions.md) for the complete matrix and semantics.
EOF