# Roadmap to 1.5.0

1.0.0 froze SmartTest's contracts. The 1.x line keeps them: every version from 1.1.0 to 1.5.0 is additive (new flags, new config keys with defaults, new adapters), so a config, a script or a `--json` consumer written for 1.0.0 keeps working. Anything that would break a frozen contract waits for 2.0.0 ([contracts](../reference/contracts.md)).

The first real rollout after 1.0.0 set the order. On 1 November 2026 SmartTest went into four of OpenPro's repositories (front, admin, desktop monitor, MCP service): 0 missed failures and 42–96% less test time, but each repository needed hand work that `init` should have done, and a bug hid one test file. 1.1.0 adds Angular, which SmartTest does not understand yet, and makes that hand work unnecessary. Then precision (1.2.0), the browser (1.3.0), the ecosystem (1.4.0) and the first languages beyond JavaScript (1.5.0).

Planning is in story points; one sprint is about 40 points. A version ships when its gate is met, not on a date. Sprints continue from S27 (1.0.0).

## Overview

| Version | Theme                              | Sprints | Points | Gate in one line                                                                            |
| ------- | ---------------------------------- | ------- | ------ | ------------------------------------------------------------------------------------------- |
| 1.1.0   | Angular, rollout without hand work | S28–S29 | 80     | Angular workspaces selected and run at 0 misses; `init` alone reproduces the OpenPro setups |
| 1.2.0   | Precision                          | S30–S31 | 76     | Type-checker resolution; the 20% observed-execution target met on two benchmarks            |
| 1.3.0   | Browser and end-to-end             | S32–S33 | 72     | Source-mapped browser coverage; live-environment specs never run by accident                |
| 1.4.0   | Ecosystem                          | S34–S35 | 74     | Third-party adapters installable from npm; CI annotations; a shared result cache            |
| 1.5.0   | Beyond JavaScript (preview)        | S36–S38 | 110    | Python and PHP selection on OpenPro's backend and OpenProAuto at 0 misses                   |

Total: 412 points, eleven sprints (S28–S38).

---

## 1.1.0: Angular, rollout without hand work (80 pts)

Two sprints. S28 adds Angular; S29 removes the hand work the OpenPro rollout needed.

### S28: Angular (40 pts)

Angular is the main TypeScript framework SmartTest does not understand. Most of an Angular app is ordinary TypeScript and is already analysed, but three things are missing. First, components load their template and styles by path (`templateUrl`, `styleUrl`), not by import. Today a change to `foo.component.html` selects no test at all, not even `foo.component.spec.ts`; that is a missed test, not only a missing feature. Second, tests run through `ng test`, not through a runner config. Third, `angular.json` holds what other projects keep in `tsconfig` and runner configs.

| Story                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Pts |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| **Component resources are edges.** `templateUrl`, `styleUrl` and `styleUrls` in `@Component` link the component to its template and styles, and Sass/Less `@use`/`@import` link a stylesheet to its partials. A template or style change selects the tests of that component and of its importers. A path that cannot be resolved is uncertainty. New edge type: a fixture where a template change selects only its component's specs.                                                                                                                                          | 5   |
| **Angular workspaces detected.** `angular.json` (and Nx `project.json`) read for each project: `root`, `sourceRoot`, the `tsConfig` of its build and test targets, `fileReplacements` (a change to `environment.prod.ts` selects the tests of `environment.ts`'s importers) and global `styles`/`scripts`. `detect` and `doctor` report Angular and its version; `init` proposes the matching runner and scope.                                                                                                                                                                 | 5   |
| **`ng test` as a runner.** An adapter for the Angular CLI's test builders: `@angular/build:unit-test` (Vitest, the default since Angular 21) and the Karma builders. It reads `include`, `exclude`, `setupFiles`, `providersFile`, `polyfills` and `tsConfig` (all of them runner inputs, so a change selects that project's tests), and runs a selection with `ng test --include` per project. Karma reports per file only; the adapter declares it and does not emulate per-test results (ADR-0005). A run where `ng test` fails before reporting is a failure, never a pass. | 13  |
| **Jest and Vitest community setups.** `jest-preset-angular` (`setup-jest.ts`, zone setup), `@angular-builders/jest` (Jest config inside `angular.json`) and `@analogjs/vitest-angular` discovered and run through the existing Jest and Vitest adapters.                                                                                                                                                                                                                                                                                                                        | 5   |
| **Angular code edges.** Lazy routes (`loadComponent`, `loadChildren` with `import()`) link the route file to the loaded code; the legacy string form (`'./x.module#XModule'`) is resolved, or treated as uncertainty when it cannot be. `inject(X)`, constructor injection and `providers` need nothing new, since they import their tokens; a fixture proves it.                                                                                                                                                                                                               | 5   |
| **Fixtures and a real-world check.** Three fixtures: a standalone Angular 21 app on the unit-test builder, an NgModule app on Karma, and an Nx workspace on Jest. An open-source Angular application replayed with `benchmark` and added to the published benchmarks. The trace and resolution oracles from the 1.0.2 audit are run on it.                                                                                                                                                                                                                                      | 5   |
| **Angular guide.** `documentation/guides/angular.md`: what is understood, what is uncertainty, the supported builders, and how to read `explain` on a template change.                                                                                                                                                                                                                                                                                                                                                                                                          | 2   |

