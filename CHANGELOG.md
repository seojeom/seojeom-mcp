# Changelog

All notable changes to this package will be documented in this file.

The format is based on Keep a Changelog, and this package follows Semantic Versioning.

## [0.2.3] - 2026-04-22

### Changed

- Updated release bundle compare logic so stale simulated status plus a live `version-already-published` blocker now points operators at `npm version patch` and rebundling instead of rerunning the post-auth flow.
- Refreshed stable operator artifacts so `release-next-step.*`, `release-status-compare.*`, and the embedded `public-launch-handoff/*` stay aligned with the latest release bundle state.

### Notes

- No MCP runtime or tool surface changes. This release is focused on release-operator correctness after `0.2.2` was already live in npm.

## [0.2.2] - 2026-04-22

### Added

- Added `mcpName: io.github.seojeom/seojeom-mcp` to align with the MCP Registry identifier convention.
- Expanded npm keywords to cover novel-writing, creative-writing, continuity-tracking, worldbuilding, writer-tool, knowledge-graph, and korean-webnovel audiences.
- Shipped a `CHANGELOG.md` entry bundled in the published tarball for release provenance.

### Notes

- No runtime or tool surface changes. Metadata-only release to surface MCP Registry and discoverability fields on the npm registry page.

## [0.2.0] - 2026-04-22

### Added

- Published `@seojeom/mcp-server` as a public npm package.
- Added MIT license metadata and packaged `LICENSE`.
- Added public npm metadata for repository, homepage, bugs, and author.
- Added a public-facing README quickstart for Claude/Codex installation.
- Added local-first MCP surfaces for wiki, graph read/write, proposals, scenes, and deterministic graph workflow helpers.

### Changed

- Standardized the MCP tool namespace on `seojeom_*`.
- Updated package branding, CLI examples, and onboarding copy to align on `seojeom`.

### Notes

- Earlier `0.1.0` and `0.1.1` publish attempts were unpublished during initial release iteration. Public release continuity resumes from `0.2.0`.
