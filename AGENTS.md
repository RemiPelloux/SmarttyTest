# AGENTS.md — guidance for AI coding agents

You are working on **SmartTest**, a test-impact layer for TS/JS that runs on top of Jest and Vitest. Read this file before you change anything.

## Sources of truth (in order)

1. [`documentation/product/PRD.md`](documentation/product/PRD.md): the master specification. Cite sections as `§11.4`.
2. [`documentation/architecture/adr/`](documentation/architecture/adr/README.md): accepted decisions override convenience.
3. [`documentation/planning/release-1.0.0/backlog.data.mjs`](documentation/planning/release-1.0.0/backlog.data.mjs): user stories (`ST-###`) and their acceptance criteria. **Implement against a story and its ACs.**
4. [`scripts/packages.manifest.json`](scripts/packages.manifest.json): package map and allowed dependencies.

## Hard rules

- **Never** report a skipped test as passed, treat unknown as unrelated, or merge partial coverage into full coverage (§32.2). If you're unsure, widen the selection.
- **Never** write outside `.smarttest/` in user projects without a dry-run path and explicit approval. Use atomic writes.
- **No network calls** and **no `ai-*` / `studio-*` / `cloud-*` dependencies** at or below `packages/core` (ADR-0004).
- Adapters must **declare** capabilities. Never emulate a missing one (ADR-0005).
- Errors are `SmartTestError` with a stable `code`, a `category` and a `hint`. Exit codes are a public contract (`packages/shared/src/errors.ts`).
- Keep the scope to v1.0.0. AI, Studio, Cloud, SVN, tracing and watch mode are out of scope (see the charter).

## Workflow

```bash
pnpm install
pnpm verify                 # lint · boundaries · typecheck · tests · planning — must pass before you finish
pnpm scaffold:package <n>   # after adding a package to the manifest
pnpm planning:build         # after editing backlog.data.mjs (never edit generated epics/sprints/CSV)
pnpm assets:build           # after editing scripts/brand/build-readme-assets.mjs (never edit SVGs by hand)
```

- TypeScript strict, ESM, `NodeNext`. Import with the `.js` suffix. Use `import type` for types.
- Tests are colocated as `*.test.ts` (Vitest). Workspace packages resolve to source in tests.
- Generated files carry a `GENERATED` header. Change their generator instead.
- Update the story status in `backlog.data.mjs` (`implementation.overrides`) when you complete or partially complete a story.
- Scripted edits must be verified: the formatter rewraps code, so search-and-replace anchors go stale.
- Update the story status in `backlog.data.mjs` (`implementation.overrides`) when you complete or partially complete a story.
- Verify scripted edits: the formatter rewraps code, so search-and-replace anchors go stale.
- Follow the [Definition of Done](documentation/planning/release-1.0.0/definition-of-ready-and-done.md).
