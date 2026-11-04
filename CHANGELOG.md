# Changelog

## 1.0.2 - 2026-11-04

### Changed

- CLI parsing in `desktop-mcp` and `osagent` now uses `commander` rather than
  `node:util.parseArgs`.
- Runtime schema handling now imports `zod/compile` before schema-defining modules.
- Permission flags are registered through the shared `addPermissionOptions()` helper and
  normalized with kebab-case names for the policy layer.
- Removed v8 coverage ignores from CLI and MCP entrypoints; the associated branches are
  reached by integration tests.

### Documentation

- Synchronized public install docs with the npm registry (`1.0.1` published, `1.0.2` source-only).
- Added this changelog.

## 1.0.1 - 2026-11-03

### Added

- Wayland and display-less sessions return explicit tool-level errors instead of crashing
  the MCP server.
- Linux/X11 prerequisites and troubleshooting guidance.

### Changed

- Replaced the remaining `as any` / `as unknown` / `as never` casts with typed helpers.
- Added repository, bugs and author metadata for packaging.
- Added publish tooling (`.npmignore`) and the commit hook (`commitlint`).
- Documented current tooling and X11 verification requirements.
