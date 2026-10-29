# Changelog

All notable changes are documented here. Releases are managed with [Changesets](https://github.com/changesets/changesets). The project follows [Semantic Versioning](https://semver.org/).

## [0.1.0] — alpha

The first working version of the v1.0.0 scope: **389 of 422 planned points** ([progress](documentation/planning/release-1.0.0/epics/README.md)).

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
