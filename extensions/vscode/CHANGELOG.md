# Changelog

## 0.9.0

First VS Code integration.

- CodeLens protection verdicts above functions and methods, built from `smarttest graph --format json` and one cancellable `smarttest explain` per unit.
- Hover explanations with test files, dependency paths, uncertainty and risk.
- Commands to show the current change's impact, explain the symbol at the cursor, run affected tests, and run affected tests for the current file.
- SmartTest results view that keeps `cached-pass`, skipped, timed-out, cancelled and infrastructure-error results distinct from passes.
- Status bar summary per active workspace folder.
- Multi-root support: settings, executable lookup, caches and CLI `cwd` are per folder.
- Workspace Trust gating; every feature is disabled in Restricted Mode.
- Debounced, cancellable refreshes; child processes are killed on cancellation and timeout.
- Reproducible VSIX packaging without `vsce` (fixed timestamps, sorted entries, `zip -X`).
- `ST_EXT_*` errors for contract, executable, timeout, cancellation and configuration failures, preserving the CLI's own error code when there is one.
