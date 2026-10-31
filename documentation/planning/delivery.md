# Delivery log: 0.3.0 to 0.9.0

What was actually delivered against the [roadmap](roadmap.md), sprint by sprint. The foundation sprints S0 to S10 (0.1.0 and 0.2.0) are in the [foundation backlog](foundation/sprints.md). Planning is in story points; one sprint is about 40 points. There are no dates: a sprint is a unit of work, and a version ships when its gate is met or the gap is written down.

Status words: **done** (shipped and tested), **partial** (shipped with a stated gap), **moved** (re-planned in a later version), **not done** (dropped from the version, reason given).

## Summary

| Version                    | Sprints    | Planned | Delivered             | Moved / not done                      | Gate       | Tag                  |
| -------------------------- | ---------- | ------- | --------------------- | ------------------------------------- | ---------- | -------------------- |
| 0.3.0 Precise graph        | S11–S12    | 96      | 83                    | 13 moved to 0.8.0                     | met        | `v0.3.0` (`f85c053`) |
| 0.4.0 Complete graph       | S13–S14    | 92      | 84                    | 8 moved to 0.7.0                      | met        | `v0.4.0` (`ee220dc`) |
| 0.5.0 Runtime evidence     | S15–S16    | 71      | 58 done, 13 partial   | —                                     | partly met | `v0.5.0` (`03ee658`) |
| 0.6.0 Adoption             | S17–S18    | 66      | 35 done, 31 partial   | Next.js fixture moved to 0.7.0        | partly met | `v0.6.0` (`328b330`) |
| 0.7.0 Adaptation and E2E   | S19–S20    | 84      | 76                    | 8 not done (TypeScript 7)             | met        | `v0.7.0` (`ec5d3a9`) |
| 0.8.0 Speed                | S21–S23    | 105     | 79 done, 13 partial   | 13 not done (type-checker resolution) | not met    | `v0.8.0` (`a5d958f`) |
| 0.9.0 Hooks and interfaces | S24–S26    | 116     | 36 done, 80 partial   | —                                     | partly met | `v0.9.0`             |
| Total                      | 16 sprints | 630     | 451 done, 137 partial | 42                                    |            |                      |

Tests grew from 124 (0.2.0) to 434 repository tests plus 114 extension tests (0.9.0); the regression harness grew from 4 to 9 fixtures, all at 0 missed failures in BALANCED and SAFE mode.

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

## S24–S26 · 0.9.0 Hooks and interfaces

Goal: make staged and pushed checks reliable and expose selection evidence in local interfaces.

| Story                                                                | Pts | Status                                                                                                                                                                           |
| -------------------------------------------------------------------- | --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exact staged-content runs                                            | 8   | done: temporary checkout, alternate indexes, binary/symlink/rename and file/directory transition fixtures                                                                        |
| Pre-push installation and actual destination comparison              | 5   | done: new/unknown destinations select conservatively; unsupported non-HEAD pushes are rejected                                                                                   |
| Hook defaults, affected-project checks, estimates, budget and status | 23  | done: checks and tests run concurrently; explicit bypass records and unchecked-commit findings                                                                                   |
| Real-project hook measurements                                       | 4   | done: LeadsIt adopted and replayed; OpenPro front end measured before/after, 0 missed failures                                                                                   |
| Studio overview and test explorer                                    | 21  | partial: local server, filtering, source and test actions shipped; complete accessibility/design gate open                                                                       |
| Impact map                                                           | 13  | partial: selection paths, reasons and confidence shipped; graph filtering/export remain open                                                                                     |
| Live runner and coverage viewer                                      | 21  | partial: affected/all/file execution, group events, cancellation, aggregate coverage and unit trace annotations; browser coverage collection and line/branch heatmap remain open |
| VS Code extension                                                    | 21  | partial: CodeLens, hover, impact/run commands, results and trust gates; current-file command runs the affected change set; actual editor-host validation unavailable             |

Validation: `pnpm verify` passes 434 repository tests and 114 extension tests, TypeScript, Biome, package boundaries and generated-planning checks. Nine regression fixtures remain at zero missed failures. The packaged CLI was installed outside this checkout and served Studio assets and authenticated APIs. Its runtime audit reports zero advisories; the VSIX passes archive validation.

LeadsIt: all 714 assertions across 101 test files pass with 0.9.0 (4.78 s in this run). The staged hook reports 314 passed and 400 cached, zero failures, in 3.67 s including isolation. Its 12-commit benchmark reports 53.59 s full, 7.18 s project-gated, 34.38 s SmartTest, zero missed failures and zero cache violations. That is 36% faster than full runs and 379% slower than the project-gated baseline. These are local observations with a changing history/cache; they do not establish a release-to-release speed improvement.

