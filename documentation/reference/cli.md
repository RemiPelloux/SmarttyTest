# CLI reference

## Commands

| Command                                                         | Purpose                                                                                                                 |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `smarttest`                                                     | Interactive menu in a terminal. Prints help otherwise                                                                   |
| `smarttest init`                                                | Detect, plan, preview and apply setup. Idempotent and reversible                                                        |
| `smarttest doctor`                                              | Diagnose runtime, config, rules, VCS, index and runners                                                                 |
| `smarttest scan`                                                | Show what SmartTest understands about the project (read-only)                                                           |
| `smarttest impact`                                              | Compute the decision without running tests                                                                              |
| `smarttest run`                                                 | Run affected tests (default) or the full suite (`--all`)                                                                |
| `smarttest explain <target>`                                    | Why a test was selected or skipped, or which tests protect a file or symbol                                             |
| `smarttest validate-selection`                                  | Compare the selection against a full reference run                                                                      |
| `smarttest benchmark`                                           | Replay recent commits: full run vs project-gated run vs SmartTest, with missed failures re-checked on the parent commit |
| `smarttest trace`                                               | Record which code each test file runs (V8 coverage, one run per test file)                                              |
| `smarttest shadow`                                              | Run the full suite next to the selection and record drift; `--report` summarises all runs                               |
| `smarttest graph`                                               | Query or export the dependency graph                                                                                    |
| `smarttest generate`                                            | Generate or sync the test architecture. Never overwrites                                                                |
| `smarttest rules list \| validate \| explain <path>`            | Inspect rules                                                                                                           |
| `smarttest snapshot create \| list \| inspect \| diff \| prune` | Native snapshots                                                                                                        |
| `smarttest vcs detect \| status \| connect <git\|native>`       | Version-control state                                                                                                   |
| `smarttest coverage`                                            | Latest ingested coverage, with its scope (full or selected)                                                             |
| `smarttest report`                                              | Re-render reports from the last run                                                                                     |
| `smarttest uninstall`                                           | Remove SmartTest config, scripts and local state. Tests are kept                                                        |

Reserved for later versions ([roadmap](../planning/roadmap.md)): `sync`, `migrate` and `watch` (0.7.0), `studio` / `open` (0.9.0), `ai …` and `autopilot` (after 1.0.0). They exit with `ST_NOT_AVAILABLE`.

## Global flags

