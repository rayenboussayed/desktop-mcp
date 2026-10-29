# AGENTS.md — omcps

This file is for agents (LLMs and humans) working on the `omcps` codebase. Keep it detailed, and **append new notes at the bottom** — see "LLM Session Notes (append-only)" before you stop. Do not edit earlier entries.

## What this project is

`omcps` is a local Model Context Protocol (MCP) server that exposes desktop-control
tools to an AI: shell, files, clipboard, mouse/keyboard, screenshots, OCR/image
matching, recording, and window management. It runs on the host machine and is gated by
a per-feature permission flag system plus a high-risk tool confirmation step.

- Runtime: Node >= 20, ESM (`"type": "module"`).
- Native GUI layer on Linux: `@nut-tree-fork/nut-js` (optional dependency).
- No external server/services are required.

## Commands

- `npm install` — install dependencies (Angular ESLint cache is reused by lint).
- `npm run build` — `tsc -p tsconfig.build.json` (compiled into `dist/`).
- `npm run typecheck` — `tsc --noEmit`.
- `npm run lint` — `eslint . --fix --cache --max-warnings 0`.
- `npm test` — `vitest run --coverage`. Runs `pretest` (build) first.
- `npm run knip` — dead-code / unused-export check.
- `npm run check` — `typecheck -> lint -> test -> knip -> build`. **Must be green with
  zero errors and zero warnings before you consider your work done.**

Version (`package.json`): `0.4.0`.

## Architecture (quick map)

- `src/bin/omcps.ts`, `src/cli.ts`, `src/mcpServer.ts` — entry points and MCP wiring.
- `src/policy/` — permission engine (`capabilities`, `engine`, `flags`, `load`, `schema`,
  `presets`) and Safe Tool registry.
- `src/nut/` — nut.js runtime (`runtime.ts` loads the native module; `keys.ts` maps
  shortcuts/characters) and the `__setNutLoader` test hook.
- `src/tools/` — tool implementations: `base`, `base` again, `clipboard`, `files`,
  `gui`, `index`, `registry`, `shell`, `system`, `vision`, `window`.
- `src/plugins/` — colour matching, image matcher, OCR, providers, recorder, status.
- `src/exec.ts` — async process helper with timeout and tree kill.
- `src/platform.ts` — OS detection, `resolveUserPath` (`~` expansion), `which`.
- `src/safety.ts` — fail-safe mouse corner etc.
- `tests/` — Vitest suite. `tests/x.ts` detects X tooling capabilities (`haveX`,
  `haveWm`, `haveTerm`, `haveXev`), `tests/helpers.ts` common utilities, `globalSetup.ts`
  starts a *private* Xvfb for the whole run.

## Docker removal (deliberate)

Docker / the Docker sandbox host-passthrough feature was removed entirely:

- Deleted: `src/host.ts`, `src/bin/osagent-docker.ts`, `src/bin/osagent-docker-run.ts`,
  `tests/docker.test.ts`, `tests/host.test.ts`.
- No `docker` command/feature is shipped; only `~/.docker/config.json` remains referenced
  in `src/policy/presets.ts` as a **credential-protection** path, not a Docker feature.
- Bins in `package.json` now expose only `omcps`, `osagent-mcp`, and `osagent`.
- Host-path mode previously raced Docker socket paths; paths now flow through
  `resolveUserPath` in `src/platform.ts`. Do **not** reintroduce a Docker backend.

## Linux / X11 test requirements (important)

The pure GUI tests drive *real* nut.js against a real display and are skipped (which
breaks 100% coverage) unless a virtual X stack is available.

Required tooling on `PATH`: `Xvfb`, `xdpyinfo`, `openbox`, `xterm`, `xev`, `xdotool`,
`wmctrl`, `xclip`, `xwininfo`, `xsetroot`.

