# SmartTest for VS Code

See which tests protect each function, run the tests a change affects, and read SmartTest's reasons without leaving the editor. The extension calls the **local** `smarttest` executable. It makes no network requests and sends nothing anywhere.

This is the 0.9.0 extension. It consumes the public `--json` contracts of SmartTest 0.8.0+ (`schemaVersion: 1`). For installation, trust and a manual smoke-test checklist, see the [VS Code guide](../../documentation/guides/vscode.md).

## Requirements

- VS Code 1.85 or newer.
- A workspace folder containing TypeScript or JavaScript, already analysed by `smarttest` (`.smarttest/` present is not required, but a built executable is).
- The `smarttest` executable, found in this order:
  1. `smarttest.executablePath` (absolute, workspace-relative, or a command name on `PATH`);
  2. `node_modules/.bin/smarttest`, walking up from the workspace folder;
  3. `PATH`.

  On Windows the `.bin` entry is a `smarttest.cmd` batch shim, which Node refuses to start without a shell. The extension runs the `smarttest` package's JavaScript entry with `node.exe` (next to the shim, then on `PATH`, then VS Code's own runtime) instead. Only when that entry cannot be found is the shim started through `cmd.exe`, with every argument quoted and arguments containing `%`, `^`, `&`, `|`, `<`, `>`, `!` or `"` refused. `smarttest.executablePath` may also point at the JavaScript entry itself.
- A trusted workspace. In Restricted Mode every feature is disabled. SmartTest runs a local executable and reads project files; it does not pretend to work in a sandbox it does not have.

## What you get

### CodeLens: "Protected by N tests"

Above each function and method the extension explains the unit against the static graph:

- **Protected by N tests** — N distinct test files reach the unit.
- **N known tests · protection uncertain** — SmartTest recorded uncertainty (unresolved imports, dynamic imports, low-confidence edges) on the path.
- **Protection unknown** — the graph has no node for the symbol, or `explain` failed. This is never shown as "unprotected".
- **No test reaches this symbol** — the graph has a node and no test reaches it. The hover says explicitly that a test reached only through code SmartTest cannot resolve would not appear.

Overloaded methods get one lens on the first declaration. Symbols the language server does not report get no lens: no range, no claim.

### Hover

Hover shows the same verdict, the test files, the paths SmartTest used, the recorded uncertainty, the risk level and the graph unit. Turning `smarttest.hover.enabled` off removes it.

### Commands

| Command                                       | What it does                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SmartTest: Show Impact of Current Change`    | Opens a Markdown report for the current symbol, or a file summary of every unit.                                                                                                                                                                                                                                                                                                         |
| `SmartTest: Explain Protection at Cursor`     | Finds the enclosing function/method and opens its explanation.                                                                                                                                                                                                                                                                                                                           |
| `SmartTest: Run Affected Tests`               | Runs `smarttest run --affected --json` for the configured change source and fills the SmartTest view.                                                                                                                                                                                                                                                                                    |
| `SmartTest: Run Affected Tests for This File` | Same run, and reports which of the selected tests reach this file (the intersection of `explain <file>` with the run's selection). **It runs the whole change set**, because the CLI has no per-file run command. When `explain` fails, or the path goes through code SmartTest could not resolve, it says SmartTest could not determine which tests reach the file, never that none do. |
| `SmartTest: Refresh Analysis`                 | Drops cached graph/scan/explain data and re-analyses the active file.                                                                                                                                                                                                                                                                                                                    |
| `SmartTest: Show Output`                      | Shows the `SmartTest` output channel (errors, stderr, timeouts).                                                                                                                                                                                                                                                                                                                         |
| `SmartTest: Why Is SmartTest Disabled?`       | Explains Restricted Mode and opens Workspace Trust.                                                                                                                                                                                                                                                                                                                                      |

### Results view

The **SmartTest** view in the Explorer shows the last run's verdict, analysis status, every file and every test. `cached-pass` is shown as **cached pass (not re-run)**; a skip, timeout, cancellation or infrastructure error is never rendered as a pass. The verdict is read from every file and test result as well as from the summary, so a file whose runner never started (for example Vitest not installed: `infrastructure-error`, no tests) makes the run **incomplete** with "no test ran", not "0 test(s) passed". The verdict is **incomplete** when analysis is partial, a fallback selection was applied, a test was cached, skipped itself, timed out, never reported, no test passed at all, the run had infrastructure errors, the CLI exited with a code other than 0 or 1, or the report failed SmartTest's integrity check (shown as an **Integrity issues** node). Flaky tests pass but are counted: "3 passed · 1 flaky".

A run that exits 4 (infrastructure) or 70 (integrity check failed) still writes its report; the view shows it. When a file in the folder is saved or changed on disk, the status bar drops the run's verdict and the view marks the results **Out of date**.

### Multi-root workspaces

Settings, executable lookup, `cwd`, graph, scan and analysis caches are all per workspace folder. Saving in one folder does not cancel or invalidate another folder's analysis. Files outside the folder are ignored rather than attributed to the wrong project.

## Settings

| Setting                          | Default       | Meaning                                                                                                                               |
| -------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `smarttest.executablePath`       | `""`          | Executable path or command name. Empty uses the workspace/PATH lookup above.                                                          |
| `smarttest.mode`                 | `balanced`    | `fast`, `balanced` or `safe`; passed to every CLI call.                                                                               |
| `smarttest.changeSource`         | `uncommitted` | `uncommitted`, `staged`, or `base` (`--base` with `smarttest.baseRef`).                                                               |
| `smarttest.baseRef`              | `""`          | Ref for base mode. Required when base mode is selected.                                                                               |
| `smarttest.refreshDelayMs`       | `350`         | Save debounce (0–60000). A newer save cancels the pending analysis.                                                                   |
| `smarttest.codeLens.enabled`     | `true`        | CodeLens on/off.                                                                                                                      |
| `smarttest.hover.enabled`        | `true`        | Hover on/off.                                                                                                                         |
| `smarttest.statusBar.enabled`    | `true`        | Status bar item on/off.                                                                                                               |
| `smarttest.maxConcurrentExplain` | `2`           | Parallel `explain` processes per workspace folder.                                                                                    |
| `smarttest.maxUnitsPerFile`      | `150`         | Above this many units the file's protection is **hidden**, not partially shown; the status bar says the file is too large to analyse. |
| `smarttest.analysisTimeoutMs`    | `120000`      | Timeout for scan/graph/impact/explain (at most 3600000).                                                                              |
| `smarttest.runTimeoutMs`         | `900000`      | Timeout for a run started here (at most 86400000).                                                                                    |

## How the answers are produced

1. `smarttest scan --json` supplies the project profile, unresolved imports and dynamic imports.
2. `smarttest graph --format json` supplies the file's function/method/class units. `--format json` is used because `graph --json` prints only statistics.
3. `smarttest explain <file> --units <A,B.method> --json` is called once per file, with cancellation and a timeout. A CLI older than 0.9.0 rejects `--units` with a usage error; the extension then calls `explain <file>#<Unit>` once per unit, bounded by `maxConcurrentExplain` per workspace folder. Any other failure of that call (a timeout, a crash, unreadable output) makes every symbol in the file **unknown** instead of retrying per unit.
4. `smarttest impact --json` and `smarttest run --affected --json` drive the run commands.