**S28 gate:** on the three fixtures, a template, style, component, service or `angular.json` change selects the affected specs and no others. The full suite through SmartTest reports the same tests and failures as `ng test`. `benchmark` on the open-source application shows 0 missed failures, and the trace oracle finds no file a spec loads that selection cannot reach.

### S29: Rollout without hand work (40 pts)

Every item comes from a problem met on OpenPro. Each was fixed by hand there; here it becomes the default.

| Story                                                                                                                                                                                                                                                                                                                                                                                                            | Pts |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| **No test file is ever invisible.** The built-in ignored directories (`build`, `out`, `dist`…) are skipped as build output, but a file the runner itself collects is always analysed: discovery's list wins over the walker's ignores. `doctor` and `scan` report any file a runner collects that the graph lacks. (OpenPro: `src/tests/build/…test.ts` was never selected.)                                     | 5   |
| **`it.each` rows keep their own identity.** A test id holds the row's formatted title, or its index when titles repeat, so reports, the result cache and flaky history count every row. (OpenPro: 8 passing rows counted as fewer.)                                                                                                                                                                              | 3   |
| **Pre-push reads Git's refs wherever the step runs.** When the refs are missing, `run --push` falls back to the upstream merge-base with a warning instead of `ST_HOOK_PUSH_REFS_MISSING`; `hook install` rewrites a backgrounded test step (`… &`) to receive the refs it saved.                                                                                                                                | 5   |
| **`init` respects the hook a repository already has.** It detects hook installers that copy scripts (`cp scripts/pre-commit $(git rev-parse --git-path hooks)`) and edits the source script, not the copy in `.git`; when an existing hook already runs related tests (`vitest related`, `jest --findRelatedTests`), it replaces that step in place, in the same hook, instead of adding a second one elsewhere. | 8   |
| **`--runner <name>` on `run`, `impact`, `benchmark` and `validate-selection`.** Today keeping Playwright out of a parity check or a benchmark needs a copied config. `benchmark` follows `hook.runners` unless told otherwise.                                                                                                                                                                                   | 3   |
| **Lockfile changes select by package.** A `package-lock.json`, `pnpm-lock.yaml` or `yarn.lock` change is diffed: only the packages whose resolved version changed select the code that imports them (and their tests). Today any lockfile change selects every test, which put a 4-minute estimate on a one-line push. A lockfile that cannot be parsed still selects everything.                                | 8   |
| **The hook budget explains itself.** When an estimate passes `hook.budgetMs`, the warning names the trigger that widened the selection (a lockfile, a config file) and the files with no recorded duration.                                                                                                                                                                                                      | 3   |
| **Rollout guide and case study.** `documentation/guides/rollout.md` from the OpenPro migration: parity check, benchmark, hooks per repository, what to leave to CI; the four repositories added to the published benchmarks.                                                                                                                                                                                     | 5   |

**S29 gate:** on a fresh clone of each of OpenPro's four JavaScript repositories, `smarttest init --yes` alone produces a setup equivalent to the hand-tuned one (hook, scope, script placement), the full suite through SmartTest reports the same tests and failures as the runner, and `benchmark` shows 0 missed failures. No test file a runner collects is missing from the graph in any benchmark repository.

