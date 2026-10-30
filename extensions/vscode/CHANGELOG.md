# Changelog

## 0.9.0

First VS Code integration.

- CodeLens protection verdicts above functions and methods, built from `smarttest graph --format json` and one cancellable `smarttest explain <file> --units …` per file (one call per unit with CLIs older than 0.9.0).
- Hover explanations with test files, dependency paths, uncertainty and risk.
- Commands to show the current change's impact, explain the symbol at the cursor, run affected tests, and run affected tests for the current file.
- SmartTest results view that keeps `cached-pass`, skipped, timed-out, cancelled and infrastructure-error results distinct from passes.
- Status bar summary per active workspace folder.
- Multi-root support: settings, executable lookup, caches and CLI `cwd` are per folder.
- Workspace Trust gating; every feature is disabled in Restricted Mode.
- Debounced, cancellable refreshes; child processes are killed on cancellation and timeout. Analyses are cached until the graph changes (a save, a file changed outside the editor, a settings or trust change, or Refresh); requests for the same file share one analysis; `explain` processes are bounded per workspace folder.
- Results view: files start collapsed unless something in them failed; tests are listed in order.
- Status bar shows when the active file is being analysed; a failed refresh is reported as a failure.
- Reproducible VSIX packaging without `vsce` (fixed timestamps, sorted entries, `zip -X`).
- `ST_EXT_*` errors for contract, executable, timeout, cancellation and configuration failures, preserving the CLI's own error code when there is one.
