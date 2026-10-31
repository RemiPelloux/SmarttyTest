# Changelog

All notable changes are documented here. Releases are managed with [Changesets](https://github.com/changesets/changesets). The project follows [Semantic Versioning](https://semver.org/).

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
