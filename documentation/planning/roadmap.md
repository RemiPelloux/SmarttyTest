# Roadmap to 1.0.0

1.0.0 is the version we can recommend for any TypeScript/JavaScript repository: selection precise enough to matter on large codebases, never wrong in a way that hides a failure, fast enough to sit in a pre-commit hook, and installable from npm.

The dependency graph is the product. Most of this roadmap makes it more precise (fewer tests run for the same safety) and more complete (fewer relationships SmartTest cannot see).

Planning is in story points. One sprint is about 40 points. Each version has an exit gate; a version ships when the gate is met, not on a date.

## Where 0.8.0 stands

- Released: 0.3.0 to 0.8.0 on top of the [foundation backlog](foundation/README.md). Sprint-by-sprint results, partial items and what moved: [delivery log](delivery.md).
- Graph today: files, top-level symbols and class members; imports, re-exports, barrels, workspace packages, CommonJS, inheritance; environment keys, Prisma models, translation keys, assets, snapshots, manual mocks, Wasp operations, Next.js routes and the URLs end-to-end specs visit; runtime traces as observed evidence. Unresolved relationships are uncertainty and select the test.
- Runners: Jest, Vitest, `node --test`, Playwright, Cypress. Version control: Git, Subversion, Mercurial, native snapshots.
- Real-world checks: LeadsIt (706 tests) and four public repositories set up with `init --yes`, 0 missed failures in every replay.
- Still open before 1.0.0: npm publication (name decision), macOS and Windows validation, cold start and warm analysis at 2,000+ modules, and the 0.5.0/0.8.0 performance targets, which were not reached on LeadsIt.

## When is it usable

| Who                                                                                                               | Usable from           | What is missing before that                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| A team that installs the tarball (like LeadsIt)                                                                   | now, 0.8.0            | Nothing for Linux; install is `npm install -D <tarball>`                                                                     |
| Anyone, with `npm install -D smarttest`                                                                           | the first npm release | The package name and licence decision (ADR-0007). Publication can happen as soon as it is decided, without waiting for 1.0.0 |
| Teams whose daily contact is the commit hook                                                                      | 0.9.0, sprint S24     | Staged-content runs, pre-push mode, project checks, time budget                                                              |
| People who prefer a UI to the CLI                                                                                 | 0.9.0, S25–S26        | SmartTest Studio and the VS Code extension                                                                                   |
| Teams that need guarantees: frozen config and `--json` contracts, macOS and Windows checked, published benchmarks | 1.0.0                 | Contracts freeze, cross-platform validation, security review                                                                 |

## Overview

| Version | Theme                | Points | Gate                                                                                                                              |
| ------- | -------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------- |
| 0.3.0   | Precise graph        | 83     | Released (13 pts moved to 0.8.0): member-level selection, CommonJS symbols, graph queries                                         |
| 0.4.0   | Complete graph       | 84     | Released (8 pts moved to 0.7.0): env, asset, Wasp, Prisma, translation, mock and snapshot edges                                   |
| 0.5.0   | Runtime evidence     | 71     | Released: traces, hybrid selection, Shadow Mode; reduction target not reached on LeadsIt                                          |
| 0.6.0   | Adoption             | 66     | Released: hooks, `smarttest ci`, per-project conventions, five repositories at 0 misses; npm publish blocked                      |
| 0.7.0   | Adaptation and E2E   | 84     | Released: sync, watch, migrate, Playwright and Cypress, Next.js routes; TypeScript 7 not available                                |
| 0.8.0   | Speed                | 105    | Released: result cache, parallel groups, shards, flaky history, SVN and Mercurial; 30% target not reached                         |
| 0.9.0   | Hooks and interfaces | 116    | Next: commit hooks (S24), then SmartTest Studio and VS Code (S25–S26)                                                             |
| 1.0.0   | Stable               | 52     | Frozen contracts, published benchmarks, security review                                                                           |
|         | Remaining            | 168    | About 4–5 sprints (0.9.0 and 1.0.0); 0.3.0 to 0.8.0 delivered 472 of 514 points, 57 of them partial ([delivery log](delivery.md)) |

## Graph model

| Layer          | 0.2.0                                              | 0.8.0 (now)                                                                                                                                  | 1.0.0                                                                |
| -------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Nodes          | files, top-level symbols, tests                    | plus methods and accessors, env keys, Prisma models, translation keys, routes, assets, snapshots, manual mocks                               | same, plus fixtures as first-class nodes                             |
| Code edges     | imports, re-exports, barrels, top-level references | plus member access through local inference, inheritance and `super`, CommonJS symbols, fluent `this`, Wasp operations, constructor injection | plus edge-provider plugins (SDK 1.0); type-checked calls after 1.0.0 |
| Non-code edges | none                                               | environment, assets, Prisma schema, translations, Next.js routes and E2E visits, snapshots, `__mocks__`, generator inputs                    | same                                                                 |
| Evidence       | static only                                        | static and observed at runtime (traces), with provenance and confidence                                                                      | same                                                                 |
| Storage        | rebuilt from cached analyses on every run          | rebuilt per run (about 60 ms at 2,000 modules), patched in memory in `watch`                                                                 | persisted between runs                                               |
| Queries        | dependents, dependencies, export                   | plus `why`, cycles, orphans, unprotected changes, graph diff                                                                                 | same                                                                 |

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

