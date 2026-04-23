# Seojeom MCP Server

Local-first MCP server for Claude and Codex project wiki and graph workflows.

> Preview status
> This package is published and installable today, but it is still a preview release rather than a stable general-availability product. Tool behavior, playbooks, packaging, and release automation may change between versions while the standalone MCP workflow is being stabilized.

## Install

### Claude Desktop

Add this to `claude_desktop_config.json` and restart Claude Desktop:

```json
{
  "mcpServers": {
    "seojeom": {
      "command": "npx",
      "args": [
        "-y",
        "@seojeom/mcp-server",
        "--project-root", "<project-root>",
        "--project-id", "<project-id>",
        "--graph-authority", "local-snapshot",
        "--approval-mode", "prompt"
      ]
    }
  }
}
```

Config file location:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\\Claude\\claude_desktop_config.json`

### Claude Code CLI

```bash
claude mcp add seojeom -- npx -y @seojeom/mcp-server \
  --project-root . \
  --project-id demo-project \
  --graph-authority local-snapshot \
  --approval-mode prompt
```

### One-click install

The GitHub Releases page includes a `.mcpb` Desktop Extension bundle for Claude Desktop.

## What it exposes

- project-local wiki tools under `<project-root>/wiki`
- local graph snapshot tools under `<project-root>/.seojeom/graph`
- deterministic playbooks and session-prep helpers for documentation, repair, and relation fill-in
- approval-gated mutation flows for wiki and graph changes

All tools use the `seojeom_*` namespace.

## Repository scope

This repository only contains the MCP package source and release metadata:

- `src/` TypeScript source
- `bin/seojeom-mcp` CLI entrypoint
- `manifest.json` Claude Desktop Extension manifest
- `registry-server.json` MCP Registry submission payload
- `server.json` package metadata used by the published npm package

Desktop app code, Tauri app code, internal scripts, and other monorepo artifacts are intentionally excluded from this public repository.

## Local development

```bash
npm install
npm run build
node dist/standalone.js \
  --project-root . \
  --project-id demo-project \
  --graph-authority local-snapshot \
  --approval-mode prompt
```

To build the Desktop Extension bundle locally:

```bash
npm install
npm run build
npx @anthropic-ai/mcpb pack
```

By default `mcpb pack` writes `mcp-server.mcpb` in the repository root.

## Package

- npm: `@seojeom/mcp-server`
- MCP Registry id: `io.github.seojeom/seojeom-mcp`
- License: MIT
