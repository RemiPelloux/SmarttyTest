# Delivery log: 0.3.0 to 0.8.0

What was actually delivered against the [roadmap](roadmap.md), sprint by sprint. The foundation sprints S0 to S10 (0.1.0 and 0.2.0) are in the [foundation backlog](foundation/sprints.md). Planning is in story points; one sprint is about 40 points. There are no dates: a sprint is a unit of work, and a version ships when its gate is met or the gap is written down.

Status words: **done** (shipped and tested), **partial** (shipped with a stated gap), **moved** (re-planned in a later version), **not done** (dropped from the version, reason given).

## Summary

| Version                  | Sprints    | Planned | Delivered            | Moved / not done                      | Gate       | Tag                  |
| ------------------------ | ---------- | ------- | -------------------- | ------------------------------------- | ---------- | -------------------- |
| 0.3.0 Precise graph      | S11–S12    | 96      | 83                   | 13 moved to 0.8.0                     | met        | `v0.3.0` (`f85c053`) |
| 0.4.0 Complete graph     | S13–S14    | 92      | 84                   | 8 moved to 0.7.0                      | met        | `v0.4.0` (`ee220dc`) |
| 0.5.0 Runtime evidence   | S15–S16    | 71      | 58 done, 13 partial  | —                                     | partly met | `v0.5.0` (`03ee658`) |
| 0.6.0 Adoption           | S17–S18    | 66      | 35 done, 31 partial  | Next.js fixture moved to 0.7.0        | partly met | `v0.6.0` (`328b330`) |
| 0.7.0 Adaptation and E2E | S19–S20    | 84      | 76                   | 8 not done (TypeScript 7)             | met        | `v0.7.0` (`ec5d3a9`) |
| 0.8.0 Speed              | S21–S23    | 105     | 79 done, 13 partial  | 13 not done (type-checker resolution) | not met    | `v0.8.0` (`a5d958f`) |
| Total                    | 13 sprints | 514     | 415 done, 57 partial | 42                                    |            |                      |

Tests grew from 124 (0.2.0) to 272 (0.8.0); the regression harness grew from 4 to 9 fixtures, all at 0 missed failures in BALANCED and SAFE mode.

## S11–S12 · 0.3.0 Precise graph

Goal: select by method, not by class.

| Story                                                                                                                | Pts | Status         |
| -------------------------------------------------------------------------------------------------------------------- | --- | -------------- |
| Member-level resolution through local inference (`new X()`, annotations, constructor parameter properties, `this.p`) | 21  | done           |
| Method-level propagation                                                                                             | 13  | done           |
| Inheritance, overrides, `super.m()`                                                                                  | 8   | done           |
| CommonJS at symbol level                                                                                             | 13  | done           |
| Re-export hardening                                                                                                  | 8   | done           |
| Graph diff between revisions                                                                                         | 8   | done           |
| `graph why`, `graph cycles`, `graph orphans`                                                                         | 8   | done           |
| Per-test decision confidence                                                                                         | 4   | done           |
| Persistent graph with incremental patches                                                                            | 13  | moved to 0.8.0 |

Result: a change to `TokenManager.verify` no longer selects the tests that only use `issue`. LeadsIt measured with 0.5.0.

## S13–S14 · 0.4.0 Complete graph

Goal: edges for what is not TypeScript code.

| Story                                                           | Pts | Status         |
| --------------------------------------------------------------- | --- | -------------- |
| Environment keys (`.env*` key-level diffs)                      | 13  | done           |
| Assets read through `fs`                                        | 8   | done           |
| Wasp operations (`wasp/client/operations` → `main.wasp.ts`)     | 13  | done           |
| Prisma models and enums                                         | 13  | done           |
| Translation keys                                                | 8   | done           |
| Test infrastructure: snapshots, `__mocks__`, `import.meta.glob` | 8   | done           |
| Mock awareness (factory mocks)                                  | 13  | done           |
| Generated code (`generated[].from`)                             | 8   | done           |
| Next.js route conventions                                       | 8   | moved to 0.7.0 |

Result: `edges-vitest` fixture with one targeted test per edge type and seven seeded regressions.

## S15–S16 · 0.5.0 Runtime evidence

Goal: combine static analysis with what tests actually run.

| Story                                                                      | Pts | Status                                      |
| -------------------------------------------------------------------------- | --- | ------------------------------------------- |
| `smarttest trace`: per-test-file V8 coverage for Vitest, Jest, `node:test` | 21  | done                                        |
| Trace invalidation by file hashes and runtime fingerprint                  | 8   | done                                        |
| Hybrid selection (traces rule out in FAST/BALANCED, only add in SAFE)      | 8   | done                                        |
| Unprotected changes in `impact`                                            | 13  | partial: unit level, no line-level coverage |
| Shadow Mode (`smarttest shadow`, `--report`)                               | 13  | done                                        |
| `benchmark --since/--sample/--resume/--traces`                             | 8   | done                                        |