## 0.7.0: Adaptation and E2E (84 pts), released

| Story                                                                                                                                                     | Pts | Status                                                                                                               |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | -------------------------------------------------------------------------------------------------------------------- |
| `smarttest sync [--check]`: detects new runners, packages or a VCS change and patches the config; `doctor --fix` for safe fixes                           | 13  | done                                                                                                                 |
| `migrate` between runners (Jest to Vitest) keeping rules and history                                                                                      | 8   | done (Jest to Vitest; other directions not planned)                                                                  |
| `smarttest watch`: rerun affected tests on save                                                                                                           | 13  | done; each cycle rebuilds the graph from the warm index, incremental graph patches are part of the 0.8.0 graph story |
| Playwright adapter: discovery, file selection, traces linked in the report                                                                                | 13  | done                                                                                                                 |
| E2E mapping: URLs visited by specs (`page.goto`, `request.*`, `cy.visit`) linked to the routes that serve them; unreadable visits make the spec uncertain | 13  | done                                                                                                                 |
| Next.js `app/` and `pages/` route conventions, layouts and middleware                                                                                     | 8   | done                                                                                                                 |
| Cypress adapter                                                                                                                                           | 8   | done, not validated against a Cypress install (argument building and JUnit parsing are tested)                       |
| TypeScript 7 native API behind `language-typescript`, TypeScript 6 kept as fallback                                                                       | 8   | not done: TypeScript 7 exposes no parser API usable from Node yet; moved to 1.0.0 as a watch item                    |

**Gate:** met. A Jest project without Git that switches to Vitest, adopts Git and gains a `node --test` package is brought up to date by `smarttest sync` without re-running init (`integration-tests/adaptation.test.ts`). Playwright selection: the `next-playwright` fixture's four seeded regressions are in the regression harness, and `benchmark` over a history of breaking and fixing commits reports 0 missed failures.

## 0.8.0: Speed (105 pts), released

Run less (graph), then run what remains faster.

| Story                                                                                                                                                                                                               | Pts | Status                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Validated result cache, content-addressed on the test, its closure and traced files, runner config, manifests, lockfiles, env and setup files, runtime and runner version; cached results always reported as cached | 21  | done; `benchmark` checks every cached pass against the full run                                                                                            |
| Fail-fast ordering: recent failures first, then the tests closest to the change; `--bail`                                                                                                                           | 8   | done                                                                                                                                                       |
| Duration-aware scheduling: independent runner groups in parallel within a CPU budget                                                                                                                                | 13  | done (`parallelGroups`, end-to-end groups alone); memory is not budgeted separately                                                                        |
| Sharding: `smarttest shard --total n --index i` and `run --shard i/n`, balanced by recorded durations                                                                                                               | 8   | done                                                                                                                                                       |
| Flaky analytics: failure history, rate, retry-rule suggestions (never silent skips)                                                                                                                                 | 13  | done                                                                                                                                                       |
| SVN and Mercurial adapters behind the existing VCS contract                                                                                                                                                         | 16  | done                                                                                                                                                       |
| Persistent graph with incremental patches (from 0.3.0)                                                                                                                                                              | 13  | partial: in-memory patches in `watch` (under 1 ms at 2,000 modules); the graph is not persisted to disk, a rebuild from the cached index takes about 60 ms |
| Type-checker resolution for values local inference cannot type (from 0.3.0)                                                                                                                                         | 13  | not done; moved after 1.0.0                                                                                                                                |

**Gate:** not met. On LeadsIt's last 12 commits, SmartTest's time went from 47.2 s (groups one after another, no cache) to 43.4 s (8% less), with 0 cache-integrity violations and 0 missed failures. Parallel groups help on the commits that run several projects; on single-project commits nothing changes. The result cache never hits when replaying history, because every commit changes the inputs of the tests it selects; it pays off on repeated runs of the same state (re-running after a fix elsewhere, CI retries, switching back to a branch), where a second run of an unchanged selection takes milliseconds.

## 0.9.0: Commit hooks and interfaces (116 pts), next

Three sprints: S24 makes the commit hooks a first-class SmartTest experience; S25 and S26 build SmartTest Studio and the VS Code extension.

### S24: Commit hooks (40 pts), next sprint

The pre-commit and pre-push hooks are where most developers meet SmartTest. Today `smarttest hook install` adds `smarttest run --staged` to an existing hook. This sprint makes the hook correct for partially staged work, fast enough to never be bypassed, and clear when it blocks a commit.

