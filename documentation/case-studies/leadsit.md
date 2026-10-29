# Case study: LeadsIt

LeadsIt was the first real repository migrated to SmartTest (commit [`d310fbac`](https://github.com/RemiPelloux/LeadsIt/commit/d310fbac)). It's a good test because it isn't a tidy fixture:

- No root `package.json`. Six independent projects (`backend/`, `FrontLeadsIt/app/`, `mcp/`, `docs/growth/outbound/`, …), each with its own lockfile.
- Three runners. Jest (backend, CommonJS JS), Vitest with a custom config (`vitest.server.config.ts`, TypeScript, Wasp) and Node's built-in `node --test` (twice, once with a directory argument).
- Tests loaded through computed paths. For example ``import(`${SCRIPTS}finalize-prerender.mjs`)``.
- Generated output and a submodule. Wasp's `.wasp/` (with its own `package.json` files) and an `apify` submodule.
- A pre-commit hook that ran whole suites per touched project and skipped Redis-dependent tests with `--testPathIgnorePatterns`.

## Rule of the exercise

Only built-in commands. `npm install`, `npx smarttest init --yes`, `smarttest run --staged` in the hook, `smarttest benchmark`. Whenever SmartTest needed a custom flag or a hand-written config to work, that counted as a SmartTest bug, and it was fixed in SmartTest.

## What it forced into the product (0.2.0)

| Problem found on LeadsIt                                                      | Fix in SmartTest                                                                                                               |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| No runners found: no root manifest, no workspace config                       | Nested projects are discovered without a workspace manifest                                                                    |
| `vitest.server.config.ts` ignored, and the config wasn't passed to the runner | Custom config names and `--config` in scripts are detected and passed through                                                  |
| `node --test` not supported                                                   | New `@smarttest/adapter-node` (JUnit reporter); directory arguments follow Node's semantics exactly                            |
| Test-looking files the runner doesn't collect were counted                    | Runner-accurate discovery: each runner lists what it collects (cached)                                                         |
| `.wasp/` build output counted as 20 projects / 1,900 modules                  | File listing respects `.gitignore` through `git ls-files`, and submodules are skipped                                          |
| Redis suites excluded only by a hook flag                                     | `init` reads hooks, scripts and CI for `--testPathIgnorePatterns` / `--exclude` and carries them over                          |
| Two tests ran on every commit (computed `import()` paths)                     | Static evaluation of constants, `new URL(…, import.meta.url)`, `resolve(__dirname…)`, templates → exact files or bounded globs |
| SAFE mode fell back to the full suite on unrelated uncertainty                | SAFE selects uncertain tests individually; full suite only when the change analysis itself is incomplete                       |
| SmartTest's own `.smarttest/` state showed up as changes                      | Own state is never a change                                                                                                    |
| `.env.*.example` files were mandatory triggers                                | Only real env files trigger                                                                                                    |
| Two `auth/` folders → duplicate rule names (invalid config)                   | Unique suggested rule names                                                                                                    |
| No way to prove savings on real history                                       | `smarttest benchmark --commits N`                                                                                              |

## Result: parity

`npm run test:all` through SmartTest: 706 passed, 0 failed. That's identical to the native runners: Jest 177 + Vitest 489 + MCP 30 + outbound 10, with the Redis suites skipped as before.

## Result: history benchmark

`npx smarttest benchmark --commits 12` replays the last 12 commits in a temporary worktree. For each one it compares a full run, a project-gated run (the suites of every touched project, which is what the old hook did) and SmartTest. Every failure that wasn't selected is re-checked on the parent commit.

|                    | Full run | Project-gated | SmartTest |
| ------------------ | -------- | ------------- | --------- |
| Total time         | 110.3 s  | 37.2 s        | 13.8 s    |
| Saved by SmartTest | 88%      | 63%           | —         |
| Tests run          | 1192     | —             | 9         |

Missed failures: 0 · failures already present in the parent commit: 0

| Commit                                                        | Changed | Selected | Full   | Gated  | SmartTest | Missed |
| ------------------------------------------------------------- | ------- | -------- | ------ | ------ | --------- | ------ |
| `ebd4ef85` fix(outbound): a Composio error after Gmail had se | 2       | 1/99     | 7.9 s  | 382 ms | 3.5 s     | 0      |
| `56156435` feat(outbound): every cold email thread is filed i | 4       | 1/99     | 8.5 s  | 477 ms | 793 ms    | 0      |
| `47606fc6` fix(outbound): Gmail replies thread for the prospe | 2       | 1/99     | 8.4 s  | 454 ms | 1.0 s     | 0      |
| `1cfffe0a` feat(outbound): samples a web agency can use as de | 3       | 1/99     | 9.5 s  | 453 ms | 957 ms    | 0      |
| `a1b6112f` feat(seo): titles for the searches Search Console  | 27      | 0/99     | 7.7 s  | 4.6 s  | 356 ms    | 0      |
| `94d41f82` fix(admin): the owner's own purchases are not reve | 3       | 1/99     | 7.0 s  | 4.0 s  | 953 ms    | 0      |
| `d4338904` fix(ads-monitor): the owner's own test purchases a | 1       | 0/99     | 7.8 s  | 0 ms   | 203 ms    | 0      |
| `8c3f094e` fix(admin): melbdu93@live.fr's January payments (2 | 2       | 1/99     | 12.5 s | 5.9 s  | 1.9 s     | 0      |
| `0da20f4a` feat(admin): Cold outreach (owner, 2026-10-29): ev | 21      | 2/100    | 16.6 s | 10.5 s | 2.8 s     | 0      |
| `88bdcd48` fix(admin/outreach): every stage at a glance above | 2       | 0/100    | 9.3 s  | 5.7 s  | 423 ms    | 0      |
| `e6fbfdee` docs(outbound): admin → Outreach and sync_admin.mj | 1       | 0/100    | 8.3 s  | 375 ms | 189 ms    | 0      |
| `42c7810f` feat(outbound): a check-in 4 days after a free lis | 7       | 1/100    | 6.9 s  | 4.3 s  | 631 ms    | 0      |

Times are wall-clock on this machine. SmartTest time includes its analysis overhead.

## Update: 0.5.0

LeadsIt now vendors SmartTest 0.5.0 (`tools/smarttest/smarttest-0.5.0.tgz`). Parity is unchanged: `npm run test:all` passes 706 tests. `smarttest trace` records all 100 test files (Jest, Vitest and both `node --test` projects) in 23 seconds.

The benchmark window moved by two commits: the last two are the SmartTest migration itself, which change the root `package.json` and lockfile and therefore run everything.

| Commit                                                   | Changed | Static  | With traces | Missed |
| -------------------------------------------------------- | ------- | ------- | ----------- | ------ |
| `47606fc6` fix(outbound): Gmail replies thread for the p | 2       | 1/99    | 0/99        | 0      |
| `1cfffe0a` feat(outbound): samples a web agency can use  | 3       | 1/99    | 1/99        | 0      |
| `a1b6112f` feat(seo): titles for the searches Search Con | 27      | 0/99    | 0/99        | 0      |
| `94d41f82` fix(admin): the owner's own purchases are not | 3       | 1/99    | 1/99        | 0      |
| `d4338904` fix(ads-monitor): the owner's own test purcha | 1       | 0/99    | 0/99        | 0      |
| `8c3f094e` fix(admin): melbdu93@live.fr's January paymen | 2       | 1/99    | 1/99        | 0      |
| `0da20f4a` feat(admin): Cold outreach                    | 21      | 4/100   | 4/100       | 0      |
| `88bdcd48` fix(admin/outreach): every stage at a glance  | 2       | 0/100   | 0/100       | 0      |
| `e6fbfdee` docs(outbound): admin → Outreach and sync_adm | 1       | 0/100   | 0/100       | 0      |
| `42c7810f` feat(outbound): a check-in 4 days after a fre | 7       | 3/100   | 3/100       | 0      |
| `d310fbac` chore(tests): run only the tests a commit aff | 9       | 100/100 | 100/100     | 0      |
| `f25b41e6` chore(tests): update vendored SmartTest 0.2.0 | 2       | 100/100 | 100/100     | 0      |

What changed compared with 0.2.0:

- `0da20f4a` and `42c7810f` select more tests (2 → 4, 1 → 3). Both change `schema.prisma` and translation catalogs. 0.2.0 ignored schema changes entirely; 0.4.0 selects the code using the changed models and translation keys.
- The first 0.4.0 build selected 37 test files for `0da20f4a`. Helpers such as `getFooterNavigation(t)` call `t(item.nameKey)`, which counted as "reads any translation key", and the generated `auth-critical` and `payment-critical` rules then ran every auth and payment test. Translation keys are now qualified by the namespace bound with `useTranslation("ns")`, and a `t` received as a parameter reads in its callers' namespaces. The commit selects 4.
- Traces removed one test (`47606fc6`): the outbound test loads the changed file but never calls the changed function. Over the ten commits that do not touch the lockfile, observed execution reduced the selection from 11 to 10 test files. Static selection on LeadsIt is already narrow, so the 20% reduction targeted by the 0.5.0 gate is not reached here.

A wider run, `smarttest benchmark --commits 200 --sample 40` (40 commits spread over the last 200), found 0 missed failures. SmartTest ran 522 of 3,052 test-file runs (17%), 354 of 2,884 on the 38 commits without a lockfile change, and saved 63% of the full-run time. Against the project-gated baseline it was 6% slower: on single-project commits the old hook runs one small suite, and SmartTest's analysis time is counted in full.

## Update: 0.6.0 to 0.8.0

| Version | What changed on LeadsIt                                                                                                                                    | Measured                                                                                                                                                                                                                 |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0.6.0   | `smarttest hook status` recognises the existing husky hook; `smarttest ci` picks the base by itself; parse in worker threads and parallel runner discovery | cold `scan` 5.5 s → 3.6 s; 12-commit replay at 0 missed failures                                                                                                                                                         |
| 0.7.0   | `sync`, `watch`, `migrate`; Playwright and Cypress adapters (LeadsIt has no end-to-end suite in its hook)                                                  | 706/706 through SmartTest                                                                                                                                                                                                |
| 0.8.0   | Runner groups (Jest, Vitest, two `node --test` projects) run in parallel; validated result cache                                                           | full suite 7.7 s → 5.2 s; a repeated run of the same state 4.1 s → 1.2 s (93 of 100 files from the cache, labelled "cached, not run"); 12-commit replay 47.2 s → 43.4 s, 0 missed failures, 0 cache-integrity violations |

LeadsIt vendors each release in `tools/smarttest/` (currently `smarttest-0.8.0.tgz`) until the package is on npm.

## Caveats

- LeadsIt's suites are already fast (about 5–8 s for everything), so the absolute saving per commit is seconds, not minutes. The percentage is what carries over to larger suites.
- The first run in a fresh checkout pays a cold start: about 3.6 s with 0.6.0 (it was 5.5 s), for parsing about 1,600 files and asking each runner for its file list. Both are cached afterwards.
- Commits outside tested projects run nothing. That's correct, but it also means "gated" can be 0 ms on those commits, and the old hook didn't run anything for them either.
- Root `package.json`, lockfile and `tsconfig` changes run the full suite or the project's suite. That's deliberate: they're mandatory triggers.
