# Changelog

All notable changes are documented here. Releases are managed with [Changesets](https://github.com/changesets/changesets). The project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
