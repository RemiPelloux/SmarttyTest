# Roadmap: 0.2.0 to 1.0.0

1.0.0 is the version we can recommend for any TypeScript/JavaScript repository: selection precise enough to matter on large codebases, never wrong in a way that hides a failure, fast enough to sit in a pre-commit hook, and installable from npm.

The dependency graph is the product. Most of this roadmap makes it more precise (fewer tests run for the same safety) and more complete (fewer relationships SmartTest cannot see).

Planning is in story points. One sprint is about 40 points. Each version has an exit gate; a version ships when the gate is met, not on a date.

## Where 0.2.0 stands

- Done: the [foundation backlog](foundation/README.md) (386 of 422 points), plus everything the LeadsIt migration exposed ([case study](../case-studies/leadsit.md)).
- Graph today: file and top-level-symbol nodes; static `import`/`require`/re-export edges; barrels; workspace `exports`; statically evaluated computed imports. A change inside a method selects every test that uses the enclosing class.
- Known gaps, all scheduled below: no type information (method calls are not resolved), no edges for configuration, environment variables, assets, framework conventions or database schemas, no runtime evidence, graph rebuilt on every run.

## Overview

| Version | Theme              | Points | Gate                                                                              |
| ------- | ------------------ | ------ | --------------------------------------------------------------------------------- |
| 0.3.0   | Precise graph      | 96     | Method-level selection on the fixtures and LeadsIt, 0 missed failures             |
| 0.4.0   | Complete graph     | 92     | Config, env, assets, framework and schema changes select only their readers       |
| 0.5.0   | Runtime evidence   | 71     | Observed edges reduce selection by 20% or more, with Shadow Mode at 0 misses      |
| 0.6.0   | Adoption           | 66     | Installed from npm and adopted in five external repositories without config edits |
| 0.7.0   | Adaptation and E2E | 76     | Projects that change shape stay correct; Playwright and Cypress selection         |
| 0.8.0   | Speed              | 79     | 30% less test time than 0.7 on the benchmark repositories                         |
| 0.9.0   | Interfaces         | 76     | Studio and VS Code cover run, explain, impact and coverage                        |
| 1.0.0   | Stable             | 52     | Frozen contracts, published benchmarks, security review                           |
|         | Total              | 608    | About 15 sprints                                                                  |

## Graph model at 1.0.0

| Layer          | 0.2.0                                                         | 1.0.0                                                                                                         |
| -------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Nodes          | files, top-level symbols, tests                               | plus methods, properties, routes, operations, env keys, schema models, i18n keys, assets, fixtures, snapshots |
| Code edges     | imports, re-exports, barrels, references to top-level symbols | plus type-resolved calls, member access, inheritance and overrides, DI injection                              |
| Non-code edges | none                                                          | config, environment, assets, framework conventions, database schema, translations, test infrastructure        |
| Evidence       | static only                                                   | static, type-checked and observed at runtime, each edge with provenance and confidence                        |
| Storage        | rebuilt from cached analyses on every run                     | persistent, patched incrementally, diffable between revisions                                                 |
| Queries        | dependents, dependencies, export                              | plus shortest path (`why`), cycles, orphans, untested code, graph diff                                        |

Every new edge type follows the same rules as today: if SmartTest cannot evaluate a relationship, it records uncertainty and selects the test instead of guessing.

---

## 0.3.0: Precise graph (96 pts)

Selection moves from "the class changed" to "this method changed, these callers use it".

| Story                                                                                                                                                                                                            | Pts |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| Type-aware call resolution: build a TypeScript program per project on demand (changed files and their dependents only) and resolve `obj.method()`, property access and constructor calls to the declaring member | 21  |
| Method-level propagation: when every reference to a member is resolved, propagate at member granularity; otherwise fall back to the enclosing class, and record why                                              | 13  |
| Inheritance and overrides: a change to a base method reaches subclasses that do not override it; a change to an override reaches only callers typed with the subclass                                            | 8   |
| CommonJS at symbol level: `module.exports = { a, b }`, `exports.a =` and destructured `require` become named exports instead of whole-file edges                                                                 | 13  |
| Re-export hardening: `export * as ns`, default re-exports, `export =`, TS path aliases through barrels, circular barrels                                                                                         | 8   |
| Persistent graph with incremental patches: store nodes and edges, patch only the files that changed (graph update under 10 ms for a single-file change at 2,000 modules)                                         | 13  |
| Graph diff between revisions: an import added or removed by the change is itself a change, so new dependents are selected                                                                                        | 8   |
| Queries: `graph why <a> <b>` (shortest path with evidence), `graph cycles`, `graph orphans` (code no test reaches)                                                                                               | 8   |
| Decision confidence: combine edge confidences into a per-test confidence shown in `explain` and the report                                                                                                       | 4   |