Gate: 0 missed failures over 12 + 40 LeadsIt commits; observed execution removed 1 of 11 test files on LeadsIt, short of the 20% target. Translation-namespace false positives found on LeadsIt were fixed (one commit went from 37 selected files to 4).

## S17–S18 · 0.6.0 Adoption

Goal: set up in any repository and any CI without editing configuration.

| Story                                                                    | Pts | Status                                                                                                                  |
| ------------------------------------------------------------------------ | --- | ----------------------------------------------------------------------------------------------------------------------- |
| npm publish with SBOM and `npm audit`                                    | 5   | partial: SBOM and audit in `release:pack`; publishing waits for the name decision (ADR-0007)                            |
| `smarttest hook install/uninstall/status`                                | 8   | done                                                                                                                    |
| `smarttest ci`                                                           | 8   | done                                                                                                                    |
| Per-project conventions (`projects`)                                     | 8   | done                                                                                                                    |
| Cold start under one second at 2,000 modules                             | 13  | partial: worker threads, parallel discovery, default-pattern discovery; LeadsIt cold scan 5.5 s → 3.6 s; target not met |
| Adaptive policy                                                          | 5   | done                                                                                                                    |
| Fixtures React, Next.js, Yarn, TS library, Wasp; three operating systems | 13  | partial: React, TS library, Yarn added; Next.js moved to 0.7.0; macOS and Windows not validated                         |
| Documentation snippets executed by tests                                 | 6   | done                                                                                                                    |

Gate: commander.js, path-to-regexp, ufo, defu and LeadsIt set up with `init --yes`, 0 missed failures ([results](../case-studies/external-repositories.md)). Bugs found on the way: fluent methods returning `this`, `node --test` directory globs, a local `t` mistaken for a translation function.

## S19–S20 · 0.7.0 Adaptation and E2E

Goal: stay correct when the project changes shape; select end-to-end specs.

| Story                                      | Pts | Status                                                                          |
| ------------------------------------------ | --- | ------------------------------------------------------------------------------- |
| `smarttest sync [--check]`, `doctor --fix` | 13  | done                                                                            |
| `smarttest migrate --to vitest`            | 8   | done                                                                            |
| `smarttest watch`                          | 13  | done                                                                            |
| Playwright adapter                         | 13  | done                                                                            |
| E2E mapping (visited URLs → routes)        | 13  | done                                                                            |
| Next.js `app/` and `pages/` conventions    | 8   | done                                                                            |
| Cypress adapter                            | 8   | done, not validated against a real Cypress install                              |
| TypeScript 7 native API                    | 8   | not done: TypeScript 7 has no parser API usable from Node; watch item for 1.0.0 |

Gate: met (`integration-tests/adaptation.test.ts`; `next-playwright` fixture; Playwright benchmark with 0 missed failures).

## S21–S23 · 0.8.0 Speed

Goal: run what remains faster.

| Story                                     | Pts | Status                                                                    |
| ----------------------------------------- | --- | ------------------------------------------------------------------------- |
| Validated result cache                    | 21  | done                                                                      |
| Fail-fast ordering, `--bail`              | 8   | done                                                                      |
| Parallel runner groups                    | 13  | done (CPU budget; memory not budgeted separately)                         |
| Sharding                                  | 8   | done                                                                      |
| Flaky analytics                           | 13  | done                                                                      |
| Subversion and Mercurial adapters         | 16  | done                                                                      |
| Persistent graph with incremental patches | 13  | partial: in-memory patches in `watch` (under 1 ms); not persisted to disk |
| Type-checker resolution                   | 13  | not done; moved after 1.0.0                                               |

Gate: not met. LeadsIt's 12-commit replay went from 47.2 s to 43.4 s (8% less, target 30%), 0 cache-integrity violations. A repeated run of an unchanged state on LeadsIt takes 1.2 s instead of 4.1 s (93 of 100 test files from the cache).

## Carried into 0.9.0 and 1.0.0

| Item                                                                                                    | From         | Now in                      |
| ------------------------------------------------------------------------------------------------------- | ------------ | --------------------------- |
| Publish on npm                                                                                          | 0.6.0        | 1.0.0 (blocked on ADR-0007) |
| Validate on macOS and Windows                                                                           | 0.6.0        | 1.0.0                       |
| Cold start under one second at 2,000 modules; persist the graph to disk                                 | 0.6.0, 0.8.0 | 1.0.0 performance story     |
| Validate the Cypress adapter on a real install                                                          | 0.7.0        | 1.0.0                       |
| 30% speed target and 20% observed-execution target, re-measured on the published benchmark repositories | 0.5.0, 0.8.0 | 1.0.0 benchmarks            |
| TypeScript 7                                                                                            | 0.7.0        | watch item, 1.0.0           |
| Type-checker resolution                                                                                 | 0.3.0, 0.8.0 | after 1.0.0                 |
