# Case study: LeadsIt

LeadsIt was the first real repository migrated to SmartTest (commit [`d310fbac`](https://github.com/RemiPelloux/LeadsIt/commit/d310fbac)). It's a good test because it isn't a tidy fixture:

- **No root `package.json`.** Six independent projects (`backend/`, `FrontLeadsIt/app/`, `mcp/`, `docs/growth/outbound/`, …), each with its own lockfile.
- **Three runners.** Jest (backend, CommonJS JS), Vitest with a custom config (`vitest.server.config.ts`, TypeScript, Wasp) and Node's built-in `node --test` (twice, once with a directory argument).
- **Tests loaded through computed paths.** For example ``import(`${SCRIPTS}finalize-prerender.mjs`)``.
- **Generated output and a submodule.** Wasp's `.wasp/` (with its own `package.json` files) and an `apify` submodule.
- **A pre-commit hook** that ran whole suites per touched project and skipped Redis-dependent tests with `--testPathIgnorePatterns`.

## Rule of the exercise

**Only built-in commands.** `npm install`, `npx smarttest init --yes`, `smarttest run --staged` in the hook, `smarttest benchmark`. Whenever SmartTest needed a custom flag or a hand-written config to work, that counted as a SmartTest bug, and it was fixed in SmartTest.

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

`npm run test:all` through SmartTest: **706 passed, 0 failed**. That's identical to the native runners: Jest 177 + Vitest 489 + MCP 30 + outbound 10, with the Redis suites skipped as before.

## Result: history benchmark

`npx smarttest benchmark --commits 12` replays the last 12 commits in a temporary worktree. For each one it compares a full run, a project-gated run (the suites of every touched project, which is what the old hook did) and SmartTest. Every failure that wasn't selected is re-checked on the parent commit.

|                    | Full run | Project-gated | SmartTest  |
| ------------------ | -------- | ------------- | ---------- |
| Total time         | 110.3 s  | 37.2 s        | **13.8 s** |
| Saved by SmartTest | 88%      | 63%           | —          |
| Tests run          | 1192     | —             | 9          |

**Missed failures: 0** · failures already present in the parent commit: 0

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

## Caveats

- **LeadsIt's suites are already fast** (about 5–8 s for everything), so the absolute saving per commit is seconds, not minutes. The percentage is what carries over to larger suites.
- **The first run in a fresh checkout pays a cold start** (about 3.5 s: parsing ~1,600 files and asking each runner for its file list). Both are cached afterwards. Faster cold start is planned for 1.1.
- **Commits outside tested projects run nothing.** That's correct, but it also means "gated" can be 0 ms on those commits, and the old hook didn't run anything for them either.
- **Root `package.json`, lockfile and `tsconfig` changes run the full suite or the project's suite.** That's deliberate: they're mandatory triggers.
