# Contributing

## Setup

```bash
corepack enable          # pinned pnpm (or: npx pnpm@12 …)
pnpm install
pnpm hooks:install       # pre-push runs `pnpm verify`
pnpm verify              # lint, package boundaries, typecheck, tests, planning consistency
```

Node 22.12 or newer (24 recommended, see `.nvmrc`). This repository has no hosted CI: `pnpm verify` is the gate, locally and in the pre-push hook. Before a release, run it on Linux, macOS and Windows.

## Picking work

Take a story from the [roadmap](documentation/planning/roadmap.md) or an open issue. Check the [Definition of Ready](documentation/planning/definition-of-ready-and-done.md) first.

## Making changes

- Branch from `main`. Use [Conventional Commits](https://www.conventionalcommits.org/): `feat(graph): resolve method calls through the type checker`.
- Add a changeset for user-visible changes (`pnpm changeset`).
- Follow the [Definition of Done](documentation/planning/definition-of-ready-and-done.md).

Areas that need extra care:

| Area                                                | Why                                  | Requirement                                                         |
| --------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------- |
| `impact-engine`, `dependency-graph`, `rules-engine` | A wrong edge can skip a failing test | Fixture for the new behaviour; regression harness stays at 0 missed |
| `report-engine`                                     | Reports must not overstate results   | Report integrity suite passes                                       |
| Anything that writes files in user projects         | Must never overwrite user content    | Dry-run path, atomic write, a test proving nothing is overwritten   |
| Exit codes, `--json` schemas, config schema         | Public contracts                     | Treated as breaking changes                                         |

## Tooling

| Command                       | Purpose                                                                                        |
| ----------------------------- | ---------------------------------------------------------------------------------------------- |
| `pnpm scaffold:package --all` | Regenerate package boilerplate from `scripts/packages.manifest.json` (never overwrites `src/`) |
| `pnpm check:boundaries`       | Enforce package boundaries and the local-first rules (ADR-0004)                                |
| `pnpm planning:build`         | Regenerate the foundation backlog pages from `backlog.data.mjs`                                |
| `pnpm assets:build`           | Regenerate the SVG illustrations                                                               |
| `pnpm release:pack`           | Build the self-contained `smarttest` tarball                                                   |
| `node benchmarks/run.mjs`     | Performance benchmarks                                                                         |

Larger changes: open an issue first; architectural changes need an ADR (`documentation/architecture/adr/template.md`).

Code of conduct: [Contributor Covenant](CODE_OF_CONDUCT.md).