Every response is validated. A missing field is a `SmartTestExtensionError` with a stable code (`ST_EXT_CONTRACT`, `ST_EXT_SCHEMA_VERSION`, `ST_EXT_TIMEOUT`, …), not a zero that would look like "unprotected". Child processes are killed on cancellation, on timeout, when their workspace folder is removed and when the extension deactivates: SIGTERM, then SIGKILL after 3 s if the CLI is still running, sent to the CLI's whole process group on POSIX so the test runners it started stop too (`taskkill /T` on Windows).

## Honesty rules

- An unknown unit is **unknown**, never **unprotected**.
- Any recorded uncertainty makes protection **uncertain**, even when tests were found.
- `explain` returning no tests is reported as "no static path", with the caveat that dynamic or unresolvable code may still reach the unit.
- A per-file cap hides the verdict instead of analysing half a file.
- A cached, skipped, timed-out, cancelled or infrastructure-error result is never counted as passed, and a run in which no test passed is never green.
- The extension does not retry a failed CLI call: a retry would hide the problem the user needs to see.
- No uncommitted-file writes, no network, no `npx`, no install on activation.

## Development

The extension is a member of the root pnpm workspace (`extensions/*`). The root install provisions TypeScript, Vitest, esbuild and `@types/vscode`; the extension has no runtime dependencies.

```bash
pnpm install                            # at the repository root
pnpm --dir extensions/vscode typecheck
pnpm --dir extensions/vscode test
pnpm --dir extensions/vscode build      # dist/extension.cjs
pnpm --dir extensions/vscode package    # reproducible smarttest-vscode-0.9.0.vsix
pnpm --dir extensions/vscode package:check
pnpm --dir extensions/vscode verify     # typecheck + tests + build + manifest/package checks
```

The root `verify` gate runs `pnpm extension:verify`, which runs this package's `verify`; the root `extension:pack` script packages the VSIX. The extension's own `verify` does not launch VS Code. There is no VS Code executable in this environment; see the handoff document for the runtime UI checks that still need a real extension host.

### Testing against the real CLI

The integration suite is part of the normal `test` run. It uses `packages/cli/dist/bin.js` when that build exists and runs `scan`, `graph`, per-file `explain --units`, `impact` and a real affected Vitest run against `fixtures/projects/ts-lib-vitest` (copied to a temporary git repository for the write/run cases). Set `SMARTTEST_CLI` to point at another build. If no CLI build exists the suite reports itself as skipped rather than substituting canned JSON.

```bash
pnpm build
pnpm --dir extensions/vscode test
```

### Reproducible VSIX

`scripts/package.mjs` writes the VSIX without `vsce`. It stages only `package.json`, README, CHANGELOG, LICENSE and `dist/`, fixes every timestamp to the ZIP epoch, sorts paths and uses `zip -X`. Running it twice on the same source produces the same SHA-256.

## Known limitations

- No tests in a real extension host: the status bar, results view, commands, state and activation are tested against a small `vscode` stub (`test/vscode-stub.ts`) and a fake `smarttest`; CodeLens and Hover rendering have not been executed in a real host here.
- Per-symbol protection costs one `explain` process per file (one per unit with older CLIs); large files are capped by `smarttest.maxUnitsPerFile`.
- The graph snapshot is kept until a save, a settings or trust change, Refresh, or a source/config file changed outside VS Code (a file watcher; `node_modules`, `.git`, `.smarttest`, `coverage`, `dist`, `build`, `out`, `.next`, `.turbo` and `.cache` are ignored unless the file is saved in the editor).
- `Run Affected Tests for This File` cannot scope execution to one file because the CLI has no such selector. It runs the change set and reports the intersection.
- Symbol ranges come from the language server, not from SmartTest. Without a TypeScript/JavaScript language provider there are no lenses. Only declarations reached through classes, interfaces, namespaces and modules are matched: a function's local helpers and an object literal's methods never get a lens, even when they share a name with a graph unit.

## Privacy and safety

All processing is local. SmartTest reads the workspace and invokes the configured executable. It writes nothing except through the CLI's own `.smarttest/` outputs during a run, which the extension never edits. In Restricted Mode it does nothing.
