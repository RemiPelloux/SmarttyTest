# Contributing to SmartTest

Thanks for helping! SmartTest is pre-1.0, so the most valuable contributions follow the [v1.0.0 plan](documentation/planning/release-1.0.0/README.md).

## Setup

```bash
git clone <repo> && cd SmarttyTest
corepack enable          # provides the pinned pnpm (or use: npx pnpm@12 …)
pnpm install
pnpm verify              # lint · boundaries · typecheck · test · planning consistency
```

Requirements: Node **22.12+** (24 LTS recommended, see `.nvmrc`).

## Picking work

1. Find a story in [epics](documentation/planning/release-1.0.0/epics/README.md) or in GitHub issues (`ST-###`).
2. Check it meets the **Definition of Ready**: its dependencies are done and its ACs are clear.
3. Comment on the issue to claim it.

## Making changes

- Branch from `main`: `st-062-explain-command`.
- Reference the story in commits and the PR: `feat(impact): explain skipped tests (ST-062)`. We use [Conventional Commits](https://www.conventionalcommits.org/).
- Add a Changeset for user-visible changes (`pnpm changeset`, enabled in ST-099).
- Meet the [Definition of Done](documentation/planning/release-1.0.0/definition-of-ready-and-done.md).

### Things that need extra care

| Area                                    | Why                     | Requirement                                                     |
| --------------------------------------- | ----------------------- | --------------------------------------------------------------- |
| `impact-engine`, `rules-engine`         | Selection safety        | 2 approvals. Regression harness green                           |
| `report-engine`                         | Honesty of results      | Report integrity suite green                                    |
| Anything writing files in user projects | Non-destructive promise | Dry-run path, atomic write, test proving nothing is overwritten |
| Exit codes, JSON schemas                | Public contract         | Treated as breaking changes                                     |

## Repository tooling

| Command                          | Purpose                                                                                        |
| -------------------------------- | ---------------------------------------------------------------------------------------------- |
| `pnpm scaffold:package --all`    | Regenerate package boilerplate from `scripts/packages.manifest.json` (never overwrites `src/`) |
| `pnpm planning:build`            | Regenerate planning docs from `backlog.data.mjs`. Validates dependencies and capacity          |
| `pnpm planning:issues [--apply]` | Create GitHub labels, milestones and issues from the backlog                                   |
| `pnpm assets:build`              | Regenerate animated README SVGs                                                                |
| `pnpm check:boundaries`          | Enforce package boundaries and the local-first rules (ADR-0004)                                |
| `pnpm bundle:cli`                | Build the self-contained `smarttest` package into `packages/cli/.publish`                      |
| `node benchmarks/run.mjs`        | Run the performance benchmarks                                                                 |

## Proposing bigger changes

Open an issue first. For architectural changes, add an ADR (`documentation/architecture/adr/template.md`).

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).
