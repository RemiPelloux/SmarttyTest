# Roadmap: 0.2.0 to 1.0.0

1.0.0 is the version we can recommend for any TypeScript/JavaScript repository: selection precise enough to matter on large codebases, never wrong in a way that hides a failure, fast enough to sit in a pre-commit hook, and installable from npm.

The dependency graph is the product. Most of this roadmap makes it more precise (fewer tests run for the same safety) and more complete (fewer relationships SmartTest cannot see).

Planning is in story points. One sprint is about 40 points. Each version has an exit gate; a version ships when the gate is met, not on a date.

## Where 0.2.0 stands

- Done: the [foundation backlog](foundation/README.md) (386 of 422 points), plus everything the LeadsIt migration exposed ([case study](../case-studies/leadsit.md)).
- Graph today: file and top-level-symbol nodes; static `import`/`require`/re-export edges; barrels; workspace `exports`; statically evaluated computed imports. A change inside a method selects every test that uses the enclosing class.
- Known gaps, all scheduled below: no type information (method calls are not resolved), no edges for configuration, environment variables, assets, framework conventions or database schemas, no runtime evidence, graph rebuilt on every run.

## Overview

| Version | Theme              | Points | Gate                                                                                            |
| ------- | ------------------ | ------ | ----------------------------------------------------------------------------------------------- |
| 0.3.0   | Precise graph      | 83     | Released (13 pts moved to 0.8.0): member-level selection, CommonJS symbols, graph queries       |
| 0.4.0   | Complete graph     | 84     | Released (8 pts moved to 0.7.0): env, asset, Wasp, Prisma, translation, mock and snapshot edges |
| 0.5.0   | Runtime evidence   | 71     | Released: traces, hybrid selection, Shadow Mode; reduction target not reached on LeadsIt        |
| 0.6.0   | Adoption           | 66     | Installed from npm and adopted in five external repositories without config edits               |
| 0.7.0   | Adaptation and E2E | 84     | Projects that change shape stay correct; Playwright and Cypress selection                       |
| 0.8.0   | Speed              | 105    | 30% less test time than 0.7 on the benchmark repositories                                       |
| 0.9.0   | Interfaces         | 76     | Studio and VS Code cover run, explain, impact and coverage                                      |
| 1.0.0   | Stable             | 52     | Frozen contracts, published benchmarks, security review                                         |
|         | Total              | 621    | About 16 sprints                                                                                |

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

## 0.3.0: Precise graph (96 pts planned, 83 delivered), released

Selection moves from "the class changed" to "this method changed, these callers use it".

| Story                                                                                                                                                                                                                                                             | Pts | Status                                                                              |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | ----------------------------------------------------------------------------------- |
| Member-level resolution: `obj.method()`, property access and construction resolved to the declaring member through local inference (`new X()`, `x: X`, constructor parameter properties, `this.p`); values that escape or whose class is unknown stay class-level | 21  | done                                                                                |
| Method-level propagation: methods and accessors are units of their own; constructor, field and heritage changes stay class-level                                                                                                                                  | 13  | done                                                                                |
| Inheritance and overrides: inherited members resolve to the base class, overrides only to the subclass, `super.m()` to the base member                                                                                                                            | 8   | done                                                                                |
| CommonJS at symbol level: `module.exports = { a, b }`, `exports.a =`, destructured and namespace `require`                                                                                                                                                        | 13  | done                                                                                |
| Re-export hardening: `export * as ns`, default re-exports, `export =`, circular barrels                                                                                                                                                                           | 8   | done                                                                                |
| Persistent graph with incremental patches                                                                                                                                                                                                                         | 13  | moved to 0.8.0: rebuilding from cached analyses stays under 200 ms at 2,000 modules |
| Graph diff between revisions: dependencies added or removed by the change, shown in `impact` and the decision                                                                                                                                                     | 8   | done                                                                                |
| Queries: `graph why <a> <b>`, `graph cycles`, `graph orphans`                                                                                                                                                                                                     | 8   | done                                                                                |
| Decision confidence: lowest edge confidence along the path, shown in reasons and `explain`                                                                                                                                                                        | 4   | done                                                                                |

Type-checker resolution for values local inference cannot type (return values of functions, generics) is moved to 0.8.0; until then those calls are class-level, which is safe.