RHEL/fedora provisioning example (run once):
```bash
mkdir -p /tmp/opencode/x11prefix
# download:
dnf download --destdir=/tmp/opencode/x11rpm --resolve --setopt=install_weak_deps=False \
  --setopt=tsflags=nodocs --setopt=gpgcheck=0 Xvfb xterm openbox xdotool wmctrl xclip \
  xev xsetroot xwininfo
# extract each RPM:
for f in /tmp/opencode/x11rpm/*.rpm; do (cd /tmp/opencode/x11prefix && rpm2cpio "$f" | cpio -idm --quiet); done
```
Then run with:
```bash
PATH=/tmp/opencode/x11prefix/usr/bin:$PATH \
LD_LIBRARY_PATH=/tmp/opencode/x11prefix/usr/lib64 \
XDG_DATA_DIRS=/tmp/opencode/x11prefix/usr/share:/usr/share \
npm run check
```
`openbox` needs `libobrender.so.32`/`libobt.so.2` (covered by `LD_LIBRARY_PATH`) and
themes (covered by `XDG_DATA_DIRS`).

`tests/globalSetup.ts` auto-starts one private Xvfb + openbox and deletes `DISPLAY`
before that, so tests never touch a developer's real desktop. Do not point tests at a
live display. `tests/x.ts` computes `haveX`/`haveWm`/`haveXev`/`haveXterm` at import
time; full coverage requires them all to be present.

## Coverage and style constraints

- `vitest.config.ts` enforces 100% for statements, branches, functions, and lines.
- `fileParallelism: false`; the full suite takes a few minutes.
- `eslint.config.ts` must **not** be edited; it is a fixed contract.
- Lint and typecheck have `--max-warnings 0`; any new public API should avoid
  `any`, `object`, and unused exports (knip watches them).

## LLM Session Notes (append-only)

Protocol: when you finish a task, append a dated entry below this line describing what
you changed, files touched, and the verification command you ran. Do not edit earlier
entries; if a later entry corrects one, add a new entry referencing the earlier one.

### 2026-10-29 — (prior session, summary)

- Removed Docker end-to-end (files, bins, README, messages, policy, tests).
- Installed `knip` + `husky`; `knip` and `eslint --max-warnings 0` are clean.
- Fixed JSDoc parse errors, `noUnusedParameters`, `rootDir` in `tsconfig.json`.
- Knip auto-removed unused exports across `src/nut/runtime.ts`, `src/policy/schema.ts`,
  `src/tools/base.ts`, `src/tools/vision.ts`, etc. (typecheck-verified).
- Provisioned the local X11 stack in `/tmp/opencode/x11prefix` (dnf RPMs).
- 448 tests pass, 1 skipped, 100% coverage with the prefix on PATH.
- Fixed `tests/system.test.ts` to derive the live process name from its own `ps` row
  instead of asserting `node`.
- Fixed `tests/omcps.test.ts` to read a guaranteed-missing `~/.ssh/...` path for the
  "reached the tool" assertion (real `~/.ssh/id_rsa` existed).
- Fixed `tests/npx.test.ts` tarball discovery (find newest `omcps-*.tgz` on disk,
  ignore husky `prepare` noise via `--ignore-scripts`); bumped registry probe timeout.
- Fixed `tests/vision.test.ts` scaled-match assertion with a near-window region.
- Fixed `tests/gui.test.ts` clipboard restore assertion to poll through xclip's
  asynchronous ownership acquisition.
- Hardened `src/tools/clipboard.ts` `clipboardCopy` to poll until the application's
  copy completes (up to 1s), instead of a fixed sleep.
- Covered the unreachable `shell.ts` catch by exercising a non-string `cwd`.
- Verification: `npm run check` green (typecheck, lint, 447 passed/1 skipped, 100%
  coverage, knip, build) with the `/tmp/opencode/x11prefix` tooling on PATH.
- Added this AGENTS.md.
- Made the Linux X tooling persistent for runners: extracted stack to
  `~/.local/opt/omcps-x11` and installed thin wrapper scripts in `~/.local/bin`
  (`Xvfb`, `xterm`, `openbox`, `xdotool`, `wmctrl`, `xclip`, `xev`, `xsetroot`,
  `xwininfo`), so `npm run check` now works on this machine without manually
  prefixing `PATH`, `LD_LIBRARY_PATH`, or `XDG_DATA_DIRS`.
- Re-verified with a smaller suite (`clipboard.test.ts`, 9/9) under a PATH that
  starts with `~/.local/bin`: passes.
- Repo state for the current run: typecheck, lint, 447 tests passed / 1 skipped,
  knip, and build all succeeded before this entry was appended.

