# Instructions for coding agents

SmartTest selects the tests a change can affect in TypeScript/JavaScript repositories and runs them through Jest, Vitest or `node --test`.

## Sources of truth

1. [`documentation/product/PRD.md`](documentation/product/PRD.md): specification. Cite sections as `§11.4`.
2. [`documentation/architecture/adr/`](documentation/architecture/adr/README.md): accepted decisions.
3. [`documentation/planning/roadmap.md`](documentation/planning/roadmap.md): what to build next, in points, with exit gates.
4. [`scripts/packages.manifest.json`](scripts/packages.manifest.json): packages and their allowed dependencies.

## Rules

- Never report a skipped test as passed, never treat an unresolved relationship as unrelated, never merge partial coverage into full coverage (§32.2). When unsure, select the test.
- Never write outside `.smarttest/` in a user project without a dry-run path and explicit approval. Writes are atomic.
- No network calls and no `ai-*`, `studio-*` or `cloud-*` dependencies at or below `packages/core` (ADR-0004).
- Adapters declare capabilities; never emulate a missing one (ADR-0005).
- Errors are `SmartTestError` with a stable `code`, a `category` and a `hint`. Exit codes are a public contract (`packages/shared/src/errors.ts`).
- Every new graph edge type needs a fixture where a targeted change selects only the affected tests, and must keep the regression harness at 0 missed failures.

## Workflow

```bash
pnpm install
pnpm verify                 # must pass before you finish (also run by the pre-push hook)
pnpm scaffold:package <n>   # after adding a package to the manifest
pnpm planning:build         # after editing backlog.data.mjs; never edit generated planning files
pnpm assets:build           # after editing scripts/brand/build-readme-assets.mjs; never edit the SVGs
```

- TypeScript strict, ESM, `NodeNext`. Import with the `.js` suffix; use `import type` for types.
- Tests are colocated as `*.test.ts` (Vitest). Integration tests live in `integration-tests/` and use `fixtures/projects/`.
- The formatter rewraps code, so verify scripted search-and-replace edits actually applied.
- Follow the [Definition of Done](documentation/planning/definition-of-ready-and-done.md).
