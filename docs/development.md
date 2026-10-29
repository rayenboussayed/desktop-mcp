# Development and testing

## Build and check

```bash
npm run typecheck
npm run lint
npm run knip
npm run build
npm run test
npm run check
```

The check chain is `typecheck -> lint -> test -> knip -> build`.

## requirements for full coverage

Full coverage needs a private X stack:

```bash
export PATH=/tmp/opencode/x11prefix/usr/bin:$PATH
export LD_LIBRARY_PATH=/tmp/opencode/x11prefix/usr/lib64
export XDG_DATA_DIRS=/tmp/opencode/x11prefix/usr/share:/usr/share
npm run check
```

See [prerequisites](./prerequisites.md). On this repository, Linux X tooling is available through
wrappers in `~/.local/bin`.

## Test layout

- `tests/unit`: pure logic and fake backends.
- `tests/integration`: MCP clients, filesystem, processes, shells.
- `tests/e2e`: real X display and desktop interactions.
- Shared helpers remain under `tests/`.

## coverage

Vitest enforces 100% statements, branches, functions and lines for files under `src/`.
Binary entry points and the re-export barrel are excluded.

## Extending

When complete, append a note to `AGENTS.md` using the existing format.

## linting

`eslint.config.ts` is intentionally not changed. Run lint with `--max-warnings 0`.