**Gate:** on the fixtures and on LeadsIt, the number of selected tests drops (measured by `benchmark`) with 0 missed failures; the method-level fixture proves a change to one method does not select tests of sibling methods.

## 0.4.0: Complete graph (92 pts)

Changes that are not TypeScript code currently fall back to whole files, whole projects or "not analysed". Each of these gets real edges.

| Story                                                                                                                                                                                    | Pts |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| Environment edges: `process.env.X`, `import.meta.env.X` and config loaders create edges per key; editing one key in `.env.*` selects only its readers                                    | 13  |
| Asset edges: JSON, YAML, CSS, SQL and text imports; `fs.readFile` / `readFileSync` with statically evaluable paths (same evaluator as computed imports)                                  | 8   |
| Framework conventions: Next.js `app/` and `pages/` routes and middleware, Wasp `main.wasp(.ts)` operations, actions and pages, NestJS module/provider injection, Express router mounting | 21  |
| Database schema: Prisma models and fields linked to `prisma.<model>.*` usage, so a schema change selects only code using the changed models                                              | 13  |
| Translations: `t("key")` and similar calls linked to locale files per key                                                                                                                | 8   |
| Test infrastructure: setup files, global mocks, fixtures and snapshot files linked to the tests that use them                                                                            | 8   |
| Mock awareness: a test that mocks module M depends on M's exported signature only, not its implementation; implementation-only changes in M skip it                                      | 13  |
| Generated code: `rebuild-required` policy maps generator inputs to outputs (completes ST-043)                                                                                            | 8   |

**Gate:** each edge type has a fixture where a targeted change selects only the affected tests, and the regression harness stays at 0 missed failures with these edges enabled.

## 0.5.0: Runtime evidence (71 pts)

Static analysis says what can be reached; runtime traces say what is actually executed. The combination is both safer and tighter.

| Story                                                                                                                                                        | Pts |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --- |
| Per-test-file V8 coverage for Vitest, Jest and `node:test`, stored as observed-execution edges with source and environment fingerprints                      | 21  |
| Trace invalidation: a trace is used only while its fingerprints match; stale traces are dropped, never reused                                                | 8   |
| Hybrid selection: union of static and observed evidence, both shown in `explain`                                                                             | 8   |
| Changed-line coverage and a missing-protection report (changed code no test reaches)                                                                         | 13  |
| Shadow Mode: `smarttest shadow` runs the full suite periodically (locally or in any CI), compares with what SmartTest would have selected, and reports drift | 13  |
| `benchmark --since <ref>` over hundreds of commits with sampling and resume                                                                                  | 8   |

**Gate:** on the benchmark repositories, observed edges reduce selection by 20% or more while Shadow Mode reports 0 missed failures over at least 200 commits.

## 0.6.0: Adoption (66 pts)

Make the first ten minutes trivial, in any repository and any CI system. No dependency on a hosted CI provider.

| Story                                                                                                                                                                      | Pts |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| Publish `smarttest` on npm (name decision, ADR-0007) with a local release script, `npm audit` and an SBOM in `release:pack`                                                | 5   |
| `smarttest hook install` / `uninstall` for husky, lefthook, simple-git-hooks and plain `.git/hooks`, writing a marked block; `init` offers it and shows the replaced steps | 8   |
| `smarttest ci`: detect the CI environment (GitLab, Jenkins, CircleCI, Azure, Bitbucket, generic), pick the base ref, deepen shallow clones, write JUnit and Markdown       | 8   |
| Per-project conventions: layout, naming and rules per sub-project (LeadsIt mixes colocated and `__tests__/`)                                                               | 8   |
| Cold start under one second at 2,000 modules: parse in worker threads, read runner include patterns statically before falling back to listing                              | 13  |
| Adaptive policy: skip analysis when the recorded full-run time is lower than the expected analysis time (PRD §31.5)                                                        | 5   |
| Fixtures: React, Next.js, Yarn ESM, TypeScript library, Wasp; validated on Linux, macOS and Windows                                                                        | 13  |
| Documentation snippets executed by the test suite                                                                                                                          | 6   |

