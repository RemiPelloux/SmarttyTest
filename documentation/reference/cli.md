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
| `smarttest hook install \| uninstall \| status`                 | Put `smarttest run --staged` in the pre-commit hook (husky, lefthook, simple-git-hooks or `.git/hooks`)                 |
| `smarttest ci`                                                  | Run affected tests in any CI: detects the provider, picks the base, deepens shallow clones, writes JUnit and Markdown   |
| `smarttest sync [--check]`                                      | Update the configuration after the project changed (runners, packages, Git); `--check` fails when it is out of date     |
| `smarttest watch`                                               | Rerun the tests affected by each save                                                                                   |
| `smarttest migrate --to vitest`                                 | Move Jest projects to Vitest, keeping SmartTest rules and history                                                       |
| `smarttest shard --total n --index i`                           | Print one CI shard of the selection, balanced by recorded durations                                                     |
| `smarttest flaky`                                               | Tests that flip between pass and fail in the recorded runs                                                              |
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

`smarttest studio [--port n] [--open]` starts the local Studio interface. `smarttest open` is an alias. The server binds to loopback and prints a session URL; Ctrl-C stops it. See [Studio](../guides/studio.md).

Reserved for later versions ([roadmap](../planning/roadmap.md)): `ai …` and `autopilot` (after 1.0.0). They exit with `ST_NOT_AVAILABLE`.

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
| `--staged`                             | HEAD → index; runs execute the staged content in isolation when necessary                              |
| `--push`                               | upstream merge-base → HEAD; runs execute committed content                                             |
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
| `--no-cache`     | Run tests even when a validated cached pass exists                            |
| `--shard <i/n>`  | Run shard i of n, balanced by recorded durations                              |
| `--bail`         | Stop starting runner groups after one has a failure                           |

`--hook` enables the commit-hook profile with affected-project checks, fail-fast execution, compact output and duration records. It accepts `--staged` or `--push` and rejects sharding. See [commit and push hooks](../guides/commit-hooks.md).

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

In a Git repository, `init` also plans the pre-commit hook (see `hook`): it adds a marked block that runs `smarttest run --staged`, and comments out the hook's existing full-suite test steps (`jest`, `vitest`, `node --test`). The plan lists them; `smarttest hook uninstall` restores them. `--auto` leaves hooks alone.

When sub-projects lay out their tests differently (LeadsIt has colocated `*.server.test.ts` files in one project and `src/__tests__/` in another), `init` writes a `projects` block so generated tests follow each project's convention.

## `hook`

`smarttest hook status` shows the hook manager, whether SmartTest runs in the hook, and the steps that still run whole suites. `smarttest hook install` adds the marked block (`# >>> smarttest >>>` … `# <<< smarttest <<<`) to `.husky/pre-commit`, a `smarttest` command under `pre-commit` in `lefthook.yml`, the `simple-git-hooks` entry in `package.json`, or `.git/hooks/pre-commit` (respecting `core.hooksPath`). `--replace` comments out the existing full-suite test steps with a `: # smarttest-replaced:` prefix so the script stays valid. `--manager <husky|lefthook|simple-git-hooks|git>` overrides detection; `--dry-run` previews, `--yes` skips the confirmation. `smarttest hook uninstall` removes the block and restores replaced steps. When `node_modules/.bin/smarttest` is missing, the hook prints a notice instead of blocking the commit.

`--pre-push` targets pre-push for install, status and uninstall. Installation upgrades older SmartTest commands to `--hook`. Status also reports durations, bypasses, commits without matching successful records and missing local installs. Plain uninstall removes both stages; `uninstall --pre-push` removes only pre-push. See [commit and push hooks](../guides/commit-hooks.md).

## `ci`

`smarttest ci` runs the affected tests in any CI system. It reads the provider's variables (GitHub Actions, GitLab CI, Jenkins, CircleCI, Azure Pipelines, Bitbucket Pipelines, or any `CI=true`):

| Build                                                                                                                                       | Compared with                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Merge/pull request                                                                                                                          | the merge-base with `origin/<target branch>`; the target branch is fetched and shallow history deepened until the merge-base exists (full history as a last resort) |
| Branch build with a known previous revision (GitLab `CI_COMMIT_BEFORE_SHA`, Jenkins `GIT_PREVIOUS_SUCCESSFUL_COMMIT`, GitHub push `before`) | that revision                                                                                                                                                       |
| Other branch builds                                                                                                                         | the parent commit                                                                                                                                                   |
| No usable history                                                                                                                           | the full suite                                                                                                                                                      |