**Gate:** method-level fixture passes (a change to `TokenManager.verify` no longer selects `AuthController`, which only reaches `issue`); regression harness at 0 missed failures. LeadsIt measurement after 0.5.0.

## 0.4.0: Complete graph (92 pts planned, 84 delivered), released

Changes that are not TypeScript code used to fall back to whole files, whole projects or "not analysed". Each of these now has real edges.

| Story                                                                                                                                                                                                                                                                                      | Pts | Status                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --- | -------------------------------------- |
| Environment edges: `process.env.X`, `process.env["X"]`, destructuring and `import.meta.env.X` create edges per key; editing one key in `.env*` selects only its readers. A key no code reads keeps the mandatory trigger                                                                   | 13  | done                                   |
| Asset edges: JSON, YAML, CSS, SQL and text imports (already tracked as files); `readFile` / `readFileSync` / `createReadStream` with paths built from `__dirname` or `import.meta`                                                                                                         | 8   | done                                   |
| Framework conventions: Wasp operations imported from `wasp/client/operations` and `wasp/server/operations` resolve to the implementation declared in `main.wasp.ts`. NestJS constructor injection is covered by parameter-property inference (0.3.0) and Express routers are plain imports | 13  | done                                   |
| Next.js `app/` and `pages/` route conventions and middleware                                                                                                                                                                                                                               | 8   | moved to 0.7.0, with E2E route mapping |
| Database schema: Prisma models and enums linked to `prisma.<model>`, `db.<model>`, Wasp `context.entities.<Model>` and type imports from `@prisma/client` / `wasp/entities`; datasource and generator changes widen to the schema's directory                                              | 13  | done                                   |
| Translations: `t("key")`, `t(\`prefix.${x}\`)`, `i18nKey`linked to catalog keys (TypeScript or JSON catalogs under`locales/`, `i18n/`, `lang/`, `translations/`, `messages/`); `t(variable)` reads any key                                                                                 | 8   | done                                   |
| Test infrastructure: snapshot files select their test, `__mocks__/x` selects the users of `x`, fixtures read through `fs` are asset edges, `import.meta.glob` is an import. Setup files stay mandatory triggers                                                                            | 8   | done                                   |
| Mock awareness: a test that replaces module M with a factory (`vi.mock` / `jest.mock` with a factory that does not load the original) does not run M; implementation changes in M, or in modules only reached through M, skip it. Signature changes still select it                        | 13  | done                                   |
| Generated code: `generated[].from` lists generator inputs; with `rebuild-required`, an input change stands for a change to the outputs and warns to regenerate                                                                                                                             | 8   | done                                   |

**Gate:** met. The `edges-vitest` fixture has one targeted change per edge type that selects only the affected tests (`integration-tests/edges.test.ts`), and its seven seeded mutations are in the regression harness with 0 missed failures in BALANCED and SAFE.

## 0.5.0: Runtime evidence (71 pts), released

Static analysis says what can be reached; runtime traces say what is actually executed.

| Story                                                                                                                                                                     | Pts | Status                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | ------------------------------------------------------ |
| Per-test-file V8 coverage for Vitest, Jest and `node:test` (`smarttest trace`), stored as observed execution with file hashes and a runtime/lockfile fingerprint          | 21  | done                                                   |
| Trace invalidation: a trace is used only while every file it loaded is unchanged at the base of the change; stale traces are ignored; `trace --stale` refreshes them      | 8   | done                                                   |
| Hybrid selection: traces rule out static-only and uncertainty selections in FAST/BALANCED and add tests static analysis missed; SAFE only adds; `explain` shows the trace | 8   | done                                                   |
| Unprotected changes: changed units no test reaches statically or in a fresh trace, listed by `impact`                                                                     | 13  | done (unit level; line-level coverage is not reported) |
| Shadow Mode: `smarttest shadow` and `shadow --report`                                                                                                                     | 13  | done                                                   |
| `benchmark --since <ref>` with `--sample`, `--resume` and `--traces`                                                                                                      | 8   | done                                                   |

