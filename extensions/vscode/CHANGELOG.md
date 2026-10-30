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

### Fixed after the first 0.9.0 tag

- A run whose test runner never started (for example Vitest not installed: a file at `infrastructure-error` with no tests) was shown as "0 test(s) passed" with a green status. The verdict now reads every file and test result as well as the summary: any status other than passed or flaky, or a run in which no test passed, is not a pass. Flaky passes are shown ("3 passed · 1 flaky").
- A run that exited 4 (infrastructure) or 70 (integrity check failed) lost its report and showed only "failed with exit code". The report is now read for any exit code; integrity issues appear in the results view and keep the verdict from being a pass.
- A CLI that ignored SIGTERM was never killed: the SIGKILL escalation checked `child.killed`, which is true as soon as SIGTERM is sent. Escalation now checks whether the process exited, and signals go to the CLI's process group on POSIX (`taskkill /T` on Windows) so test runners it started stop too.
- Windows: `node_modules/.bin/smarttest.cmd` could not be started without a shell. The extension now runs the package's JavaScript entry with Node, and starts the shim through `cmd.exe` with strict quoting only when no entry is found.
- "Run Affected Tests for This File" turned an `explain` failure into "no direct static path from this file". It now says SmartTest could not determine which tests reach the file, takes `explain`'s uncertainty into account, and reports the intersection of the file's tests with the run's selection.
- The last run's verdict stayed in the status bar after a save, a checkout or another change in the folder. It is now cleared, and the results view marks the run **Out of date**. Test-report folders (`test-results`, `playwright-report`, `.nyc_output`) are ignored by the file watcher.
- CodeLens could bind a unit to a nested function or an object literal's method of the same name (`function outer() { function helper() {} }` before `export function helper()`). Only declarations reached through classes, namespaces and modules are matched.
- Deactivating the extension, or removing a workspace folder, left `scan`, `graph`, `explain` and `run` processes running. They are now aborted.
- A failed `explain --units` call fell back to one `explain` per unit for any error; it now does so only for a usage error (a CLI without `--units`) and otherwise marks the file's units unknown.
- `smarttest.analysisTimeoutMs` and `smarttest.runTimeoutMs` declare the maximum the extension enforces; `smarttest.refreshDelayMs` declares the same maximum (60000) as the code.
- The status bar said "no symbols" for a file above `smarttest.maxUnitsPerFile`; it now says the file is too large to analyse and names the setting.
- A superseded analysis could clear the "analysing this file" indicator of the analysis that replaced it.