The OpenPro-style fixture preserves typecheck, build and PID/wait semantics through `hook install --replace`. Hook duration was 1.88 s before and 2.70 s after; the two-commit benchmark found zero misses and zero cache violations. With no remote base, the new hook checks the complete committed tree conservatively. This small fixture does not represent OpenPro's full workload.

The LeadsIt dry run exposed replacement-string interpretation of shell `$'` sequences during an existing-hook upgrade. The installer now inserts the modified text through a callback; a regression test preserves all shell dollar sequences. The applied upgrade changes only the SmartTest invocation. A real adoption commit then exposed lost executable permissions during atomic replacement; atomic writes now preserve existing permissions, with an upgrade/uninstall regression test. The hook was restored before the final adoption commit.

Studio security checks cover token, Host, Origin, request methods, content type, source traversal and symlink boundaries, CSP and SSE shutdown. Missing benchmark values stay unavailable; incomplete runs cannot be labelled passed. Retained browser evidence covers five screens, both themes and 1440/768/390 widths without document overflow. The overview inspector has zero failures and three warnings; seven keyboard checks pass. These checks are not a complete WCAG 2.2 AA or all-screen design signoff. See the [Studio critique](../../packages/studio/review/CRITIQUE.md).

Post-release audit (same tag, 2026-10-30): a performance and UX review before publication fixed N+1 work and repeated computation in hooks, Studio and the VS Code extension, and fixed Studio defects found only in a real browser.

- **Hooks.** The isolated checkout overwrote the index's file stats with its fresh mtimes, so the hook and the next normal run each re-read and re-hashed every source file. The checkout now reuses the working tree's stats for identical content. On a 4,000-file fixture, the next run's index update fell from about 175 ms to about 90 ms; the hook's own time is dominated by the checkout and the tests and did not change measurably ([measurement](../../benchmarks/releases/0.9.0/hook-index-reuse.json)). "Before" reads are memoised and fetched eight at a time, checks are bounded by CPU count, and a regression test covers the index stats.
- **Explain.** `explain <file> --units` explains every unit from one graph build. The extension uses it, so it makes one CLI call per file instead of one per symbol.
- **Studio browser fixes.** About 1,800 CSP errors from inline styles broke layout; Back/Forward did not work; re-renders lost focus and scroll; unit line numbers were off by one. All are fixed.
- **Studio honesty.** Trust and hook figures without data read as unmeasured, and an all-cached run has the verdict `cached-pass`. The overview inspector reports zero failures and zero warnings at 1440/768/390.
- **VS Code.** Analyses are cached until the graph changes; a file watcher replaces the 10-second expiry; concurrent requests for a file share one analysis.
- **Tests.** Tests now resolve workspace packages from source rather than `dist/`.

Feature review (same tag, 2026-10-30): a correctness review of every 0.9.0 feature, each defect reproduced before it was fixed and covered by a test that fails without the fix.

- **Core.** A file whose runner never started (missing Vitest) has no test records and was summed as a pass with exit 0; it now counts as an infrastructure error (exit 4).
- **Hooks.** Unstaged edits leaked into the staged run through workspace packages linked in `node_modules`, which could pass a commit whose staged content fails; the checkout now gets its own `node_modules` that points workspace packages at the staged copies. `hook install --pre-push` consumed the refs on stdin, which disabled the user's own pre-push guards; the refs are now handed back. Hooks were written where Git never runs them (project in a subdirectory, linked worktrees, absolute `core.hooksPath`). Other fixes: checks scoped to workspace packages were silently skipped; the user's `post-checkout` hook ran on every commit; Git inside the checkout saw HEAD as the index; delete-only pushes ran the whole history; SIGTERM/SIGHUP left the checkout behind; lefthook's pre-push entry got no stdin; non-shell hooks were broken by install; file names starting with `-` reached checks as options.
- **Hooks, gaps closed afterwards.** simple-git-hooks in a subdirectory project, links from anywhere in pnpm's store, and cleanup that could forget the user's own worktrees.
- **Studio.** A run in which no test passed (nothing selected, every test skipped) was "passed"; it is now `no-tests`. Results stream per runner group. Overlapping refreshes analysed the wrong source. Runs from the terminal or a hook were never picked up. A cancelled run was shown as finished, and the run drawer could stay "Running" after the event stream reconnected. An event-stream reader that stops reading is now disconnected instead of buffering without limit, and a run that finishes before the browser learns its id is caught up.
- **VS Code.** The run verdict now reads file and test statuses, so a run whose runner never started is no longer shown as passed. Runs exiting 4 or 70 keep their report, and the forced kill of a stuck CLI actually happens. Windows `.cmd` shims could not start, and "Run for this file" turned an explain error into "no path". A stale run verdict stayed in the status bar, CodeLens could bind to a nested function of the same name, and deactivation left processes running.