| Flag                          | Meaning                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------- |
| `--config <path>`             | Use a specific config file                                                      |
| `--mode fast\|balanced\|safe` | Safety mode (default `balanced`). For `generate`, `--mode scaffold`             |
| `--json`                      | One JSON document on stdout ([schemas](#json-output)). Logs go to stderr        |
| `-q, --quiet` / `--verbose`   | Less / more output. `--verbose` mirrors debug logs to stderr                    |
| `--non-interactive`           | Never prompt. Missing confirmation exits 3. Also implied by `CI` or a non-TTY   |
| `--dry-run`                   | Show changes, write nothing (`init`, `generate`, `snapshot prune`, `uninstall`) |
| `-y, --yes`                   | Accept the plan without prompting (`init`, `uninstall`)                         |
| `-o, --output <path>`         | Report directory (`run`, `report`) or export file (`graph`)                     |
| `-h, --help`, `-v, --version` |                                                                                 |

`NO_COLOR` and `FORCE_COLOR` are respected. When stdout is not a TTY, output has no colours or spinners and there are no prompts.

## Change sources (`run`, `impact`, `explain`, `validate-selection`)

| Flag                                   | Compares                                                                                               |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| _(none)_                               | Git: HEAD → working tree incl. untracked (or `vcs.base` if configured). No Git: latest native snapshot |
| `--base <ref>`                         | merge-base(`<ref>`, HEAD) → working tree                                                               |
| `--base-mode direct`                   | `<ref>` → working tree, without the merge-base                                                         |
| `--base <a> --target <b>`              | revision `a` → revision `b` (untracked files ignored), e.g. one commit or a PR range                   |
| `--staged`                             | HEAD → index                                                                                           |
| `--uncommitted`                        | HEAD → working tree, including untracked files                                                         |
| `--since-snapshot` / `--snapshot <id>` | latest (or given) native snapshot → working tree (hybrid mode works with Git too)                      |

## `run`

| Flag             | Meaning                                                                       |
| ---------------- | ----------------------------------------------------------------------------- |
| `--affected`     | Analyse changes and run affected tests (default)                              |
| `--all`          | Full suite through the same pipeline                                          |
| `--coverage`     | Collect coverage through the runner's provider. Labelled `selected` or `full` |
| `--retries <n>`  | Retry failing files. A pass after a retry is reported as **flaky**            |
| `--timeout <ms>` | Per-runner timeout. Unfinished files become `timed-out`                       |
| `--workers <n>`  | Passed to the runner as `--maxWorkers`                                        |
| `--format <f>`   | Repeatable: `html`, `json`, `junit`, `markdown` (default from config)         |
| `--open`         | Open the HTML report                                                          |

Ctrl-C cancels the runner cleanly and reports `cancelled`.

## `init`

| Flag                          | Meaning                                                                                  |
| ----------------------------- | ---------------------------------------------------------------------------------------- |
| `--dry-run`                   | Print the plan and a diff of every file. Writes nothing                                  |
| `--yes`                       | Apply all planned changes                                                                |
| `--auto`                      | Apply low-risk changes only (config file, `.gitignore`). Leaves `package.json` alone     |
| `--advanced`                  | Choose layout and mode interactively                                                     |
| `--layout <l>` / `--mode <m>` | Override recommendations                                                                 |
| `--rollback`                  | Undo what init changed. Files edited since init are reported and left untouched (exit 5) |

## `generate`

| Flag                                          | Meaning                                                                 |
| --------------------------------------------- | ----------------------------------------------------------------------- |
| `--class <C>` / `--module <m>` / `--path <p>` | Target selection                                                        |
| `--type unit\|integration\|e2e`               | Category, used in mirror/domain paths                                   |
| `--dry-run`                                   | List files (and contents with `--verbose`) without writing              |
| `--sync`                                      | Report missing tests, orphaned tests and renamed sources. Proposes only |

## `benchmark`

`--commits <n>` (default 10) or `--since <ref>` (every first-parent commit after it), `--sample <n>` (at most n of them, evenly spaced), `--resume` (reuse commits already measured in `.smarttest/reports/benchmark.json`, which is written after each commit), `--traces` (trace the tests at each parent commit so selection uses observed execution), `--mode <m>`, `--json`, `-o <file.md>`. It replays commits in a temporary Git worktree that reuses the project's installed `node_modules`. For each commit it runs the full suites, records the suites of the projects the commit touched ("project-gated", what most hooks do), then runs SmartTest's selection. Every failing test that wasn't selected is re-run on the parent commit to tell a real miss from a pre-existing failure. Exits 5 if anything was missed. Writes `.smarttest/reports/benchmark.{md,json}`.

## `trace`

`smarttest trace [files…]` runs each test file on its own with `NODE_V8_COVERAGE` (Vitest in worker-thread mode) and stores, per test, the functions it ran in each project file and the content hash of every file it loaded, in `.smarttest/state/traces.json`. `--stale` traces only tests without a fresh trace, `--workers <n>` sets the parallelism (default 4), `--status` counts fresh and stale traces. A test that fails is not traced. See [runtime evidence](../concepts/runtime-evidence.md).

## `shadow`

`smarttest shadow` computes the selection for the current change, runs the full suite, and appends the comparison (selected, failures found, failures missed, times) to `.smarttest/shadow/history.jsonl`. Exits 5 when a failure was missed. `smarttest shadow --report` summarises every recorded run and exits 5 if any run missed a failure. Run it on a schedule in any CI system or locally.

## `graph`

`graph why <from> <to>` prints the shortest dependency path (from a file or `file#Symbol` to a file), `graph cycles` lists import cycles, `graph orphans` lists source files no test reaches.

`--from <file | file#Symbol>`, `--direction dependents|dependencies`, `--depth <n>`, `--format json|dot`, `-o <file>`. Without `--from` the whole graph is exported.

## `snapshot`

`create [--content] [--label <l>]` · `list` · `inspect [id]` · `diff [id]` · `prune [--keep <n>] [--force] [--dry-run]`. Verified baselines (snapshots taken after a fully passing run) survive pruning unless `--force` is passed.

## JSON output

Every `--json` document has `schemaVersion` and `command`. Schemas ship with the package in [`packages/cli/schemas/`](../../packages/cli/schemas): `run`, `impact`, `scan`, `explain` and `error`. Breaking a schema requires a major version.

## Exit codes

These are versioned and part of the public contract (locked by a test in `@smarttest/shared`).

| Code | Category                | Examples                                                                     |
| ---- | ----------------------- | ---------------------------------------------------------------------------- |
| 0    | Success                 | All selected tests passed                                                    |
| 1    | Test failure            | A test failed, timed out or was cancelled                                    |
| 2    | Invalid usage           | Unknown command or flag, bad argument                                        |
| 3    | Configuration failure   | Invalid config, rule conflict, confirmation required in non-interactive mode |
| 4    | Infrastructure failure  | Runner crashed or missing, Git base missing in a shallow clone               |
| 5    | Safety / policy failure | `validate-selection` found a missed failure, rollback conflict               |
| 70   | Internal error          | A SmartTest bug (e.g. a report integrity violation)                          |
