# desktop-mcp documentation

`desktop-mcp` is a local [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server
that gives an AI controlled access to your operating system:

- mouse, keyboard, clipboard
- screen capture, OCR, image search, colour search, screen recording
- window management
- files, directories, search and editing
- shell commands
- process and system information
- read-only web search / page fetching

Everything runs on your computer. The only network use is in `web_search` and `fetch_url`,
and those are off unless you allow them.

## Documentation map

- [Prerequisites](./prerequisites.md)
- [Installation](./installation.md)
- [Quick start](./quick-start.md)
- [CLI reference](./cli.md)
- [Permissions model](./permissions.md)
- [Configuration files](./configuration.md)
- [Tools reference](./tools.md)
- [Platform support](./platform-support.md)
- [OCR, image and colour search](./ocr-image-colour.md)
- [Recording](./recording.md)
- [Automation and screen regions](./regions-and-windows.md)
- [Security hardening](./security.md)
- [Troubleshooting](./troubleshooting.md)
- [Architecture](./architecture.md)
- [Development and testing](./development.md)
- [FAQ](./faq.md)

## Important safety note

`desktop-mcp` is a tool interface, not an operating-system sandbox. A tool such as
`run_command` runs with your user's rights, and path checks do not apply to what a shell
command touches. Start with narrow flags, use `--ask-shell`, `--allow-command`, or a policy
file before giving broad access.

## Current version

The documented version is `0.4.0`. See `package.json` and `CHANGELOG`/release notes for
exact changes.
EOF