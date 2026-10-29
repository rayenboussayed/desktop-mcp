# Security model

desktop-mcp is a **tool interface**, not a security sandbox. It controls what an AI can
request through MCP, not what the operating system user can do once a command is
running.

## What it guarantees

- Everything is denied unless permissions are granted.
- Tools without permission metadata are refused (fail closed).
- File paths are resolved through symlinks before checks.
- Command patterns refuse shell chaining attempts.
- Path denials apply before approval prompts.
- Appended input arguments are never exposed in audit? `desktop-mcp` exposes size and
  metadata, not file contents or typed text.
- Held keys and buttons are released on disconnect.
- Dangerous flag-only setups include safety-net denials.

## What it does not guarantee

- Standard shell commands can bypass path policy (`cat ~/.ssh/id_rsa`).
- `--allow-open` starts programs with all user rights.
- Region only limits pointer coordinates and captures, not keystrokes.
- Window scoping checks the currently focused window.
- Network tools can reach the requested hosts when allowed.

## Recommended hardening

- Prefer `--ask-shell` to `--allow-shell`.
- Prefer explicit `--allow-command` allow-lists.
- Add `--rate-limit` and `--max-actions`.
- Keep audit logs enabled.
- Use specific `--allow-path` scopes.
- Avoid `--allow-sensitive-paths` and `--allow-dangerous-commands`.
- Run under a less privileged user where practical.

## Audit logs

Audit files are JSONL records, appended atomically in practice. If the file cannot be
written, the call is refused.
