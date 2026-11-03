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

Full coverage needs a real or virtual X stack on Linux:

```bash
Xvfb :99 -screen 0 1280x800x24 &
export DISPLAY=:99
npm run check
```

The full suite is not mocked: GUI paths run under a real X server started by
`tests/globalSetup.ts`. Xvfb alone covers many paths; window-management tests benefit
from an EWMH-capable window manager such as Openbox. The suite creates and removes
its own display, so do not point it at a live desktop.

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
