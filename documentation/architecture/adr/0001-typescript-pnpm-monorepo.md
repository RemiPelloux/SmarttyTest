# ADR-0001: TypeScript pnpm monorepo, Node 22+/24 LTS

- **Status:** Accepted
- **Related:** ST-001, ST-002, PRD §4.2–4.3

## Context

The spec defines about 50 packages, from the core engines through adapters, AI and Studio. They need independent builds, strict typing and fast tests, and they must publish to npm.

## Decision

- **pnpm workspaces** with `workspace:*` dependencies. Package manager pinned via `packageManager`.
- **TypeScript strict** (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`), ESM only, `NodeNext` resolution. Build with `tsc -b` project references.
- **Vitest** for SmartTest's own tests. Workspace packages resolve to sources through the `@smarttest/source` export condition, so tests don't need a build.
- **Biome** for lint and format (one fast tool).
- **Node `>=22.12`** (Node 22 and 24 LTS in CI). Node 26 will be added to the matrix when it reaches LTS.
- Package map in `scripts/packages.manifest.json`. `pnpm scaffold:package` generates package boilerplate and rejects dependency cycles.
- Only the 1.0 packages are scaffolded. Later packages are added when their epic starts.

## Consequences

- The CLI ships as `smarttest`. Internal packages are `@smarttest/*` and private until their APIs are stable.
- ESM only. We may need to consider CJS consumers of the Plugin SDK later.
- Choosing Biome over ESLint means fewer plugin rules. We accept that.

## Alternatives considered

- Nx or Turborepo on top of pnpm: may be added later for remote caching. Not needed at this size.
- ESLint + Prettier: slower and needs more config. Biome is enough for now.