## 1.2.0: Precision (76 pts)

Run fewer tests for the same safety. Two items have been carried since 0.3.0 and 0.8.0.

| Story                                                                                                                                                                                                                                                                                                                                                                                | Pts |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --- |
| **Type-checker resolution** for calls local inference cannot type (values from factories, generics, injected dependencies). A call resolved by the checker selects the callers of that method instead of the whole class. Opt-in per project at first (`analysis.typeChecker`), with a time budget; on budget overrun it falls back to today's class-level selection, which is safe. | 21  |
| **Observed execution, second pass.** Traces recorded per test file narrow a static selection only where both agree; `trace --stale` refreshes the traces a change invalidated. Target carried from 0.5.0: 20% fewer test files than static selection, at 0 misses.                                                                                                                   | 13  |
| **A lazily loaded index.** The in-process analysis at 10,000 modules under 500 ms (654 ms at 1.0.0): load the parts of the index a change reaches, not all of it.                                                                                                                                                                                                                    | 8   |
| **Speed target carried from 0.8.0.** 30% less wall-clock time than 1.0.0 on the published benchmarks, from the lazy index, earlier fail-fast ordering and runner warm-up reuse.                                                                                                                                                                                                      | 13  |
| **Barrel and re-export pruning.** A change behind a barrel (`index.ts`) selects only the importers of the symbol that changed, through any depth of re-exports, including `export *`.                                                                                                                                                                                                | 8   |
| **TypeScript 7 parser.** Adopted when its parser API leaves `unstable/*`; until then a watch item with a compatibility test against each 7.x release.                                                                                                                                                                                                                                | 5   |
| **Selection precision report.** `benchmark` adds the share of selected files that actually ran the changed code (from traces), so precision is measured, not only safety.                                                                                                                                                                                                            | 8   |

**Gate:** type-checker resolution on at least two benchmark repositories with 0 misses; the 20% observed-execution reduction met on at least two of them; analysis at 10,000 modules under 500 ms in process.

## 1.3.0: Browser and end-to-end (72 pts)

End-to-end specs are where test time goes, and where running the wrong one is costly: on OpenPro, the Playwright suite targets a live environment.

| Story                                                                                                                                                                                                                                                                                                    | Pts |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| **Browser coverage through source maps.** Bundled and transpiled scripts mapped back to their sources, so a spec is linked to the components it actually rendered; Chromium first, then Firefox and WebKit where Playwright exposes coverage.                                                            | 13  |
| **Pages beyond the `page` fixture.** New pages, popups and `context.newPage()` traced and mapped to their routes.                                                                                                                                                                                        | 5   |
| **Playwright projects understood.** Each project's `baseURL`, dependencies (`setup` projects) and `testMatch` read from the config; a spec that only targets a remote `baseURL` (`https://…`, not `localhost`) is marked **live** and never run by `run`, `benchmark` or a hook unless asked (`--live`). | 8   |
| **Route-level selection for single-page apps.** React Router, TanStack Router and Vue Router routes mapped to the specs that visit them, as Next.js routes are today.                                                                                                                                    | 13  |
| **Cypress component tests** selected like unit tests, with coverage.                                                                                                                                                                                                                                     | 8   |
| **End-to-end sharding by recorded duration** across CI machines, with setup projects run once per shard.                                                                                                                                                                                                 | 8   |
| **Studio sign-off carried from 0.9.0.** Full-screen design review in both themes, forced colours, text spacing, VoiceOver live regions.                                                                                                                                                                  | 8   |
| **Visual and snapshot specs.** Screenshot baselines (`toHaveScreenshot`) linked to the components and styles they cover; a style change selects them.                                                                                                                                                    | 9   |

**Gate:** on OpenPro's front, a component change selects the Playwright specs that render it, from source-mapped coverage; no live-environment spec runs in `run`, `benchmark` or a hook without `--live`; 0 missed failures across the end-to-end benchmarks.

## 1.4.0: Ecosystem (74 pts)

