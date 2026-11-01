# Benchmarks for 1.0.0

The 1.0.0 benchmark story: at least five real repositories, LeadsIt included, replayed with `smarttest benchmark` at 0 missed failures, and the targets 0.5.0 (observed execution) and 0.8.0 (speed) missed on LeadsIt re-measured there. Earlier results: [0.6.0 external repositories](external-repositories.md), [LeadsIt](leadsit.md).

## How it was measured

- The CLI is the 1.0.0 candidate built from this repository and packed with `pnpm bundle:cli` (`packages/cli/.publish/dist/bin.js`), since the package is not on npm yet. It includes the persisted graph, the hook scope and the 1.0.0 security fixes.
- Every repository is a fresh clone. The four public ones were installed with their own lockfile (`npm ci`, `pnpm install --frozen-lockfile`) and set up with `smarttest init --yes`, configuration unchanged. LeadsIt keeps its committed configuration. OpenPro's front end was set up with `init --yes`, plus one edit, described below.
- LeadsIt and OpenPro are private. They were cloned with `git clone --no-hardlinks`, and the `node_modules` directories were copied from the working copies (real copies, not symlinks). The originals were not touched.
- `benchmark` replays each commit in a temporary worktree. It times a full run, a project-gated run (the suites of every project the commit touched, as a per-project hook would run them) and SmartTest (analysis included), all on the same checkout. A failure the selection left out counts as missed unless it also fails on the parent commit, in which case it counts as "already failing".
- Machine: Linux, 16 cores, 30 GB of RAM, Node.js 26.12.1, shared with other jobs. Each run went through a machine-wide lock, so no two benchmarks overlapped. Times are wall-clock and vary by about 10% from run to run.
- Raw results: [`benchmarks/releases/1.0.0/`](../../benchmarks/releases/1.0.0/).

## Result: 0 missed failures on six repositories