| Story                                                                                                                                                                                                                                                                                                                              | Pts |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| **Staged-content runs**: `run --staged` tests exactly what will be committed. Partially staged files and unstaged edits are set aside (a temporary checkout of the index, never a stash that can lose work) and the result says so; today tests run against the working tree                                                       | 8   |
| **`smarttest hook install --pre-push`**: compares with the upstream branch's merge-base (or `origin/<default>` when there is no upstream), replaces `vitest related` / full-suite steps the same way `--replace` does for pre-commit                                                                                               | 5   |
| **Hook profile**: hooks run with fail-fast order, `--bail`, the result cache and parallel runner groups by default; output fits one screen (changed files, selected count, failures with their first error lines, total time, "why" command)                                                                                       | 5   |
| **Project checks for affected projects**: a `hook.checks` list (lint, type-check, build…) run only for the sub-projects the change touches, in parallel with the tests, with staged-file arguments where the tool accepts them (ESLint, Prettier)                                                                                  | 8   |
| **Time budget and honesty**: `hook.budgetMs`; when the estimate (recorded durations) exceeds it, the hook says which tests make it slow and offers `--shard`-free options (run in pre-push instead, trace to narrow); it never skips silently. A bypass (`--no-verify`, `SMARTTEST_SKIP=1`) is recorded and shown by `hook status` | 5   |
| **`smarttest hook status` and `doctor`**: hook duration over the last runs (median, slowest), steps that still run whole suites, steps that duplicate SmartTest, missing installs on teammates' machines (hook present, `node_modules/.bin/smarttest` missing)                                                                     | 5   |
| **Validation**: LeadsIt's husky hook and a pre-push setup like OpenPro's (`vitest related` + type-check + build) migrated with `hook install --replace` and measured with `benchmark`: hook time before and after, 0 missed failures                                                                                               | 4   |

**Gate:** a commit with partially staged files is tested on its staged content; hook time on LeadsIt and on a pre-push setup like OpenPro's is measured before and after with 0 missed failures; no step is skipped without being reported.

### S25–S26: SmartTest Studio and the VS Code extension (76 pts)

SmartTest Studio and the VS Code extension: everything the CLI shows, without the CLI. Studio runs locally (`smarttest studio`), uses the same engine as the CLI through `@smarttest/core`, and follows the [design system](../design/design-system.md) of the HTML report and the documentation site. Nothing leaves the machine.

| Story                                                                                                                                                                                          | Pts |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| `smarttest studio`: local web app bound to loopback with a session token and origin checks; project overview (runners, last run, cache, traces, flaky tests) and test explorer                 | 21  |
| Impact map: the dependency graph of the current change, path highlighting from a changed method to each selected test, reasons and confidence, filters, export                                 | 13  |
| Live runner and coverage viewer: run affected, all or one test file; results stream in, cached results marked; source annotated with changed lines, observed execution and unprotected changes | 21  |
| VS Code extension: "protected by N tests" above each function and method, run the affected tests of the current file, explanations on hover, uses the local `smarttest`                        | 21  |

Built on what exists: `--json` outputs (`impact`, `explain`, `run`), the HTML report, `watch` (in-memory graph patches) and traces.

Studio must be a well-designed product, not a dashboard template. It is built with the frontend design skill's app-screen run, from the [Studio design brief](../design/studio.md): one question per screen, real data from the CLI, the dealt style (data-terminal, on the SmartTest palette) and its signature element, the impact strip.

**Gate:** run, explain, inspect impact and read coverage without the CLI; the design skill's linter and inspector pass with 0 failures at 1440, 768 and 390 pixels, and the screenshot critique is recorded; WCAG 2.2 AA in both themes and full keyboard use; local security review of Studio passed.

## 1.0.0: Stable (52 pts, plus items carried from 0.6.0 to 0.8.0)

| Story                                                                                                                                                                         | Pts |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| Plugin SDK 1.0: frozen adapter contracts (language, runner, VCS, edge providers), conformance kit, documentation                                                              | 13  |
| Freeze public contracts: config schema, exit codes, `--json` schemas; semver policy and migration notes                                                                       | 5   |
| Published benchmarks on at least five real repositories, LeadsIt included, with 0 missed failures; the 0.5.0 (observed execution) and 0.8.0 (speed) targets re-measured there | 13  |
| Performance: warm analysis under one second at 10,000 modules, cold start under one second at 2,000; the graph persisted between runs                                         | 8   |
| Security review: file writes, process execution, Studio                                                                                                                       | 8   |
| Documentation complete                                                                                                                                                        | 5   |
| Carried: publish on npm (needs ADR-0007), `pnpm verify` on macOS and Windows, Cypress adapter checked against a real install                                                  | —   |

TypeScript 7 stays a watch item: the analyzer moves when TypeScript 7 offers a parser API usable from Node.

**Gate:** all of the above, and no open defect that can make a failing test be skipped.

---

## Not before 1.0.0

- Type-checker resolution for values local inference cannot type (moved from 0.3.0 and 0.8.0); until then such calls are class-level, which is safe.
- AI test generation and audit (PRD Release 3): 2.0.0, built on the generator's `it.todo` scaffolds. The deterministic core never depends on it (ADR-0004).
- Cloud and team analytics (PRD Release 5).
- Other languages (PRD Release 6). The edge-provider SDK in 1.0.0 is designed for them.

Working agreements: [Definition of Ready and Done](definition-of-ready-and-done.md) · [risks](risks.md).