| Story                                                                                                                                                                                                                                                          | Pts |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| **Third-party adapters from npm.** The Plugin SDK's runner, VCS and language contracts (frozen in 1.0.0) become installable: `plugins` in the config loads them, `doctor` runs the conformance kit on each. Example plugins: a Mocha runner and an AVA runner. | 13  |
| **CI annotations.** GitHub Actions, GitLab CI and Bitbucket: selected and skipped tests as annotations on the pull request, with the `explain` reason; a step summary with time saved.                                                                         | 8   |
| **A shared result cache for CI.** Validated, signed results reused across CI runs of the same commit range (a cache directory or an S3-compatible bucket); never trusted without the HMAC signature 1.0.0 introduced.                                          | 13  |
| **Monorepo orchestration.** Nx, Turborepo and pnpm workspace task graphs read, so `smarttest ci` runs each affected package's tests with its own runner in the task graph's order.                                                                             | 13  |
| **Bun and Deno test runners.** `bun test` and `deno test` as built-in adapters.                                                                                                                                                                                | 8   |
| **VS Code and JetBrains.** The VS Code extension gains the impact map; a JetBrains plugin with "Run Affected Tests" and `explain` on hover.                                                                                                                    | 13  |
| **Upgrade assistant.** `smarttest sync` proposes config changes for new 1.x features (lockfile selection, live specs, type-checker), shown as a diff, never applied silently.                                                                                  | 6   |

**Gate:** a third-party adapter published to npm passes the conformance kit and runs in a benchmark repository; CI annotations on GitHub and GitLab; a shared cache hit verified across two CI runs, with a forged entry rejected.

## 1.5.0: Beyond JavaScript, preview (110 pts)

The edge-provider and language contracts of the Plugin SDK were designed for other languages (PRD Release 6). 1.5.0 builds the first two as official plugins, marked **preview**: they select tests and never hide a failure, but their precision is not yet that of the TypeScript analyzer. Both are driven by real repositories: OpenPro's Laravel backend (PHP, Pest) and OpenProAuto (Python, `unittest`).

| Story                                                                                                                                                                                                                                        | Pts |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| **Language plugin API in practice.** Symbols, imports and tests from a language plugin feed the same graph, rules, safety modes and reports as TypeScript; mixed repositories (a PHP backend beside a TypeScript front) analysed in one run. | 13  |
| **Python.** Modules, classes and functions, `import` / `from … import`, relative imports, `conftest.py` fixtures; runners `pytest` and `unittest`.                                                                                           | 21  |
| **PHP.** Namespaces and PSR-4 autoloading from `composer.json`, classes and methods, `use` statements, Laravel service-container bindings and facades as edges; runners Pest and PHPUnit (`php artisan test`).                               | 26  |
| **Framework edges.** Laravel routes, migrations and config keys; Django and FastAPI routes and settings; a migration selects the tests that touch its tables.                                                                                | 13  |
| **Hooks and CI for mixed repositories.** CaptainHook and pre-commit (the Python framework) installed like Husky; `smarttest ci` runs PHP, Python and JavaScript selections side by side.                                                     | 8   |
| **Benchmarks.** OpenPro's backend and OpenProAuto replayed with `benchmark`; results published with the rest.                                                                                                                                | 8   |
| **Unresolvable means selected.** Dynamic calls (`$class::$method()`, `getattr`, `importlib`) are uncertainty and select the tests that reach them, as in TypeScript. Documented per language.                                                | 8   |
| **Documentation.** One guide per language: what is understood, what is uncertainty, how to read `explain` there.                                                                                                                             | 13  |

**Gate:** on OpenPro's backend and OpenProAuto, the full suite through SmartTest gives the same results as the runner, and `benchmark` shows 0 missed failures with less test time than the full suite. Preview plugins can be turned off per project.

---

## Not before 2.0.0

- AI test generation and audit (PRD Release 3), built on the generator's `it.todo` scaffolds; the deterministic core never depends on it (ADR-0004).
- Cloud and team analytics (PRD Release 5).
- Any change to a frozen contract: config schema, exit codes, `--json` v1 schemas, Plugin SDK v1.

Languages after PHP and Python (Dart, Go, Rust, Kotlin) follow the same plugin path once 1.5.0's preview is stable.

Previous: [Roadmap to 1.0.0](roadmap.md) · [Delivery log](delivery.md) · [Risks](risks.md)
