# Running less, faster

Selection decides which tests can be affected. Four more mechanisms make the remaining run shorter, and none of them turns a test that was not run into a pass.

## Validated result cache

A test file's passing result is reused when nothing that can change the result has changed since it passed. The cache key is a hash of:

- the test file and every file in its static dependency closure, plus the files its last fresh trace loaded;
- the runner's config file, `package.json` and lockfiles, `tsconfig*.json`, `.env*` files, Babel/SWC config, setup files and `__mocks__/` files in its project;
- its snapshot file;
- the Node.js major version, the runner and its installed version, and the SmartTest version.

Tests are never cached when their dependencies include an import SmartTest cannot resolve, a file read through `fs`, when they run in Playwright or Cypress, or when their history shows a flaky result. Only clean passes are stored (no retries), at most three keys per file.

A reused result has the status `cached-pass`. The terminal shows `⧉ … cached, not run`, the summary counts it separately (`2 cached (not run)`), the HTML and Markdown reports list it as cached, and JUnit names the test case `… (cached, not run)`. It never counts as passed in this run. `run --no-cache` or `cache: false` turns it off; `run --all` and `run --coverage` never use it.

`benchmark` checks the cache: a cached pass whose test fails in the same commit's full run is an integrity violation, reported and counted as a failure of the benchmark.

## Fail-fast order and `--bail`

Selected test files run in this order: files with a failure in their last five recorded runs first (newest failure first), then by graph distance from the change (closest first). Runner groups start in the order of their first file. `--bail` stops starting new runner groups once one has a failure; groups not started are reported as `cancelled`.

## Parallel runner groups

Each runner project is a group (LeadsIt has four: Jest in `backend/`, Vitest in `FrontLeadsIt/app/`, two `node --test` projects). With `parallelGroups: "auto"` (the default), up to `min(groups, CPUs / 4, 4)` groups run at the same time, and each gets an equal share of the CPUs as its worker count unless `workers` is set. Playwright and Cypress groups always run alone, after the others, since they usually start servers. `parallelGroups: 1` runs groups one after another.

## Sharding

`smarttest run --shard 2/4` runs the second of four shards of the selection. Files are spread by their recorded durations (longest first onto the lightest shard); a file without a duration counts as the median. Every machine of a CI matrix must see the same `.smarttest/state/durations.json` (restore it from a cache) to get the same split. `smarttest shard --total 4 --index 2` prints a shard's files without running them.

## Flaky tests

Every fresh result is recorded per test in `.smarttest/state/history.json` (last 30 statuses, run, failure and flaky counts). `smarttest flaky` lists tests whose results flip between pass and fail, or that passed only on retry, above a rate (`--min-rate`, default 5%), and prints a rule that retries them. SmartTest never skips a flaky test on its own.

## Watch mode and graph patches

`smarttest watch` keeps the index and the graph in memory. When a save changes only bodies (what other files see of the file — imports, exports, declarations — is the same), the graph is patched: the edges the file contributes are removed and rebuilt. Other saves rebuild the graph. On the 2,000-module benchmark a patch takes under a millisecond and a rebuild about 60 ms.
