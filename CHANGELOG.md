# Changelog

All notable changes are documented here. Releases are managed with [Changesets](https://github.com/changesets/changesets). The project follows [Semantic Versioning](https://semver.org/).

## Unreleased

### Changed

- A push that creates a branch compares with the last commit a pre-push hook passed on, not with the whole history. On openpro-front a new branch meant 14,377 changed files and a 27-minute hook. A commit pushed with the hook bypassed has no passed record, so a new branch carrying it still checks it; with no passed record at all, the whole history is still compared.
- `init` keeps a parallel pre-push parallel: when the test step it replaces runs in the background and the script waits for its PID (`step & PID=$!` … `wait $PID`), SmartTest starts as a background job under that variable instead of running before the other steps. `hook uninstall` restores the script.

## [1.1.1] — patch

### Fixed

- `SMARTTEST_PYTHON=python` (a bare command) is looked up on `PATH`; it resolved to a file named `python` in the project, so no Python test could start.
- A changed file named like a test that no runner runs (a Vitest setup file under `__tests__/`, or a `*.live.test.ts` the config excludes) was selected as a test and reported as not run, failing the hook. A file a runner loads (setup files, module mappings) is a helper, and a file the analysis excludes is never a test. Seen on openpro-front when a push creating a branch compared with the whole history.

## [1.1.0] — minor

Angular; `smarttest audit`, which measures missed tests instead of assuming none; a Python preview (pytest and unittest); lockfile changes selected by package; and fixes found by the audits and by an adopting project's hooks. Additive under the [semver policy](documentation/reference/contracts.md#semver-policy): new adapters (`angular`, `pytest`, `unittest`), `runners[].project` and `python` in the config schema, new commands and flags (`audit`, `--runner`), and `"python"` as an analysis language; nothing frozen changes. Some selections grow (Angular templates and stylesheets, Wasp load-time code, files a type-checking runner compiles), some shrink (dependency updates), a hook now stops the commit when SmartTest is not installed, and `run` no longer stops before any test runs when SmartTest hits a fault. Python files are analysed by default; `python: { enabled: false }` turns that off. Run `smarttest hook install` again to update an installed hook.

### Added: Python (preview)

- pytest and unittest projects are detected next to the JavaScript runners (`smarttest doctor`: `unittest (.) collects 14 test file(s)`) and run through their runner: pytest from `--collect-only` and its JUnit XML, unittest through its own loader. A file that does not import, or in which pytest collects nothing, is a failure, never a pass.
- `.py` files are analysed without running Python: functions, classes, methods, module values and the code that runs at load; absolute and relative imports, packages, `src/` layouts and `pythonpath`; `conftest.py` files, and fixtures linked by name to the nearest `conftest.py` that names them (autouse fixtures and `pytest_*` hooks reach every test below). `importlib.import_module(name)` and imports found nowhere (project, standard library, declared or installed packages) are uncertainty.
- A Python project in a subfolder (`service/pyproject.toml` beside a Vitest app) resolves its imports from its own folder and its own dependencies; each side's changes select only its own tests. A module depends on the load-time code of its packages' `__init__.py` files.
- Config: `python.enabled` (default true) and `python.interpreter`; `SMARTTEST_PYTHON` overrides. Python project files (`pyproject.toml`, `pytest.ini`, `requirements*.txt`, `poetry.lock`…) are triggers.
- OpenProAuto (295 unittest tests): the full suite through SmartTest gives unittest's results; 29 replayed commits, 0 missed failures; 190 injected faults, 0 missed. Its suite runs in 0.6 s, so selection does not save time there. Guide: [Python](documentation/guides/python.md).


### Added: `smarttest audit` measures selection

- `smarttest audit --mutate` breaks one function at a time (it throws on entry) in a temporary checkout of HEAD, lets SmartTest select for that change, then runs the full suite: a test that fails but was not selected is a missed test, by definition. Functions are sampled with `--mutants n` (default 10) and `--seed n`, within `--budget ms`; failures that also happen without the fault are left out, and a miss that passes alone with the fault in place is load-flaky. The project's files are never touched.
- `smarttest audit --traces`: each test file runs alone while SmartTest records the code it ran (V8 coverage), the files it read through `fs` (templates, JSON, fixtures) and, for Python, the modules it imported and the files it opened; every such project file must reach that test through the graph, the runner's configuration, or uncertainty (`--sample n` limits the run). Environment files are tracked by key and left out, and so are files version control does not list (an ignored build output can never be part of a change).
- `smarttest audit --resolution`: every import the TypeScript compiler resolves into the project must resolve to the same file in SmartTest; one SmartTest takes for a package is an edge it cannot see.
- `audit --mutate` and `audit --traces` follow `hook.runners` like `benchmark` (`--runner`, `--runner all`), so a suite against a live environment is never started.
- One report, `.smarttest/reports/audit.{json,md}` (`-o file.md` to copy it): missed tests, unreachable files, mismatched imports, load-flaky failures and the share of functions checked. Exit code 1 when a check finds a miss, for CI.
- A nightly workflow (`.github/workflows/audit.yml`, `pnpm audit:fixtures`) audits every fixture that needs no browser; any miss fails it. Its JSON (`audit --json`) is experimental.
- Galdia: 5,003 imports agree with the compiler; 10 injected faults, 4 caught, 6 survived (code no test exercises), 0 missed.
- Checked that each check reports a miss when there is one: a test loading a module by a computed name in FAST mode (missed by design there) is reported by `--mutate`, and a load the graph lacks by `--traces`.

### Added: lockfile changes select by package

- A change to `package-lock.json`, `pnpm-lock.yaml` or `yarn.lock` (Classic and Berry) is diffed by package: the packages whose resolved entry changed, and the packages depending on them, select the code that imports them, and `@types/x` the code importing `x`. A `package.json` change to its dependency lists does the same. Before, any lockfile or `package.json` change selected every test. On opal-frontend, a `@types/lodash` bump selected 0 of 351 specs instead of all.
- Everything is still selected, with the reason in the trigger message, when the change cannot be told apart safely: a test or build tool or something it depends on, a declared package no analysed file imports (lint and format tools excepted), a package a runner config or setup file loads or a stylesheet names, a lockfile setting, or another `package.json` field. Most of opal-frontend's dependency updates are such cases (the Angular builder lists the `@angular/*` packages as peers; `test-setup.ts` loads the shared component library), and still run everything.
- New fixture `lockfile-packages`.

### Added: the hook budget explains itself

- When the estimate passes `hook.budgetMs`, the warning names what widened the selection ("346 tests: yarn.lock changed …: vitest changed, a test or build tool") and the files with no recorded duration.

### Added: `// smarttest-loads:` for computed imports

- A comment on or above a computed `import()`/`require()` names, relative to the project root, what it may load (`// smarttest-loads: plugins/*.mjs`). Those files become its dependencies instead of uncertainty, which selected every test reaching the import on every change. SmartTest's own config and plugin loaders are annotated: on this repository a core change selects 37 of 114 test files instead of 53, a fixture change 17 instead of 53.

### Added: `--runner <name>`

- `run`, `impact`, `validate-selection` and `benchmark` take `--runner <name>` (repeatable): an adapter id (`vitest`), an Angular project or a runner's directory. Other runners' tests are left out of the analysis with a warning that counts them, never reported as skipped or passed. Keeping Playwright out of a parity check or a benchmark no longer needs a copied config. `benchmark` follows `hook.runners` when it is set (`--runner all` for every runner). An unknown name fails with `ST_RUNNER_UNKNOWN` and lists the runners there are.

### Fixed: a test no change could select

- A module a trigger file imports (a local PostCSS plugin `postcss.config.cjs` requires, a preset a Babel config imports) selected nothing when it changed; it now applies that trigger, like a change to the configuration itself. Found by `audit --traces` on openpro-front (`scripts/postcss/drop-broken-color-mix-fallback.cjs`).
- A test that walks a directory (`readdirSync` in a recursive function, from a folder built from `import.meta.url`) depends on every file below that folder, and a source file it reads as text is selected by any change to that file, comments included. Found on openpro-front (`adsI18nKeys.test.ts` scans `src/ads/` for translation keys).
- A part of a read path SmartTest cannot evaluate (`resolve(process.cwd(), "public", AVATAR.slice(1))`) matches files at any depth below the known part; it matched one level only, so openpro-admin's `public/assistant/mia-avatar.png` selected no test.
- A computed worker or import path written with the compiled extension (`new URL("./parse-worker.js", import.meta.url)`) finds its `.ts` source instead of being uncertainty.
- A file read through `process.cwd()` (`readFileSync(resolve(process.cwd(), "src/ads/index.html"))`) selects the tests reading it; the runner's directory is taken to be one of the directories above the reading file. Found on openpro-front.

- Wasp: code an operation runs when it loads (a top-level statement in `src/ops/getTotal.ts`) breaks every test importing the operations module, since that module loads every operation; only the code calling that operation was selected. Found by `smarttest audit --traces` on the `edges-vitest` fixture. A change inside the operation's function still selects only its callers.

- A test a runner collects inside a folder named like build output (`src/tests/build/`, `e2e/out/`) was never analysed, so no change selected it (OpenPro). `dist`, `build`, `out` and `coverage` are now build output only next to a `package.json`; the default `exclude` no longer lists them.
- A file a runner collects that SmartTest does not analyse (excluded by `exclude`/`include`, or in a build-output folder) is reported by `impact`, `run`, `doctor` (warning) and `scan` (`tests.notAnalysed`), never dropped silently.

### Fixed: Yarn's own files are not project source

- `.yarn/` (Yarn's vendored release, plugins, cache and SDKs) and its generated `.pnp.cjs` and `.pnp.loader.mjs` are excluded by default. opal-frontend indexed its 2 MB `.yarn/releases/yarn-4.17.1.cjs` as source; the audit sampled functions from it.

### Fixed: tests that share a name are counted one by one

- Results with the same id in one run (`it.each` rows whose title has no placeholder, two `it("works")` in a file) used to be merged into one result, the worst of them. Each now keeps its own id: the second is `<file>::<name> (2)`, the third `(3)`. Reports, the result cache and flaky history count every row (on opal-frontend, 15 rows sharing a title had made SmartTest report 4,039 tests where `ng test` reported 4,054), a failing row is still never hidden, and a retried row keeps its number, so only that row is reported flaky.

### Fixed: faults end in a full run, never in a smaller selection or a pass

- `run` and the hooks no longer stop before any test runs when SmartTest itself hits a fault: changes that cannot be read (Git cannot hash a file it may not read), a plugin whose edge provider fails, or an unexpected error in the analysis select every test, with the reason as a warning. An explicit `--base <ref>` that cannot be read is still an error (exit 4): it is the user's to fix. `impact` still reports the error.
- A state folder SmartTest cannot write (a file where `.smarttest/state` should be, no permission, a read-only disk) no longer stops the run with exit 70: the run uses a temporary state folder and says so.
- A new fault-injection suite (`integration-tests/fail-safe.test.ts`) proves each case on a project with a broken test: every state file garbled, half-written or emptied, state signatures deleted, an unwritable state folder, unreadable changes, a failing plugin and a runner killed in the middle of a file. Each run selects at least what a clean run selects and reports the failure.

### Added: load-flaky failures told apart in `benchmark`

- A failure the selection did not include is run again alone, on the parent commit (as before: failing there means it was already broken) and now on the commit itself. One that passes alone on both failed only next to other tests (load, order, shared state): it is reported as load-flaky (`loadFlaky` in the JSON, its own count in the Markdown report), never counted as a miss or as a pass. In 1.0.2, `MiaDock.test.tsx` (openpro-admin) and `tournament-pool.test.ts` (Galdia) were such failures and had to be checked by hand.

### Fixed: commit and push hooks

- A hook installed by SmartTest stops the commit or push when SmartTest is not installed (`smarttest is not installed: install the project's dependencies first…`), instead of printing a warning and letting the change through unchecked. `--no-verify` still skips it. Run `smarttest hook install` again to update an installed hook.
- The hook's time estimate counts the runner's parallel workers: per runner, the larger of its slowest file and its total over its workers (`--workers` / `workers`, or the runner's default). It used to add every file's duration as if they ran one after another, so a run of 19.5 s was announced as "Estimated 2m 27s exceeds the 1m 0s budget".
- The temporary checkout of a staged or pushed change (and `audit --mutate`) links the project's untracked build output (`dist/`, `build/`, `out/`, `.output/`), with a warning that it may not match the source. openpro-mcp-service's tests read `ui/dist/job-draft.html`, built by `npm run build:ui`: they failed in the checkout and nowhere else.
- `benchmark` prepares its checkout like the hooks do (installed packages mirrored, untracked build output linked). It linked `node_modules` as a whole, and Vite refused `?url` imports of installed files there ("Denied ID"): on openpro-front, 24 test runs failed in the replay and nowhere else, counted as failures already present.
- A pre-push step that does not receive Git's refs on stdin (run in the background with `&`, or behind a tool that keeps stdin) compares HEAD with its upstream merge-base, with a warning, instead of failing with `ST_HOOK_PUSH_REFS_MISSING`. `hook install` gives the refs the SmartTest block saved to a backgrounded test step in the same hook (`printf … | npx vitest related --run &`), and `hook uninstall` restores the line.
- A hook script the repository keeps in its tree and copies into `.git/hooks` (`cp scripts/hooks/pre-commit $(git rev-parse --git-path hooks)/` in a `prepare` script, or `install -m 755 …` in a shell script it runs) is edited at its source, with a note to run the copy command again; `hook status` says when the installed copy does not run SmartTest yet. Before, SmartTest edited the copy, which the next install overwrote.
- `init` installs into the hook where the repository already runs its tests: a related-tests step kept in pre-push (`npx vitest related --run … &`) is replaced there instead of adding a pre-commit step. A hooks folder held in a variable (`H=$(git rev-parse --git-path hooks) && cp scripts/pre-commit "$H/"`) is followed. Checked on the commit before SmartTest in each of OpenPro's four repositories: `init --yes` writes the hand-tuned config verbatim and the hook in the same file and stage.
- `init` puts the SmartTest block where the test step it replaces was, in a pre-commit hook, so the steps before it (lint, format) still run first. A step inside an `if` or a loop, and every pre-push hook, keep the block on top.
- The staged checkout no longer reports "Isolation incomplete" for pnpm's hoisted links (`node_modules/.pnpm/node_modules/<workspace package>`): only an installed package importing a workspace package it does not declare goes through them, and project code resolves workspace packages to the content under test. Checked in a pnpm workspace with an unstaged edit that would fail the test. An installed package that does depend on a workspace package is still reported, now by name.

### Fixed: Angular templates and styles selected no test

- A component's `templateUrl`, `styleUrl` and `styleUrls` link it to those files. Changing `foo.component.html` used to select no test at all; it now selects the tests of `FooComponent` and of the code that imports it. A path SmartTest cannot evaluate is uncertainty.
- A stylesheet reaches code through the stylesheets that import it: changing a Sass partial (`_vars.scss`), a Less file or a CSS file pulled in by `@use`, `@forward` or `@import` selects the tests of every component or module whose stylesheet imports it, directly or transitively. Imports through load paths (Angular's `stylePreprocessorOptions.includePaths`) match by path suffix, so they select more, never less.
- New fixture `angular-vitest`, in the regression harness.

### Added: Angular CLI projects run through `ng test`

- A new `angular` runner. Each project of an `angular.json` whose `test` target uses the unit-test builder (`@angular/build:unit-test`, Vitest) is detected as its own runner and run with `ng test <project> --include …`, so the specs are compiled the way the project compiles them. Before, SmartTest ran the builder's Vitest directly, and every spec of a new Angular 22 app failed with `describe is not defined`. A build error (a compile error in a spec or in what it imports) fails the run with the compiler's message, never a pass.
- `angular.json` is the runner's configuration: changing it, the test or build target's `tsConfig` (`tsconfig.spec.json` by default), `runnerConfig`, `setupFiles`, `providersFile`, polyfill files or global `styles`/`scripts` selects that project's specs. `explain` names them ("global stylesheet of angular (styles in angular.json)").
- `ng test` type-checks everything a spec imports, so a change to any file a spec reaches selects it, even an export no test runs (a type error there fails the build). Comment and formatting changes do not.
- Lazy routes in the legacy string form (`loadChildren: "./admin/admin.module#AdminModule"`) are import edges; `loadComponent`/`loadChildren` with `import()` already were.
- `@angular-builders/jest` runs through `ng test` too (Jest's `--json` report, `--test-path-patterns` per spec); its `jest.config.js` is a partial config the builder completes, so Jest is never started on it directly. Jest does not type-check, so the type-check rule above does not apply to it.
- `jest-preset-angular` with a plain Jest config and Analog's `@analogjs/vitest-angular` run through the existing Jest and Vitest runners; their setup files select every spec.
- Two runners in one directory that collect the same files: the runner the `test` script starts owns them, then one with a config file (the order in `adapters` comes first). Before, the first runner detected won, so a project that moved to Jest while the Vitest the Angular CLI installed stayed in its dependencies ran its specs with Vitest, and they failed.
- A Vitest config an Angular test target loads (`runnerConfig`, such as `vitest.config.ts`) is part of `ng test`, not a runner of its own, and a `test` script that starts `ng test` names the `angular` runner even when its flags say `--runner=vitest`. Found on HMCTS's opal-frontend, where the specs went to Vitest started directly and 2,530 of them failed.
- `fileReplacements`: the development build the unit-test builder compiles with often replaces `environment.ts` with `environment.development.ts`. A change to a replacement selects the specs that reach the file it replaces; it used to select nothing.
- Karma: a test target on Karma gives no per-test report, so it is refused with `ST_ANGULAR_KARMA_UNSUPPORTED` and a hint to move to the unit-test builder with Vitest, instead of being reported from the exit code. Its specs are listed from the target's `include` globs, so a workspace where a Karma project sits beside Vitest ones (ngx-datatable) runs the others and fails only when a Karma spec is selected.
- Config: `runners[].project` and the `angular` adapter value (both additive to the 1.0 schema). `detect` reports Angular as a framework.
- Checked against a real Angular 22 workspace (`fixtures/projects/angular-cli`, run by the new `angular (real install)` CI job): the full suite through SmartTest reports what `ng test` reports; a template change, a Sass partial and a type error each select and fail the right spec.

## [1.0.2] — patch

An audit of 1.0.1 (two soundness oracles on the six adopting projects, four reproduction-driven reviews) found ways a run could pass while the suite failed, and ways a change could skip a test it affects. Each is fixed with a test that fails without the fix. Under the [semver policy](documentation/reference/contracts.md#semver-policy) these are bug fixes: some selections grow, and some runs that passed now fail because the suite really failed. No contract changes; `explain --json` gains an optional `loadedBy` field.

### Fixed: a run passed while the suite failed

- A failing Vitest `beforeAll`/`afterAll` fails the file and quotes the error; the tests it stopped are "not run", never "skipped by the test itself".
- A runner that exits non-zero, or reports errors outside any test (Vitest unhandled errors, Playwright `globalTeardown`, Jest run errors), fails the run with the runner's own message, and nothing is cached as passed. This includes coverage thresholds the runner enforces.
- A failing Playwright setup project fails the run; the specs that depend on it are "not run".
- A file a runner collects is a test even when it is not named like one (Node's `test/*.js`, a custom Vitest `include`, Playwright `*.setup.js`).
- Cypress results are credited to a spec only with evidence; a skip on a retry no longer hides an earlier failure.
- `node --test` escapes glob characters in file names (`[id].test.js` ran another file), and runs with the test script's own Node flags (`--import`, `--require`, `--env-file`, `NODE_OPTIONS`…).
- Playwright file filters match the exact path: selecting `home.spec.ts` no longer also runs `myhome.spec.ts`.

### Fixed: a change skipped a test it affects

- Runner configuration: setup files (Vitest `setupFiles`/`globalSetup`, Jest setup files, environments and transformers, Playwright global setup/teardown, Cypress `supportFile`, `node --test --import/--require`), the modules a config imports (`mergeConfig` with a shared file) and `moduleNameMapper`/`alias` targets select that runner's tests. `explain` names them ("setup file of vitest"). They are part of the discovery and result-cache keys, with the full Node version, `.nvmrc`/`.node-version`/`.tool-versions`/`.npmrc` and PostCSS/Tailwind configs. New triggers: `playwright.config.*`, `cypress.config.*`, `postcss.config.*`, `tailwind.config.*`; a runner's own config selects only that runner's tests.
- Code: calls through an interface- or base-typed variable (`const r: Repo = new MemRepo()`, DI defaults, module singletons); `vi.doMock`/`jest.doMock` and nested mocks no longer hide a static import, and a mock factory that may reach the real module counts as loading it; scripts started as workers or child processes (`new Worker`, `fork`, `spawn`/`execFile` of `node`/`tsx`, template-literal paths) are dependencies of the caller; template-literal text changes are code changes, not formatting.
- Graph: the walk continues through a test file other tests import; Node's defaults include `.ts/.mts/.cts` when Node strips types; Vitest type tests (`*.test-d.ts`, `typecheck`, a `--typecheck` script flag) and `includeSource` tests are discovered, and type-only changes are never ruled out for them by traces.
- Path aliases in a referenced tsconfig are followed. A `tsconfig.json` that only lists `references` (Vite's React template) keeps its `paths` in `tsconfig.app.json`; SmartTest took every `@hooks/…`-style import for an npm package and dropped it, with no warning. OpenPro's admin lost 4,021 of its 9,065 dependency edges and its front end about 22,000. A bare import that is neither an alias nor a declared package is unresolved (its dependents cannot be ruled out), never silently external.
- Resolution: folders named like Node built-ins (`src/domain`, `constants`) resolve to the project; "installed" means declared in a `package.json` (a missing `node_modules`, the pnpm store, hoisting or Yarn PnP no longer hide an alias); workspace packages resolve to `src/`, not `lib/`/`esm/` builds; a referenced tsconfig applies only to the files it includes; conditional `exports` and disagreeing configs are uncertain; `package.json` `imports` are honoured; framework modules count only when the framework is detected; imports leaving the project are uncertain; Vite, Jest, webpack and Babel aliases are read.
- Cache: the stored import resolution is redone when `jsconfig.json`, an `extends` target, a bundler config or a `package.json` the resolver read changes, and when an imported asset is added or deleted.
- Change set: a deleted or renamed data file selects the code that reads it; untracked files are kept when the project is a subfolder of the repository; personal git settings (`diff.mnemonicPrefix`, `noprefix`, external diff, colour…) no longer change what SmartTest reads; changes outside the project select the project files that import them; a submodule bump becomes the files changed inside it, or selects every test using it.
- Traces: a trace records the environment variables its code read and is stale when one differs; a computed `process.env[x]` read means it never rules a test out. `.env.*` variants select the tests under their folder.

### Performance

- Previous file versions come from one `git cat-file --batch` process (400 changed files: 410 git processes to 9, 1.18 s to 0.51 s); the file listing is read once per command.
- Path rules no longer make analysis quadratic (400 files with two rules: 621 ms to 29 ms); a dynamic import no longer costs time per test.
- Adding or removing a file re-resolves only the imports it can affect (239 ms to 108 ms).
- `explain` for a test in the last decision answers from it (306 ms to 86 ms); TypeScript loads only when needed.
- State stays small: `traces.json` is compact (1,000 tests × 300 files: 118 MB to 6.6 MB; 3,000 × 500 no longer crashes), `last-decision.json` is a third of its size, the result cache, history and shadow log are pruned, and `discovery.json` is written only when it changes. Studio keeps state warm.
- Adaptive mode records a full-suite time only from a clean run, and the record expires, so a run where no test started can no longer force every later hook to run everything.

## [1.0.1] — patch

The first projects on 1.0.0 (Galdia, LeadsIt, four OpenPro repositories) showed one selection bug and three smaller ones. No contract changes.

### Fixed

- `ST_NO_RUNNER` names all five runners and how to set one up; it said "No Jest or Vitest setup found".
- A file named like a test that no runner collects but other files import (a render helper in `__tests__/`) is a helper, not a test. Selection now goes through it to the tests that import it, and a change to it selects them. Before, the helper was selected on its own and those tests were missed: the run failed with exit 4, and the hint (add it to `exclude`) would have hidden them. Found in OpenPro, where one helper stood for 12 specs.
- A runner whose listing fails no longer takes helpers in its filename fallback (they were treated as end-to-end specs and widened every selection).
- Vitest and Jest discovery read the runner's own config file: a second config in one folder (a Stryker config next to `vitest.config.ts`) listed the default config's files (2,298 instead of 29).
- "Cannot be ruled out" names the actual reason (`visits /, which no known route serves`, `unresolved import "./x"`, a dynamic import) instead of always saying "unresolved/dynamic imports".

## [1.0.0] — stable

1.0.0 is the first release on npm, as [`@tkmremi/smarttest`](https://www.npmjs.com/package/@tkmremi/smarttest) (`npm install -D @tkmremi/smarttest`; the command is `smarttest`). npm refused the bare name `smarttest` as too similar to `smart-test`. 1.0.0 freezes SmartTest's public contracts. From this release, the config schema, exit codes and `--json` schemas of the frozen commands only change in a major version ([contracts](documentation/reference/contracts.md)).

### Added

- Frozen contracts: a published JSON Schema for the config file (`@tkmremi/smarttest/schemas/config.v1.schema.json`), v1 schemas for every frozen `--json` command (`run`, `impact`, `scan`, `explain`, `ci --dry-run`, `doctor`, `shard`, `flaky`, `validate-selection`, `hook`, `sync`) and the error document, and pinned exit codes. Tests check real CLI output against the schemas and fail on schema/type/validator drift. Commands not listed are documented as experimental.
- Plugin SDK 1.0 (`@tkmremi/smarttest/plugin-sdk`): versioned (`apiVersion: 1`) runner, VCS, language and edge-provider contracts, and a conformance kit (`@tkmremi/smarttest/plugin-sdk/conformance`) that every built-in adapter passes. Edge-provider plugins are listed in the new `plugins` config option. They can only add tests to a selection, and what they cannot resolve is uncertainty. A failing provider fails the run (`ST_PLUGIN_FAILED`).
- Hook scope: `hook.runners` and `hook.exclude` keep browser specs out of commit hooks and leave them to CI. Tests outside the scope are reported as "left to CI", in the output, `--json`, reports, hook history, `hook status` and `doctor`, and never as passed. `init` proposes the scope when it finds Playwright or Cypress next to a unit runner.
- `smarttest impact|run --only <path>`: selects the tests affected by the changes in one file or directory. The dependency analysis is not restricted, so unresolved relationships of that file still select tests. The VS Code command "Run Affected Tests for This File" uses it.
- Studio: impact map with filters (change, test, edge kind, confidence) and export (JSON, SVG, DOT), line and branch coverage in the source viewer (observed, labelled stale when the file changed), and Chromium browser coverage for Playwright through `@tkmremi/smarttest/playwright`'s `withBrowserCoverage`.
- The dependency graph is saved between runs (`.smarttest/state/graph.json`) and is used only when it provably matches the current files, config and version. Small edits write index deltas instead of the whole index.
- [Security review](documentation/architecture/security-review.md) of file writes, process execution, Studio, plugins and saved state.
- State files that decide selection (index, graph, discovery, result cache, traces) are signed with an HMAC under a per-user key (`~/.cache/smarttest/state.key`), or `SMARTTEST_STATE_KEY` in CI. A file without a valid signature is ignored and rebuilt, so forged or foreign state can never shrink a selection. The first run after upgrading rebuilds state once.
- CI on GitHub Actions runs `pnpm verify` on Linux, Windows and macOS, the VS Code extension's real-host test on all three, real Cypress 16, and Studio in real Safari, VoiceOver and NVDA.
- [Benchmarks on six real repositories](documentation/case-studies/benchmarks-1.0.md), LeadsIt and OpenPro's front end included: 0 missed failures. The 0.5.0 and 0.8.0 targets were re-measured and are not met.

### Changed

- A selected test file that no runner executes now fails `run`, `ci` and the hook with exit code 4, for example when `playwright test --list` cannot load a spec. It used to pass with a warning. Playwright listing errors are shown with the runner's own lines.
- Config paths (`storeDir`, `reports.outputDir`, `tests.directory`, `tests.templates`, runner `dir`/`config`) must stay inside the project, and `storeDir` cannot be the project root.
- SmartTest refuses a `.smarttest/` store that Git tracks (`ST_STORE_TRACKED`), so a pull request cannot commit a fake result cache or index. It refuses symbolic links below the project root on its write paths (`ST_UNSAFE_PATH`) and revisions that look like options (`ST_UNSAFE_REVISION`).
- `init --json` and `migrate --json` without `--yes` print one JSON document instead of two.
- Vitest writes coverage even when a test fails, as Jest already did.

### Performance

- Synthetic repositories ([results](benchmarks/RESULTS.md)): warm end-to-end analysis at 10,000 modules takes 734 ms (was 1.35 s); cold start at 2,000 modules takes 656 ms. Both are under the 1 s targets. On LeadsIt, a cold scan takes 1.73 s (was 3.6 s) and a warm `impact` 0.48 s.

### Fixed

- Security fixes SR-01 to SR-21 ([review](documentation/architecture/security-review.md)):
  - redirected writes through committed symbolic links;
  - config paths that escape the project, including `storeDir: ".."` with `uninstall`;
  - `init --rollback` journal paths;
  - snapshot ids;
  - option injection into `svn cat`, `hg cat` and Git refs;
  - terminal escape sequences in test output;
  - Windows `--open` quoting;
  - markdown injection in the CI summary;
  - CSV formula injection, Host port checks and report downloads in Studio;
  - a missing VS Code trust gate;
  - plugin paths outside the project, `--only` paths with `..`, DOT export comments, malformed coverage files, and absolute paths in browser coverage.
- Config validation now checks project rules, `snapshots.*`, `reports.outputDir`, rule `generate`, `execution.retries`, `execution.alwaysRunOnAffected` and `match.visibility`.
- Playwright's filename fallback no longer claims files that a working runner collects.
- Watch mode rebuilds its graph after a tsconfig change.
- Pre-publication audit, on a real project (Galdia) and in fresh installs:
  - **Missed failure:** a new or changed export whose code runs at import (an IIFE, a call, a static block, a decorator, a top-level statement) now affects every importer of the file. It used to reach only the export's users, so a test importing the file was skipped even in SAFE mode.
  - **Duplicate test names:** two tests with the same name in one attempt, the first failing and the second passing, were reported as one flaky test and the run passed. A test is flaky only when a later retry passes.
  - **Sharded runs:** `--shard` no longer advances the native baseline, so the other shards' tests still run. Coverage from a shard is labelled `selected`, never `full`.
  - **`validate-selection`:** infrastructure errors and files no runner collects count as failures.
  - **Watch mode and Studio:** a plugin is reloaded when its file changes.
  - **`--only`:** a path with the wrong letter case matches its file, and a path that is neither changed nor on disk is a usage error (exit 2).
  - **`init --dry-run`:** it writes nothing to the project. `doctor --fix` and `init` explain how to untrack a committed `.smarttest/`.
  - **`explain`:** it re-analyses when the change or mode moved since the last run, and says which decision it shows.
  - **`init --rollback` and `uninstall`:** rollback undoes only init's own steps. `uninstall` removes SmartTest's hook blocks.
  - **`init` formatting:** `init` formats the generated config with the project's Prettier or Biome.
  - **Imports with bundler queries:** imports such as `./icon.svg?raw` or `#web/a.css?inline` resolve, relative or through a path alias.
  - **State key:** a damaged `state.key` is repaired under a lock, and `doctor` reports it. A `SMARTTEST_STATE_KEY` shorter than 32 characters is ignored with a warning.
  - **Piped output:** piping to `head` no longer prints an EPIPE stack trace, and the exit code is kept.
  - **`run --hook --json`:** a skipped hook (`SMARTTEST_SKIP=1`) or a push that only deletes refs prints a documented hook-only document.
  - **New error code:** `hook install` without `--yes` reports `ST_HOOK_CONFIRMATION_REQUIRED`.
  - **Packaging and docs:** `@tkmremi/smarttest/studio` exports `startStudio`. Help lists every flag, and schema `$id`s point to the docs site. The npm README is user-facing.
- macOS and Windows: results were lost when the runner reported a path spelled differently from SmartTest's (`/var` vs `/private/var`, Windows short names like `RUNNER~1`); Studio returned 404 for reports there. pnpm's relative symlinks in the hook checkout and fixtures broke behind a Windows junction.
- Cypress, found on a real install: test ids, missing skipped tests, failure text in CDATA, and specs that fail to load are now reported correctly.
- `init --yes` no longer writes its hook into a dependency when Git's hooks path points into `node_modules` (`ST_HOOK_PATH_IN_DEPENDENCY`); a hook it must not edit is a warning, not a failure.
- `benchmark` counted the baseline twice when one folder has two Vitest configs; `init` names each config.
- The repository's own pre-push hook unsets Git's local environment variables, so `pnpm verify` run from it can no longer write test commits into the repository.

## [0.9.0] — hooks and interfaces

### Added

- Exact staged-content runs and committed-content push runs in temporary checkouts. The user's index and working files stay intact; binary files, symlinks, renames and alternate Git indexes are supported.
- `hook install --pre-push`, `run --hook`, affected-project `hook.checks`, duration estimates and `hook.budgetMs`. Hook history distinguishes successful checked trees, explicit bypasses and commits without a recorded check.
- `smarttest studio [--port n] [--open]`: local overview, impact paths, test explorer, live runs, source annotations and trust evidence. The server binds to loopback and requires a session token; mutation routes require same-origin JSON POST requests.
- Local VS Code extension with CodeLens, hover explanations, impact and run commands, results tree and status bar. Workspace Trust disables execution in Restricted Mode. `pnpm extension:pack` builds its VSIX.
- `smarttest explain <file> --units A,B.method`: the tests protecting each named unit, from one analysis. The `explain` JSON schema gains an optional `units` array.

### Performance

- Hooks: the temporary checkout reuses the working tree's index stats for files whose content is identical, so neither the hook nor the next normal run re-reads and re-hashes every source file. On a 4,000-file fixture the next run's index update drops from about 175 ms to about 90 ms ([measurement](benchmarks/releases/0.9.0/hook-index-reuse.json)).
- "Before" content is read once per run and fetched eight files at a time; semantic diff, traces and Studio no longer start one `git show` per changed file each.
- Hook checks run at most one per CPU core instead of all at once; grouping changed files by project is linear.
- Studio: rendering is batched per animation frame during runs; result de-duplication, search, the file index, test rows and trace counts are computed once instead of per event, keystroke or request; the line diff uses Myers' algorithm; changed files are read eight at a time and large files only up to the display limit; the last-run report is parsed once; run history keeps the last ten runs.
- VS Code: one `explain --units` call per file instead of one process per symbol (older CLIs fall back to per-symbol calls); analyses are cached until the graph changes rather than per keystroke; concurrent requests for a file share one analysis; saves are debounced into one refresh; the 10-second snapshot expiry is replaced by a file watcher; the results tree builds test nodes on demand.

### Fixed

- Atomic writes retain existing file permissions, including executable hooks. Existing-hook upgrades preserve literal shell dollar sequences.
- Hook replacement preserves compound shell commands and package scripts with other work. Background replacements keep shell PID/wait semantics; uninstall restores the original steps.
- Git hook environment variables are scoped out of isolated test and check subprocesses without changing the parent environment. Cancellation terminates descendant processes.
- Pre-push hooks use the actual remote destination supplied by Git, fall back conservatively for new or unknown destinations, and reject pushed commits other than checked-out HEAD.
- Hook paths stay repository-relative when `diff.relative` is configured.
- Isolated hook runs: workspace packages linked in `node_modules` (also inside `@scope` and `.bin`, and in workspace packages' own `node_modules`) resolve to the staged content in the temporary checkout, no longer to the working tree's unstaged edits; anything that cannot be isolated is reported as a warning. The checkout's index matches the staged tree (`git diff --cached` works in checks), files are written once and the user's post-checkout hook no longer runs.
- An installed pre-push block reads Git's refs once and restores them, so the user's own pre-push steps (a `while read local_ref …` guard) still receive them; also for simple-git-hooks, and lefthook gets `use_stdin: true`. Reinstalling upgrades an existing block.
- Hooks install where Git runs them: for a project in a subdirectory (the block enters the project first), in a linked worktree and with a relative or absolute `core.hooksPath`. A `core.hooksPath` outside the repository is refused (`ST_HOOK_PATH_OUTSIDE_REPO`), so is an existing hook that is not a shell script (`ST_HOOK_NOT_SHELL`); commented-out lines no longer count as an installed hook.
- A check scoped to a workspace package runs (project paths such as `./packages/app/` are normalised); a check naming an unknown project is reported instead of silently never running. `{files}` paths are passed as `./path`, so a file named like an option is never read as one.
- A push that only deletes remote refs runs no tests, exits 0 and is recorded as "nothing pushed", instead of testing the whole history.
- A hook run ended by SIGTERM or SIGHUP removes its temporary checkout, and checkouts left by a killed run are pruned at the start of the next isolated run.
- Studio, found in a real browser: inline styles blocked by the CSP (broken toolbar, search and Evidence layout) are now classes; Back/Forward navigation works; re-renders keep focus and scroll; unit line numbers are no longer one off; Escape in a filter clears it, then leaves the field.
- Studio honesty: a run in which every selected test came from cache has the verdict `cached-pass`, never passed; unmeasured benchmark and hook figures read as unmeasured instead of 0; "selected" no longer uses the pass colour. Text sizes, contrast, focus rings and phone touch targets were raised; Overview, Impact and Source layouts were tightened (see the [Studio critique](packages/studio/review/CRITIQUE.md)).
- Studio: renamed files are diffed against their previous path instead of showing as entirely added; search fields keep focus while typing; malformed and oversized request bodies return 400 and 413 instead of 500; file responses settle when the client disconnects; the `removed` line count is correct.
- VS Code: test results are listed in sorted order; "Refresh Analysis" reports a failure instead of claiming success; the refresh delay setting applies per folder and to every save; a second "Run Affected Tests" for the same folder waits for the first.
- Tests resolve workspace packages from their TypeScript sources instead of a possibly stale `dist/`.
- Run summaries count a file whose runner never started (for example a missing Vitest), which has no test records: such a run is an infrastructure error (exit 4), no longer a pass with 0 tests.
- Hooks, after review: simple-git-hooks commands enter a project in a subdirectory; lefthook in a subdirectory is reported as needing the top-level configuration; links into the working tree from anywhere in pnpm's store are reported; cleanup unregisters only SmartTest's own checkouts, never the user's worktrees.
- Studio: an event-stream client that stops reading is disconnected after 4 MB instead of buffering without limit; a run that finishes before the browser learns its id is caught up from the run's record.
- Studio: a run in which no test passed (nothing selected, or every test skipped) has the verdict `no-tests`, never passed; results stream as each runner group ends instead of all at the end; a refresh that changes the source while another analysis runs analyses the new source; Refresh re-reads runs made from the terminal or a hook, and coverage and traces are re-read after each Studio run; a cancelled run is shown as cancelled; the run drawer catches up after the event stream reconnects.
- Hooks, measured on OpenPro's front end: Vite refused to load an installed package's file by URL (`?url`, `?raw`) inside the temporary checkout ("Denied ID"), because the checkout's `node_modules` links to the installed copies outside it. The checkout now names the installed directory in its own `node_modules/.modules.yaml`, which Vite allows, for npm and pnpm layouts.
- `hook install --dry-run` and the other file previews show each change at its line (`@ line n`) with repeated lines such as `fi`; the previous preview dropped them and listed the block out of place.
- The pre-push and subdirectory hook blocks are tested under dash, the `/bin/sh` of Debian and Ubuntu, as well as the system shell.
- Studio: a refresh that waited behind another analysis analysed whichever source was selected last, so a request for the staged change could answer with the working tree. Each request now gets the source it asked for, and only the current source replaces the shared view.
- Studio accessibility (WCAG 2.2 AA audit, `pnpm studio:a11y`: axe-core plus keyboard, live-region, reflow and target-size checks in Chromium, Firefox and WebKit, light and dark; 39–41 failures per combination before, 0 after): run progress and verdicts are announced; focus moves into the run drawer and returns to its opener; single-key shortcuts can be turned off; Studio works at 320 px without sideways scrolling; scrollable code and run regions are keyboard accessible; tabs, table actions, headings and landmarks are named.
- Windows: an atomic write (the index, run state) failed with EPERM when another process had the file open; the rename is retried for up to about two seconds.
- VS Code: `smarttest.executablePath` may point at a JavaScript entry (`bin.js`) on Linux and macOS; it is started with `node` and needs no executable bit. On Windows, a cancelled or timed-out run no longer waits for a test runner left behind by an exited CLI, and the extension's own unit tests run.

### Validation limits

- The extension runs in a real VS Code (1.143.1) in `pnpm --filter smarttest-vscode test:host`, trusted and in Restricted Mode. CI (`.github/workflows/ci.yml`) runs `pnpm verify` on Linux and the extension's unit and real-host tests on Linux, Windows and macOS. npm publication remains open. See the [delivery log](documentation/planning/delivery.md) for measured gates and carried work.

### Documentation

- Roadmap: 0.9.0 starts with sprint S24 on commit hooks (staged-content runs, `hook install --pre-push`, hook profile, project checks for affected projects, time budget, hook status); a "when is it usable" table.
- Studio design brief (`documentation/design/studio.md`): users, data, jobs, one question per screen, the dealt app style and the design quality bar that is now part of the 0.9.0 gate.
- Delivery log for 0.3.0 to 0.8.0 (sprints S11 to S23: done, partial, moved, gate results); roadmap rebased on 0.8.0 with SmartTest Studio and VS Code in 0.9.0 and the carried items in 1.0.0; risks reviewed; ADR-0008 (observed execution) and ADR-0009 (result cache); architecture, LeadsIt case study and agent instructions updated.

## [0.8.0] — speed

### Added

- Validated result cache (`cache`, default on): a passing test file is reused while its closure, traced files, runner config, manifests, lockfiles, env and setup files, snapshots, Node and runner versions are unchanged. Reported as `cached-pass` everywhere, never as passed; `--no-cache` disables it, `--all` and `--coverage` never use it. `benchmark` counts cache-integrity violations.
- Fail-fast order (recent failures, then graph distance) and `run --bail`.
- Parallel runner groups (`parallelGroups`, default `auto`), with Playwright and Cypress groups run alone.
- `run --shard i/n` and `smarttest shard --total n --index i`, balanced by recorded durations.
- Test history (`.smarttest/state/history.json`) and `smarttest flaky`.
- Subversion and Mercurial adapters (`vcs.provider: "svn" | "hg"`, detected automatically).
- `watch` keeps the index and graph in memory and patches the graph for body-only changes.

### Changed

- Graph construction appends to dependency lists instead of copying them (quadratic on modules with many importers).

## [0.7.0] — adaptation and end-to-end

### Added

- `smarttest sync [--check]`: patches `adapters`, `vcs.provider` and `projects` when the project changed; `run` and `doctor` warn when the configuration is out of date; `doctor --fix` applies safe repairs.
- `smarttest watch`: reruns the tests affected by each save, comparing with the previous save of the file.
- `smarttest migrate --to vitest`: `jest.*` to `vi.*`, a Vitest config with Jest-style globals, scripts and adapters updated; rules and history kept.
- Playwright adapter (`--list` discovery, JSON results, retries and flaky tests, traces and screenshots linked in the HTML report) and Cypress adapter (`specPattern` discovery, one JUnit file per spec).
- End-to-end mapping: URLs visited by specs are linked to Next.js routes (`app/`, `pages/`, layouts, middleware). Specs with visits SmartTest cannot match are uncertain, never ruled out.
- `next-playwright` fixture in the regression harness.

### Fixed

- When several runners collect the same file, the deepest project's runner owns it.

## [0.6.0] — adoption

### Added

- `smarttest hook install | uninstall | status` for husky, lefthook, simple-git-hooks and `.git/hooks`: a marked block runs `smarttest run --staged`; `--replace` comments out full-suite test steps and `uninstall` restores them. `init` plans the hook and lists the replaced steps.
- `smarttest ci`: detects GitHub Actions, GitLab CI, Jenkins, CircleCI, Azure Pipelines, Bitbucket Pipelines or generic CI, compares merge requests with the merge-base of the target branch and branch builds with the previous revision, deepens shallow clones, writes JUnit and Markdown.
- `projects` configuration: per-project test layout, naming, minimum mode and rules. `init` detects sub-projects with different conventions.
- Adaptive policy (`adaptive`, default on): `run` runs everything without building the graph when the last full run was faster than a typical analysis.
- `release:pack` writes a CycloneDX SBOM (`sbom.cdx.json`, shipped in the package) and runs `npm audit`.
- Fixtures `ts-lib-vitest`, `react-vitest` and `yarn-workspaces-node` in the regression harness; documentation snippets checked by the test suite.
- Documentation site at https://remipelloux.github.io/SmarttyTest/, built from `documentation/` by `pnpm site:build` and published to the `gh-pages` branch by `pnpm site:publish`. The landing page shows the real selection for edits to the `nest-auth-vitest` fixture.

### Changed

- Cold start: source files are parsed in worker threads on cold runs of 300 files or more; runners are listed in parallel; a runner whose config sets no test patterns is not started for discovery; module resolution caches file-system lookups; the CLI enables Node's compile cache and loads TypeScript through `require`.

### Fixed

- A method returning `this` (fluent APIs) hid the members called on its result; its callers now depend on the whole class.
- `node --test` with a glob that matches directories (`packages/*/test/`) found no tests.
- Replaced hook steps (`: # smarttest-replaced:`) are no longer reported as test commands.
- Traces no longer add tests for a changed translation catalog: loading a catalog says nothing about which keys a test read.
- `run` output keeps a space between a long test path and its result column.

## [0.5.0] — runtime evidence

### Added

- `smarttest trace`: per-test-file V8 coverage for Vitest, Jest and `node:test`, stored as observed execution with the content hash of every loaded file and a runtime/lockfile fingerprint. `--stale` refreshes only stale traces; `--status` counts them.
- Hybrid selection: in FAST and BALANCED, a fresh trace that never ran the changed code rules out a test selected only by static edges or by uncertainty; a trace that ran changed code adds a test static analysis missed. SAFE only adds. `explain` shows the trace date.
- Unprotected changes: `impact` lists changed units no test reaches statically or in a fresh trace.
- `smarttest shadow` and `shadow --report`: full suite next to the selection, recorded in `.smarttest/shadow/history.jsonl`.
- `benchmark --since <ref>`, `--sample <n>`, `--resume` (results written after each commit) and `--traces`.

### Changed

- Translation keys are qualified by the namespace bound with `useTranslation("ns")` (per binding, aliases included). A translation function received as a parameter reads in its callers' namespaces, so helpers like `getNav(t)` no longer read "any key". On LeadsIt this took one commit from 37 selected test files to 4.

## [0.4.0] — complete graph

### Added

- Environment edges: reads of `process.env.X` / `import.meta.env.X` are linked per key. A change to one key in a `.env*` file selects the code that reads it; a key nobody reads keeps the mandatory trigger.
- Prisma schema edges: changed models and enums select code using `prisma.<model>`, `db.<model>`, Wasp `context.entities.<Model>` or model types from `@prisma/client` / `wasp/entities`. Datasource and generator changes widen to the schema's directory (schema changes were previously ignored).
- Translation edges: `t("key")` and `i18nKey` are linked to catalog keys in TypeScript or JSON catalogs.
- Asset edges for files read through `fs` with paths built from `__dirname` / `import.meta`.
- Wasp operations imported from `wasp/client/operations` / `wasp/server/operations` resolve to their implementation in `main.wasp.ts`.
- Mock awareness: tests that replace a module with a factory mock skip its implementation changes.
- Snapshot files select their test; `__mocks__/x` selects the users of `x`; `import.meta.glob` is an import.
- `generated[].from` for `rebuild-required` generator inputs.

## [0.3.0] — precise graph

### Added

- Member-level graph: methods and accessors are nodes; calls are resolved to the declaring member through local inference (`new X()`, annotations, constructor parameter properties, `this.p`). A change to one method no longer selects tests that only use its siblings.
- Inheritance: inherited members resolve to the base class, overrides to the subclass, `super.m()` to the base member; base construction changes reach subclass users.
- CommonJS exports (`module.exports = { … }`, `exports.x =`) and namespace/`require` member access at symbol level.
- `graph why <from> <to>`, `graph cycles`, `graph orphans`.
- Graph diff: dependencies added or removed by a change, shown by `impact`.
- Per-test confidence (lowest edge confidence along the path) in reasons and `explain`.

### Changed

- No hosted CI: GitHub Actions workflows and Dependabot removed. `pnpm verify` runs locally and in a pre-push hook (`pnpm hooks:install`). Releases are published locally (`pnpm release:publish`), without npm provenance.
- Planning: the delivered backlog is now the foundation record (`documentation/planning/foundation/`); a single roadmap covers 0.2.0 to 1.0.0 (608 points), centred on the dependency graph.
- Documentation rewritten for plain, factual wording; package READMEs are generated from the manifest; a provider-neutral CI guide replaces the GitHub Actions guide.
- Importers of a module are affected when its module-level code changes, even if they use none of its exports.

## [0.2.0] — real-world projects

Driven by the first real migration, [LeadsIt](documentation/case-studies/leadsit.md): parity with the native runners (706/706), 88% less test time than full suites and 63% less than its per-project hook over 12 replayed commits, 0 missed failures.

### Added

- `@smarttest/adapter-node`: Node's built-in runner (`node --test`), with directory arguments following Node's semantics.
- Nested projects discovered without a workspace manifest (repos of independent projects).
- Custom runner configs (`vitest.*.config.*`, `--config` in scripts) detected and passed to the runner. Explicit `runners` config.
- Runner-accurate test discovery: each runner lists the files it collects (cached). `tests.discovery: "static"` opts out.
- `init` reads existing hooks, scripts and CI workflows: carries over skipped tests (`--testPathIgnorePatterns`, `--exclude`) and suggests replacing full-suite hook steps.
- Static evaluation of computed `import()`/`require()` paths (constants, `new URL(…, import.meta.url)`, `resolve(__dirname…)`, templates → files or bounded globs).
- `smarttest benchmark --commits N`: replays history (full vs project-gated vs SmartTest) and re-checks every unselected failure on the parent commit.
- `--target <ref>` for revision-to-revision comparisons (`--base A --target B`).
- Time-saved estimates from recorded per-file durations, always labelled as estimates.
- Wasp, Prisma, Remix, Astro and Hono detection. Per-project lockfiles recognised.

### Changed

- File listing respects `.gitignore` through `git ls-files` (generated output and submodules are skipped).
- SAFE mode selects tests with uncertain dependencies individually. It falls back to the full suite only when the change analysis itself is incomplete.
- SmartTest's own state (`.smarttest/`, reports) is never treated as a change. `.env.*.example` files are no longer mandatory triggers.
- Suggested rule names are unique. Layout follows the majority convention.

### Fixed

- Badges in the README rendered as raw HTML on GitHub.

## [0.1.0] — alpha

The first working version of the v1.0.0 scope: **389 of 422 planned points** ([progress](documentation/planning/foundation/epics/README.md)).

### Added

- **CLI** `smarttest`: interactive menu, `init`, `doctor`, `scan`, `impact`, `run`, `explain`, `validate-selection`, `graph`, `generate`, `rules`, `snapshot`, `vcs`, `coverage`, `report`, `uninstall`. Includes `--json` with versioned schemas, stable exit codes, "did you mean" suggestions, non-TTY mode and lazy engine loading (about 80 ms startup).
- **Smart Init**: project detection with evidence, an explained recommendation plan, dry-run diffs, safe merges (`package.json` scripts, `.gitignore`), low-risk `--auto`, idempotency, a journal with byte-exact `--rollback`, and a setup report.
- **Change intelligence**: Git adapter (merge-base, staged, uncommitted, untracked, renames, deletions, worktrees, sub-directory projects). Native snapshots (content-hash fingerprints, optional deduplicated gzip content, rename detection, verified baselines, prune). Hybrid mode.
- **Source intelligence**: a TypeScript/JavaScript analyzer on the TS 6 Compiler API (ESM, CJS, JSX, decorators, members, signatures, token hashes). Module resolution through tsconfig paths, workspace `exports` maps and barrels. A persistent incremental index. Semantic diff with confidence.
- **Dependency graph**: symbol-level (top-level unit) graph with provenance and confidence, barrel and re-export following, cycle-safe reverse traversal with explanation paths, uncertainty tracking, and JSON/DOT export.
- **Impact engine**: FAST/BALANCED/SAFE modes, built-in mandatory triggers scoped by directory, conservative fallbacks, rule-driven mode upgrades and always-run scopes, and explanations for selected and skipped tests.
- **Rules engine**: path, package, class, method, function, decorator, visibility, kind, extends and implements selectors. Deterministic precedence where risk, mode and always-run are never weakened. Conflict detection.
- **Execution**: Vitest and Jest adapters with declared capabilities, a normalized result model, timeouts, cancellation, retries with flaky marking, and coverage ingestion labelled `full` or `selected`.
- **Generator**: mirror, colocated, domain and custom layouts, naming tokens, templates (service, controller, database, custom `.tpl`), and `it.todo` scaffolds that never count as passing. Atomic writes that never overwrite. `--sync` reports missing, orphaned and renamed tests.
- **Reports**: self-contained HTML (dark/light, reduced motion, CSP, escaped), JSON, JUnit, Markdown (`$GITHUB_STEP_SUMMARY`). Every run validates its own report for integrity.
- **Trust**: a regression harness (seeded mutations across 3 fixtures and 2 modes, 0 missed failures), benchmarks against the PRD targets, package-boundary enforcement, and redacted rotating logs.
- **Release**: a self-contained npm bundle, Changesets, a provenance publish workflow, SBOM, audit and secret scanning.

### Changed

- The local store is a JSON file store instead of SQLite (ADR-0003, amended with benchmark evidence).

## [0.0.0] — foundation

- Monorepo, specification, architecture docs, ADRs, design system, motion design, animated README assets, and the v1.0.0 plan (15 epics, 103 stories, 11 sprints).