| Repository                                                            | Runner                      | Test files | Commits | Full runs   | SmartTest  | Saved | Test files run | Full-suite fallbacks | Missed | Already failing |
| --------------------------------------------------------------------- | --------------------------- | ---------- | ------- | ----------- | ---------- | ----- | -------------- | -------------------- | ------ | --------------- |
| [tj/commander.js](https://github.com/tj/commander.js)                 | `node --test`               | 109        | 12      | 12.6 s      | 7.0 s      | 45%   | 644 / 1,312    | 5                    | 0      | 6               |
| [pillarjs/path-to-regexp](https://github.com/pillarjs/path-to-regexp) | Vitest                      | 3          | 12      | 32.2 s      | 25.2 s     | 22%   | 30 / 36        | 4                    | 0      | 0               |
| [unjs/ufo](https://github.com/unjs/ufo)                               | Vitest                      | 13         | 12      | 4.8 s       | 4.7 s      | 4%    | 99 / 156       | 7                    | 0      | 0               |
| [unjs/defu](https://github.com/unjs/defu)                             | Vitest                      | 2          | 12      | 4.1 s       | 3.4 s      | 19%   | 14 / 24        | 6                    | 0      | 0               |
| [LeadsIt](leadsit.md)                                                 | Jest, Vitest, `node --test` | 103        | 12      | 47.5 s      | 6.9 s      | 85%   | 5 / 1,225      | 0                    | 0      | 0               |
| OpenPro front end (private)                                           | Vitest                      | 2,085      | 6       | 11 min 19 s | 2 min 14 s | 80%   | 2,121 / 12,496 | 1                    | 0      | 100             |

"Full-suite fallbacks" are commits where a mandatory trigger (a lockfile, `package.json`, a runner config) ran everything. "Test files run" counts test-file runs summed over the replayed commits.

Project-gated baseline: LeadsIt's per-project suites took 12.8 s, so SmartTest was 46% faster than a per-project hook. The four public repositories are single projects, so their gated time equals the full run. OpenPro is a single project too, so its gated time equals the full run (11 min 19 s). Before the fix described below, the gated column read 22 min 37 s.

### Per repository

- **commander.js**: the same 12 commits as in 0.6.0 (the repository has not moved), with the same selection: 644 of 1,312. One test fails on this machine on every commit, the parent included. On six commits the selection left it out and it counts as already failing. The other six commits selected it (five full-suite fallbacks and `373f660f`).
- **path-to-regexp**: three test files, so most commits select two or three of them. `04fca769` ("Refactor matching to be non-greedy") breaks two tests; both were selected.
- **ufo and defu**: the whole suite runs in about 0.4 s per commit, so SmartTest's analysis costs about as much as the tests it skips. Release and dependency commits make up half the window. `smarttest run` switches to running everything once a full run is recorded as faster than a typical analysis (adaptive policy); `benchmark` measures the selection only and does not apply that policy.
- **LeadsIt**: 12 commits, 5 test files run out of 1,225, no fallback. Eight commits select nothing (SEO pages, docs, ads configuration), and the full runs confirm that none of them broke a test.
- **OpenPro front end**: see below.

### OpenPro front end

About 9,600 TypeScript files and 2,164 test files (2,086 Vitest, 78 Playwright), installed with npm. This is the largest workload. Three things differ from the other repositories:

- **Playwright excluded.** The 78 Playwright specs need a browser and the deployed environment, and SmartTest selects them conservatively because their imports cannot be resolved. They are excluded with `exclude: ["e2e/**"]` added to the generated configuration. The 1.0.0 hook scope (`hook.runners`) is the way to keep them out of a commit hook while CI still runs them, but `benchmark`, like `run`, ignores the hook scope, so `exclude` is what this measurement used. Results therefore cover the 2,085 Vitest files only.
- **8 GB heap.** Vitest ran with `NODE_OPTIONS=--max-old-space-size=8192`, since the project's own `vitest related` runs out of the default 4 GB heap (see the 0.9.0 delivery log).
- **6 commits, not 12.** One full run takes about 113 s.

| Commit     | Change                                   | Selected      | Full    | SmartTest | Failing in the full run | Already failing | Missed |
| ---------- | ---------------------------------------- | ------------- | ------- | --------- | ----------------------- | --------------- | ------ |
| `c01bbca7` | missions: clip buffering                 | 11 / 2,073    | 112.7 s | 6.4 s     | 21                      | 20              | 0      |
| `d1ac6e05` | missions: rendition warm-up              | 14 / 2,084    | 112.7 s | 4.3 s     | 21                      | 20              | 0      |
| `1c8c4043` | dependency patches (lockfile)            | 2,084 / 2,084 | 112.7 s | 114.3 s   | 21                      | 0               | 0      |
| `4769749f` | media: sound-track polling               | 4 / 2,085     | 114.3 s | 3.8 s     | 21                      | 20              | 0      |
| `aa5daf8d` | links: listener cleanup                  | 4 / 2,085     | 113.6 s | 2.7 s     | 21                      | 20              | 0      |
| `67d875cb` | stories: voice channels across refreshes | 4 / 2,085     | 112.7 s | 2.8 s     | 21                      | 20              | 0      |

- 0 missed failures and 0 cache-integrity violations. SmartTest saves 80% of the full-run time (11 min 19 s → 2 min 14 s). Without the lockfile commit, the five other commits run 37 test files in 20 s instead of 9 min 26 s of full runs.
- The same 21 component tests (mostly `src/components/messages/bubble/…`) fail in every full run on this machine. On the five selective commits, 20 of them were not selected and fail on the parent commit too, so they count as already failing (100 in total). The remaining one was selected. On the lockfile commit everything was selected.
- Analysis takes 0.6–4.3 s per commit for a project this size. The first commit pays the cold index.

## 0.5.0 target: observed execution reduces the selection by 20%

Definition (0.5.0 gate): on the benchmark repositories, traces from observed execution reduce the selection by 20% or more, with 0 missed failures. Measured with `smarttest benchmark --commits 12 --traces`, which traces every test file at each parent commit (`smarttest trace`, V8 coverage) before selecting. That is the method LeadsIt used in 0.5.0. The comparison covers commits without a full-suite fallback, in the default BALANCED mode.

| Repository   | Static selection | With traces | Tests ruled out by traces | Tests added by traces | Missed |
| ------------ | ---------------- | ----------- | ------------------------- | --------------------- | ------ |
| LeadsIt      | 5                | 8           | 0                         | 3 (`c4ad92a4`)        | 0      |
| commander.js | 97               | 110         | 0                         | 13 (`373f660f`)       | 0      |

**Not met.** Traces ruled out no test on either repository. They added tests instead: in BALANCED mode a test is also selected when its trace ran a changed unit that static analysis does not reach (`observed-execution`).

Why on LeadsIt: the three added tests import unchanged helpers (`giftLeadIdsOf`, `giftOfJob`) from the changed `growth/gift/operations.ts`. The change adds a new function, `copyGift`, and a type alias. Neither unit has a V8 function name at the parent commit, and for such units [loading the file counts as running it](../concepts/runtime-evidence.md#how-traces-change-the-selection). That over-selects, but safely: the full runs passed. Static selection was already method-level and narrow (5 test files over 12 commits), which leaves traces almost nothing to remove. This is what 0.5.0 found too (11 → 10).

On commander.js, `373f660f` replaces a helper module with `node:util`. Static analysis selects 96 of 109 test files and the traces show the other 13 loading the changed file. Every commit that changes `package.json` or the lockfile runs everything either way.

## 0.8.0 target: 30% less test time than 0.7.0

Definition (0.8.0 gate): 30% less test time than 0.7.0 on the benchmark repositories, with 0 cache-integrity violations. Measured as SmartTest's total time (analysis plus execution) in `benchmark --commits 12`, with SmartTest 0.7.0 (tag `v0.7.0`, packed the same way) and the 1.0.0 candidate on the same clones, windows and machine, run one after the other.

| Repository     | 0.7.0  | 1.0.0 candidate, before merging the 1.0.0 performance work | 1.0.0 candidate | Change |
| -------------- | ------ | ---------------------------------------------------------- | --------------- | ------ |
| LeadsIt        | 6.3 s  | 6.6 s                                                      | 6.9 s           | +10%   |
| commander.js   | 7.7 s  | 8.2 s                                                      | 7.0 s           | −9%    |
| path-to-regexp | 23.8 s | 24.4 s                                                     | 25.2 s          | +6%    |

**Not met.** The difference is within run-to-run noise on all three. Cache-integrity violations: 0. The validated result cache never hits during a replay: each replayed commit is a state that has not been run before, and the benchmark runs SmartTest once per commit. What 0.8.0 added (the result cache, parallel runner groups, fail-fast ordering) helps a repeated run of the same state and multi-runner suites. A replay of fresh commits measures neither, and the remaining time is dominated by starting the runners and by analysis.

## Analysis time on LeadsIt

1,608 files, 8,403 symbols, 24,916 graph edges. The graph is now persisted in `.smarttest/state/graph.json`.

| Operation                      | 0.6.0 | 1.0.0 candidate                                      |
| ------------------------------ | ----- | ---------------------------------------------------- |
| Cold `scan` (no `.smarttest/`) | 3.6 s | 1.73 s (index 828 ms, all 1,608 files parsed)        |
| Warm `scan`                    | —     | 0.28 s                                               |
| Cold `impact --base HEAD~1`    | —     | 1.81 s wall, 1,466 ms analysis                       |
| Warm `impact --base HEAD~1`    | —     | 0.48 s wall, 471 ms analysis (graph loaded in 14 ms) |

The persisted graph cut graph time on a warm run from 42 ms (rebuilt) to 14 ms, and the warm `impact` from 0.61 s to 0.48 s wall. On a warm run, change detection (Git, 316 ms) is now the largest step. A full run through SmartTest (`run --all`): 724 tests passed in 103 files in 4.3 s.

## Problems found and fixed in SmartTest

| Found on          | Problem                                                                                                                                                                                                                                                | Fix                                                                                                                                                                                                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| path-to-regexp    | `@borderless/ts-scripts` points `core.hooksPath` into `node_modules/…/husky/node`. `init --yes` wrote SmartTest's block into that file, which belongs to the package and is replaced on the next install                                               | A hooks path inside `node_modules` is refused (`ST_HOOK_PATH_IN_DEPENDENCY`). `init` reports a hook it must not edit (also outside the repository, or not a shell script) as a warning and sets up everything else, where an outside hooks path used to make `init` fail |
| OpenPro front end | `vitest.config.ts` next to `vitest.stryker.config.ts` makes two Vitest roots in one directory. `benchmark` keyed group times by runner and directory only, so the project-gated baseline counted the one Vitest run twice (226 s for a 113 s full run) | Group times are keyed by runner, directory and config file. Execution was not affected: the standard config owns the files                                                                                                                                               |
| OpenPro front end | `init` validation listed both roots as "vitest (.) discovers 2086 test file(s)", each without its config                                                                                                                                               | Each root is listed with its own config file                                                                                                                                                                                                                             |

Tests: `packages/smart-init/src/hooks.test.ts` (hooks path in `node_modules`), `integration-tests/adoption.test.ts` (init with a refused hook), `integration-tests/real-world.test.ts` (two configs of one runner in the project-gated baseline; fails without the fix).

No selection bug was found: 0 missed failures everywhere.

## Not covered

- The 0.5.0 and 0.8.0 targets are not met, as described above.
- macOS and Windows were not used here.
- The package is not on npm yet. The CLI was run from the packed build.
