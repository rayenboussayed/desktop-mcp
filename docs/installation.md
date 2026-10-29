# Installation

## From npm

```bash
npm install -g desktop-mcp
```

Run it directly without a global install:

```bash
npx desktop-mcp@latest --allow-all
```

### From a local tarball

Until the package is published, install from the locally built tarball:

```bash
npm run build
npm pack
npx --package=./desktop-mcp-0.4.0.tgz desktop-mcp --allow-all
```

### From source

```bash
git clone https://github.com/rayenboussayed/desktop-mcp.git
cd desktop-mcp
npm install
npm run build
```

Run the compiled server:

```bash
node dist/bin/omcps.js --allow-all
```

## Optional runtime dependencies

```bash
npm install @nut-tree-fork/nut-js
npm install tesseract.js @tesseract.js-data/eng
npm install jimp
```

Install `ffmpeg` at the operating-system level for MP4 recording.

## Verify the installation

```bash
desktop-mcp --version
desktop-mcp --help
desktop-mcp --policy-show
```

A policy-show command exits without starting an MCP transport and prints the effective
permission set.
EOF