**Gate:** five external repositories initialised with `init --yes` and no config edits; `benchmark` reports 0 missed failures on all five.

## 0.7.0: Adaptation and E2E (76 pts)

| Story                                                                                                                                        | Pts |
| -------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| `smarttest sync [--check]`: detect new projects, runners, aliases or a VCS change and propose a config update; `doctor --fix` for safe fixes | 13  |
| `migrate` between runners (Jest to Vitest) keeping rules and history                                                                         | 8   |
| `smarttest watch`: rerun affected tests on save using graph patches                                                                          | 13  |
| Playwright adapter: discovery, file selection, traces linked in the report                                                                   | 13  |
| E2E mapping: routes and pages (from 0.4.0 framework edges) to the E2E specs that visit them                                                  | 13  |
| Cypress adapter                                                                                                                              | 8   |
| TypeScript 7 native API behind `language-typescript`, TypeScript 6 kept as fallback                                                          | 8   |

**Gate:** a fixture that adds a package, switches runner and adopts Git mid-history needs no manual re-init; Playwright selection is validated with `benchmark`.

## 0.8.0: Speed (79 pts)

Run less (graph), then run what remains faster.

| Story                                                                                                                                                              | Pts |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --- |
| Validated result cache, content-addressed on test, transitive sources, dependencies, config, runtime and adapter version; cached results always reported as cached | 21  |
| Fail-fast ordering: run the tests closest to the change in the graph and those that failed recently first                                                          | 8   |
| Duration-aware scheduling: run independent runner groups in parallel within a CPU and memory budget                                                                | 13  |
| Sharding: `smarttest shard --total n --index i`, balanced by recorded durations                                                                                    | 8   |
| Flaky analytics: failure history, rate, quarantine suggestions (never silent skips)                                                                                | 13  |
| SVN and Mercurial adapters behind the existing VCS contract                                                                                                        | 16  |

**Gate:** 30% less test time than 0.7 on the benchmark repositories, with 0 cache-integrity violations.

## 0.9.0: Interfaces (76 pts)

| Story                                                                                                                    | Pts |
| ------------------------------------------------------------------------------------------------------------------------ | --- |
| `smarttest studio`: local web app bound to loopback with a session token; overview and test explorer                     | 21  |
| Impact map: interactive graph with path highlighting, filters and export                                                 | 13  |
| Live runner and coverage viewer (annotated source, changed lines)                                                        | 21  |
| VS Code extension: "protected by N tests" on each symbol, run affected tests for the current file, explanations on hover | 21  |

**Gate:** run, explain, inspect impact and read coverage without the CLI; local security review passed.

## 1.0.0: Stable (52 pts)

| Story                                                                                                            | Pts |
| ---------------------------------------------------------------------------------------------------------------- | --- |
| Plugin SDK 1.0: frozen adapter contracts (language, runner, VCS, edge providers), conformance kit, documentation | 13  |
| Freeze public contracts: config schema, exit codes, `--json` schemas; semver policy and migration notes          | 5   |
| Published benchmarks on at least five real repositories, LeadsIt included, with 0 missed failures                | 13  |
| Performance on a 10,000-module repository: warm analysis under one second                                        | 8   |
| Security review: file writes, process execution, Studio                                                          | 8   |
| Documentation complete                                                                                           | 5   |

**Gate:** all of the above, and no open defect that can make a failing test be skipped.

---

## Not before 1.0.0

- AI test generation and audit (PRD Release 3): 2.0.0, built on the generator's `it.todo` scaffolds. The deterministic core never depends on it (ADR-0004).
- Cloud and team analytics (PRD Release 5).
- Other languages (PRD Release 6). The edge-provider SDK in 1.0.0 is designed for them.

Working agreements: [Definition of Ready and Done](definition-of-ready-and-done.md) · [risks](risks.md).
