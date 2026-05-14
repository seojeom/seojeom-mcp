# Seojeom MCP Server

Canonical repo location: `packages/seojeom-mcp`

During the Godot-only decommission transition, `apps/desktop/mcp-server` may already be absent. New work should treat this package path as the source of truth. If a deprecated local lane still needs the old path to exist, recreate the minimal metadata-wrapper with `pnpm apply:legacy-compat-wrapper`.

Local-first MCP server for Claude and Codex.

`seojeom-mcp` binds to the project currently opened by the Seojeom desktop app or Godot launcher through a shared registry directory, then serves that project's local wiki and graph data over stdio.

## Quickstart

### Claude Code

```bash
claude mcp add -s local \
  -e SEOJEOM_SHARED_REGISTRY_DIR=/mnt/c/Users/<you>/.seojeom/registry \
  seojeom -- npm exec --yes --package=seojeom-mcp seojeom-mcp -- \
  --router \
  --host-kind auto \
  --approval-mode prompt
```

### Claude Desktop

Add this to `claude_desktop_config.json` and restart Claude Desktop:

```json
{
  "mcpServers": {
    "seojeom": {
      "command": "npm",
      "env": {
        "SEOJEOM_SHARED_REGISTRY_DIR": "<shared-registry-dir>"
      },
      "args": [
        "exec",
        "--yes",
        "--package=seojeom-mcp",
        "seojeom-mcp",
        "--",
        "--router",
        "--host-kind", "auto",
        "--approval-mode", "prompt"
      ]
    }
  }
}
```

### Print the exact onboarding command first

```bash
npm exec --yes --package=seojeom-mcp seojeom-mcp -- --print-claude-onboarding
```

## What it provides

- project binding to the currently active desktop/Godot project
- local wiki read/search/write tools
- local graph read/search/query tools
- core graph mutation/proposal tools for local authoring tasks
- approval-gated mutating operations

The exact tool surface is discovered at runtime through MCP `tools/list`.

## Runtime contract

- primary transport: `stdio`
- primary install path: `npm exec --yes --package=seojeom-mcp seojeom-mcp --`
- recommended mode: shared-registry router mode
- expected runtime: Node `>=20.20.0`
- public npm package shape: standalone stdio entrypoint only

## Source build contract

Running `pnpm build` in this package is a dual-output build:

- `dist/index.js` and the rest of `dist/**` stay available as the local source/runtime HTTP sidecar surface used by Godot and other repo-local lanes
- `.public-package/dist/standalone.js` is the staged npm publish surface

After a successful build, you can verify both lanes with:

```bash
pnpm smoke:build-layout
```

Godot-side source verification can also run the local HTTP sidecar smoke directly from the canonical package root:

```bash
pnpm smoke:sidecar-health
```

## Surface tiers

`seojeom-mcp` is not one uniform surface. Treat these as separate contracts:

### 1. npm public package

- audience: external Claude/Codex users installing from npm
- transport: `stdio`
- mode: shared-registry router
- published shape: `LICENSE`, `README.md`, `bin/seojeom-mcp`, `dist/standalone.js`, `package.json`
- capability promise: public tools only
- non-goals: internal prompts, internal resources, full authoring harness, desktop UI shell

This is the only contract guaranteed by the published npm package.

### 2. local full runtime

- audience: local maintainers running from source
- transport: stdio plus local sidecar HTTP runtime paths
- profile: full authoring surface
- includes: prompts, resources, specialized graph/wiki authoring flows, internal playbooks

This source-tree runtime is intentionally larger than the public package.

### 3. desktop-coupled runtime

- audience: local desktop/Godot-integrated operation
- product default: app-bundled sidecar runtime
- depends on: shared registry writer, approval queue UI, review shell, sidecar health surface
- examples: approval review pane, desktop approval alerts, graph IPC bearer-token flows
- debug override: sidecar entry override is reserved for debug-only startup paths

These desktop-coupled capabilities are not part of the standalone npm guarantee.

## Registry

- MCP Registry identifier target: `io.github.seojeom/seojeom-mcp`
- planned publish mode: GitHub Actions Trusted Publishing + `npm publish --provenance`

## Notes

- This package is still a preview release and the tool surface may evolve between versions.
- Router mode is the recommended public path. Direct per-project standalone flags remain as a compatibility fallback.
- The public package defaults to a core authoring tool surface. Prompts, resources, and more specialized orchestration surfaces are reserved for non-public/internal profiles.
- Public package documentation intentionally stays focused on installation and end-user usage. Internal release automation and repository-specific operator workflows are not part of the package contract.

## Links

- Repository: `https://github.com/seojeom/seojeom-mcp`
- Issues: `https://github.com/seojeom/seojeom-mcp/issues`
- License: MIT
