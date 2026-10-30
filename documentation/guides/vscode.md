# VS Code extension

The SmartTest extension shows which tests protect a function, explains the evidence on hover, and runs the tests a change affects. It calls the local `smarttest` executable; nothing leaves the machine.

## Build and install

Prerequisites: Node 22.12+ and a repository checkout. The CLI must be built before installing the extension.

```bash
pnpm install
pnpm build
pnpm extension:pack
```

This writes `extensions/vscode/smarttest-vscode-0.9.0.vsix`. Install it with VS Code's Extensions view (**… → Install from VSIX…**) or:

```bash
code --install-extension extensions/vscode/smarttest-vscode-0.9.0.vsix
```

Reload the window after installing. For extension development, run `pnpm --dir extensions/vscode build`, open `extensions/vscode` in VS Code and press F5; VS Code starts an Extension Development Host.

The extension has no runtime dependencies and makes no network requests. It does not install or download `smarttest`.

## Workspace trust and the executable

SmartTest is disabled in Restricted Mode because it executes a local binary against workspace files. Trust the workspace (**Manage Workspace Trust**) to enable CodeLens, hover, commands and test runs.

The executable is resolved per workspace folder, in this order:

1. `smarttest.executablePath` (absolute, workspace-relative, or a command name);
2. `node_modules/.bin/smarttest`, walking up from the folder;
3. `PATH`.

In a repository built from source, `pnpm build` creates `packages/cli/dist/bin.js`; link or install the CLI so the first two lookups succeed, or set `smarttest.executablePath` explicitly. SmartTest itself requires 0.8.0+ and JSON schema v1.

## What you see

- **CodeLens**: "Protected by N tests", "N known tests · protection uncertain", "Protection unknown", or "No test reaches this symbol".
- **Hover**: the same verdict, test files, dependency paths, recorded uncertainty and risk.
- **SmartTest view**: the last affected-test run, with `cached-pass`, skipped, timed-out, cancelled and infrastructure-error results kept distinct from passes.
- **Status bar**: a per-folder summary or the last run.

An unknown symbol is never labelled unprotected. Uncertainty, unresolved imports, truncated analysis and failed `smarttest explain` calls all suppress a confident claim.

## Commands

| Command                                       | Effect                                                                                                       |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `SmartTest: Show Impact of Current Change`    | Markdown report for the current symbol, or a summary of the file.                                            |
| `SmartTest: Explain Protection at Cursor`     | Explain the enclosing function or method.                                                                    |
| `SmartTest: Run Affected Tests`               | Run the change set's selected tests and fill the SmartTest view.                                             |
| `SmartTest: Run Affected Tests for This File` | Run the whole change set (the CLI has no per-file selector) and report which selected tests reach this file. |
| `SmartTest: Refresh Analysis`                 | Drop graph/scan/explain caches and analyse again.                                                            |
| `SmartTest: Show Output`                      | Show CLI errors, stderr and timeouts.                                                                        |
| `SmartTest: Why Is SmartTest Disabled?`       | Explain Restricted Mode and open Workspace Trust.                                                            |

Settings such as `smarttest.mode`, `smarttest.changeSource`, `smarttest.baseRef`, `smarttest.executablePath` and the analysis caps are documented in [the extension README](../../extensions/vscode/README.md#settings).

Multi-root workspaces are supported: settings, executable lookup, caches and CLI working directories are per folder. A save in one folder does not cancel another folder's analysis.

## Runtime validation limit

This environment has no VS Code executable and no Extension Development Host. Automated tests cover the pure logic (contract parsing, path mapping, protection rules, result classification, scheduling) and run the **real** `smarttest` CLI against `fixtures/projects/ts-lib-vitest`, including a real affected Vitest run. The VS Code API adapters — CodeLens registration, hover wiring, tree view, status bar, command palette and Restricted Mode UI — have **not** been exercised in a host here.

Manual smoke test on a machine with VS Code:

1. Open a trusted TypeScript project containing SmartTest tests; confirm a CodeLens appears above a function and its hover names the test files.
2. Save a source file and confirm the analysis refreshes once, without stale lenses.
3. Run **SmartTest: Run Affected Tests** and confirm the view distinguishes passes from cached, skipped or incomplete results.
4. Open a second workspace folder and confirm each folder resolves its own executable and settings.
5. Open the same project in Restricted Mode and confirm all features are disabled and the status bar explains why.
6. Break a selected test and confirm the run is reported as failed, never green.