**Gate:** partly met. 0 missed failures on the fixtures, on 12 replayed LeadsIt commits with traces, and on 40 commits sampled from the last 200. Observed execution reduced the LeadsIt selection by one test file (11 → 10 on the commits without lockfile changes), short of the 20% target: static selection there is already narrow. The 200-commit Shadow Mode run is not done; it needs a repository with a longer-running suite to be meaningful, which is part of the 0.6.0 external-repository work.

## 0.6.0: Adoption (66 pts), released

Make the first ten minutes trivial, in any repository and any CI system. No dependency on a hosted CI provider.

| Story                                                                                                                                                                                 | Pts | Status                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Publish `smarttest` on npm with a local release script, `npm audit` and an SBOM in `release:pack`                                                                                     | 5   | partial: `release:pack` and `release:publish` write a CycloneDX SBOM and run `npm audit`; publishing waits for the name decision (ADR-0007)                                                                                                                                                                                                                                            |
| `smarttest hook install` / `uninstall` / `status` for husky, lefthook, simple-git-hooks and plain `.git/hooks`, writing a marked block; `init` offers it and shows the replaced steps | 8   | done                                                                                                                                                                                                                                                                                                                                                                                   |
| `smarttest ci`: detects GitHub, GitLab, Jenkins, CircleCI, Azure, Bitbucket or generic CI, picks the base ref, deepens shallow clones, writes JUnit and Markdown                      | 8   | done                                                                                                                                                                                                                                                                                                                                                                                   |
| Per-project conventions: layout, naming, mode and rules per sub-project (`projects`), detected by `init`                                                                              | 8   | done                                                                                                                                                                                                                                                                                                                                                                                   |
| Cold start: parse in worker threads, read runner include patterns statically before falling back to listing                                                                           | 13  | partial: worker threads (started only for cold runs of 300+ files), parallel runner listing, default-pattern discovery when a runner config sets no test patterns, cached TypeScript resolution and compile cache. Cold `scan` on LeadsIt went from 5.5 s to 3.6 s; at 2,000 synthetic modules the cold index takes 1.1 s and a cold `scan` 1.4 s, so the one-second target is not met |
| Adaptive policy: skip analysis when the recorded full-run time is lower than the typical analysis time                                                                                | 5   | done                                                                                                                                                                                                                                                                                                                                                                                   |
| Fixtures: React, Next.js, Yarn ESM, TypeScript library, Wasp; validated on Linux, macOS and Windows                                                                                   | 13  | partial: `react-vitest`, `ts-lib-vitest` and `yarn-workspaces-node` added to the regression harness (Wasp is covered by `edges-vitest` and LeadsIt); Next.js moved to 0.7.0 with route conventions; macOS and Windows not validated                                                                                                                                                    |
| Documentation snippets executed by the test suite                                                                                                                                     | 6   | done: every `smarttest …` line in code blocks is parsed by the real CLI and its command help printed; every configuration example passes the validator                                                                                                                                                                                                                                 |

**Gate:** partly met. Four public repositories (commander.js, path-to-regexp, ufo, defu) and LeadsIt were set up with `init --yes` and no configuration edits, and `benchmark` reports 0 missed failures on all five ([results](../case-studies/external-repositories.md)). Installing from npm is still blocked on the package name.

## 0.7.0: Adaptation and E2E (84 pts)

| Story                                                                                                                                        | Pts |
| -------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| `smarttest sync [--check]`: detect new projects, runners, aliases or a VCS change and propose a config update; `doctor --fix` for safe fixes | 13  |
| `migrate` between runners (Jest to Vitest) keeping rules and history                                                                         | 8   |
| `smarttest watch`: rerun affected tests on save using graph patches                                                                          | 13  |
| Playwright adapter: discovery, file selection, traces linked in the report                                                                   | 13  |
| E2E mapping: routes and pages (from 0.4.0 framework edges) to the E2E specs that visit them                                                  | 13  |
| Next.js `app/` and `pages/` route conventions and middleware (from 0.4.0)                                                                    | 8   |
| Cypress adapter                                                                                                                              | 8   |
| TypeScript 7 native API behind `language-typescript`, TypeScript 6 kept as fallback                                                          | 8   |

**Gate:** a fixture that adds a package, switches runner and adopts Git mid-history needs no manual re-init; Playwright selection is validated with `benchmark`.

## 0.8.0: Speed (105 pts)

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