Validation round (same tag, 2026-10-31): the limits listed after the feature review, measured or tested instead of stated.

- **OpenPro's pre-push workload.** The front end (about 9,600 TypeScript files, 2,164 test files, npm) was tested in a separate clone with its existing pre-push hook: type-check, `vitest related` and a production build in parallel. Over three recent commits the hook as installed failed in 136–143 s, because `vitest related` ran out of Node's default 4 GB heap; with an 8 GB heap it passed in 125–176 s. With `hook install --pre-push --replace` the hook passed in 42–45 s, of which SmartTest took 3.4–6.0 s for 4–11 test files, the rest being type-check and build. A six-commit `benchmark` found 0 missed failures and 0 cache violations (95 failures already present in the parent commits on this machine): full runs 12 min 22 s, SmartTest 2 min 26 s, 80% less; the dependency-patch commit selected every test. Two findings: Vite refused `?url` imports of installed packages inside the temporary checkout (fixed, with a test that fails without the fix), and SmartTest conservatively selects OpenPro's 21 Playwright specs on every push because their imports cannot be resolved; those need a browser and the deployed environment, so the measurement excluded `e2e/**` with `exclude`. A hook-only runner scope does not exist yet.
- **dash.** The pre-push and subdirectory blocks run under dash 0.5.12 (Debian's `/bin/sh`) and the system shell; CI on Ubuntu runs them under dash.
- **VS Code.** `pnpm --filter smarttest-vscode test:host` starts VS Code 1.143.1 with the extension against a Git copy of `node-test-esm`, trusted and in Restricted Mode: activation, all seven commands, status bar, CodeLens, hover, impact, a passing and a failing affected run, results going out of date on save, and no process in Restricted Mode (11 checks, passed twice locally). It found that a `bin.js` path in `smarttest.executablePath` did not start on Linux and macOS.
- **CI.** `.github/workflows/ci.yml` runs `pnpm verify` on Linux, and the extension's unit and real-host tests on Linux, Windows and macOS.
- **Studio accessibility.** `pnpm studio:a11y` drives every screen, the run drawer, the shortcuts dialog and pairing in Chromium, Firefox and WebKit (WPE on Linux), light and dark, with axe-core (WCAG 2.0–2.2 A/AA) plus keyboard, focus-return, live-region, reflow at 320 px and target-size checks, and keeps each screen's accessibility tree. Failures went from 39–41 per combination to 0. Not done: a pass with a real screen reader (NVDA, VoiceOver), real Safari, forced colours and text spacing.
- **Studio refresh race.** A refresh waiting behind another analysis could answer a staged request with the working tree; a deterministic test now covers it.

Gate: partly met. Features and limitations above are shipped explicitly as alpha; accessibility, complete keyboard/visual review, extension-host validation and remaining interface capabilities carry into 1.0.0. Source highlights indicate observed unit execution, not measured line coverage. Per-file results stream as each runner group finishes; cached results arrive with the summary.

## Carried into 1.0.0

| Item                                                                                                    | From         | Now in                      |
| ------------------------------------------------------------------------------------------------------- | ------------ | --------------------------- |
| Studio screen-reader pass (NVDA, VoiceOver), real Safari, and remaining interface capabilities          | 0.9.0        | 1.0.0                       |
| True current-file run scope in the extension                                                            | 0.9.0        | 1.0.0                       |
| Hook-only runner scope (browser specs in CI, unit tests in the hook)                                    | 0.9.0        | 1.0.0                       |
| Publish on npm                                                                                          | 0.6.0        | 1.0.0 (blocked on ADR-0007) |
| Validate on macOS and Windows                                                                           | 0.6.0        | 1.0.0                       |
| Cold start under one second at 2,000 modules; persist the graph to disk                                 | 0.6.0, 0.8.0 | 1.0.0 performance story     |
| Validate the Cypress adapter on a real install                                                          | 0.7.0        | 1.0.0                       |
| 30% speed target and 20% observed-execution target, re-measured on the published benchmark repositories | 0.5.0, 0.8.0 | 1.0.0 benchmarks            |
| TypeScript 7                                                                                            | 0.7.0        | watch item, 1.0.0           |
| Type-checker resolution                                                                                 | 0.3.0, 0.8.0 | after 1.0.0                 |