Reports default to the configured formats plus JUnit and Markdown; on GitHub the Markdown summary is added to the job summary. `--all` runs everything, `--dry-run` prints the provider and the base without running tests.

## `generate`

| Flag                                          | Meaning                                                                 |
| --------------------------------------------- | ----------------------------------------------------------------------- |
| `--class <C>` / `--module <m>` / `--path <p>` | Target selection                                                        |
| `--type unit\|integration\|e2e`               | Category, used in mirror/domain paths                                   |
| `--dry-run`                                   | List files (and contents with `--verbose`) without writing              |
| `--sync`                                      | Report missing tests, orphaned tests and renamed sources. Proposes only |

## `benchmark`

`--commits <n>` (default 10) or `--since <ref>` (every first-parent commit after it), `--sample <n>` (at most n of them, evenly spaced), `--resume` (reuse commits already measured in `.smarttest/reports/benchmark.json`, which is written after each commit), `--traces` (trace the tests at each parent commit so selection uses observed execution), `--mode <m>`, `--json`, `-o <file.md>`. It replays commits in a temporary Git worktree that reuses the project's installed `node_modules`. For each commit it runs the full suites, records the suites of the projects the commit touched ("project-gated", what most hooks do), then runs SmartTest's selection. Every failing test that wasn't selected is re-run on the parent commit to tell a real miss from a pre-existing failure. Exits 5 if anything was missed. Writes `.smarttest/reports/benchmark.{md,json}`.

## `sync`

Compares the configuration with the project as it is now and patches only the keys that changed: `adapters` (a runner was added or replaced), `vcs.provider` (the project adopted Git, or left it), `projects` (new sub-projects with their own conventions). Declared `runners` that no longer exist are reported for a manual fix. `--dry-run` previews, `--yes` writes, `--check` exits 3 when anything is out of date. `run` and `doctor` warn when the configuration is out of date. `doctor --fix` applies the same patch and also adds `.smarttest/` to `.gitignore` and removes unreadable local state files.

## `watch`

Watches the project and, after each batch of saves, runs the tests those saves can affect. A save is compared with the previous save of the same file, or with `HEAD` the first time a file is saved, so a cycle runs only what the latest edit can affect. Ctrl-C stops it.

## `migrate`

`smarttest migrate --to vitest` moves Jest projects to Vitest: `jest.*` calls become `vi.*` (`jest.requireActual` becomes `await vi.importActual`), a `vitest.config` with Jest-style globals and Jest's default test patterns is created, `jest` in package scripts becomes `vitest run`, the package.json `jest` block is removed, and SmartTest's `adapters` switch to `vitest`. Rules, durations and traces carry over (they are keyed by file). Constructs without an automatic equivalent (`done` callbacks, Jest types) are listed. `--dir <project>` limits it to one project; it does not install Vitest, it prints the command. `smarttest init --rollback` undoes it.

## `shard` and `flaky`

`smarttest shard --total n --index i [--base <ref>] [--all]` prints the test files of one shard (the split `run --shard i/n` uses). `smarttest flaky [--min-rate 0.05]` lists tests whose recorded results flip between pass and fail or passed only on retry, with a suggested retry rule. See [Running less, faster](../concepts/speed.md).

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

Every `--json` document has `schemaVersion` and `command`. Schemas ship with the package in [`packages/cli/schemas/`](../../packages/cli/schemas): `run`, `impact`, `scan`, `explain` and `error`. `trace`, `shadow`, `benchmark` and `graph` also accept `--json`; their documents are not versioned by a schema yet. Breaking a schema requires a major version.

## Exit codes

These are versioned and part of the public contract (locked by a test in `@smarttest/shared`).

| Code | Category                | Examples                                                                                |
| ---- | ----------------------- | --------------------------------------------------------------------------------------- |
| 0    | Success                 | All selected tests passed                                                               |
| 1    | Test failure            | A test failed, timed out or was cancelled                                               |
| 2    | Invalid usage           | Unknown command or flag, bad argument                                                   |
| 3    | Configuration failure   | Invalid config, rule conflict, confirmation required in non-interactive mode            |
| 4    | Infrastructure failure  | Runner crashed or missing, Git base missing in a shallow clone                          |
| 5    | Safety / policy failure | `validate-selection`, `shadow` or `benchmark` found a missed failure, rollback conflict |
| 70   | Internal error          | A SmartTest bug (e.g. a report integrity violation)                                     |
