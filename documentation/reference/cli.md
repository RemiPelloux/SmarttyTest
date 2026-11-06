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
| `smarttest explain <target> [--units A,B]`                      | Why a test was selected or skipped, or which tests protect a file or symbol; `--units` adds a per-unit breakdown        |
| `smarttest validate-selection`                                  | Compare the selection against a full reference run                                                                      |
| `smarttest benchmark`                                           | Replay recent commits: full run vs project-gated run vs SmartTest, with missed failures re-checked on the parent commit |
| `smarttest hook install \| uninstall \| status`                 | Put `smarttest run --staged` in the pre-commit hook (husky, lefthook, simple-git-hooks or `.git/hooks`)                 |
| `smarttest ci`                                                  | Run affected tests in any CI: detects the provider, picks the base, deepens shallow clones, writes JUnit and Markdown   |
| `smarttest sync [--check] [--apply]`                            | Update the configuration after the project changed, and propose what an upgrade adds; `--check` fails on drift only     |
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

Reserved for a later release: `ai …` and `autopilot`. They exit with `ST_NOT_AVAILABLE`.

## Global flags

| Flag                          | Meaning                                                                            |
| ----------------------------- | ---------------------------------------------------------------------------------- |
| `--config <path>`             | Use a specific config file                                                         |
| `--mode fast\|balanced\|safe` | Safety mode (default `balanced`). For `generate`, `--mode scaffold`                |
| `--json`                      | One JSON document on stdout ([schemas](#json-output)). Logs go to stderr           |
| `-q, --quiet` / `--verbose`   | Less / more output. `--verbose` mirrors debug logs to stderr                       |
| `--non-interactive`           | Never prompt. Missing confirmation exits 3. Also implied by `CI` or a non-TTY      |
| `--dry-run`                   | Show changes, write nothing (`init`, `generate`, `snapshot prune`, `uninstall`)    |
| `-y, --yes`                   | Accept the plan without prompting (`init`, `hook`, `sync`, `migrate`, `uninstall`) |
| `-o, --output <path>`         | Report directory (`run`, `ci`, `report`) or output file (`graph`, `benchmark`)     |
| `-h, --help`, `-v, --version` |                                                                                    |

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

### Scoping to one file: `--only <path>` (`run`, `impact`)

`--only src/cart.ts` keeps only the changes to that file (repeatable; a directory keeps every change under it; a rename matches its old or new path) and selects the tests those changes affect. It restricts the **changed set**, never the dependency analysis: a test that cannot be ruled out for the kept change, for example because an unresolved or dynamic import could reach it, is still selected.

- Other changed files are left out, and a warning names them: tests affected only by them are neither selected nor run. Run without `--only` for the whole change set.
- A path with no change selects no test and says so (`src/cart.ts has no change …`). That is not a pass. To see which tests protect an unchanged file, use `smarttest explain src/cart.ts`.
- With no baseline (first native snapshot), SmartTest cannot tell whether the file changed and keeps its full-suite fallback.
- A scoped run never advances the native snapshot baseline. `--only` cannot be combined with `--all` or `--hook`.
- With `--json`, `impact` adds `only` and `run` adds `report.change.only`: `{ paths, matched, unchanged, excluded }` (requested paths, kept changes, requested paths with no change, left-out changes). The description ends with `· only <paths>`.

## `explain`

`smarttest explain <test>` explains the decision of the last `run` or `impact` while it still applies: same change (the same changed files with the same content, from the same source) and same mode. The output then ends with `decision of the run at <time>`. When the working tree or the index has moved since, or the mode differs (`--mode`, or the configured mode when the run used another), SmartTest analyses the change again and says so: `fresh analysis (the change or mode moved since the run at <time>)`. A test reported as skipped by an older run is never shown as skipped for a newer change.

| Flag          | Meaning                                                             |
| ------------- | ------------------------------------------------------------------- |
| `--fresh`     | Always analyse the current change; ignore the last run's decision   |
| `--units A,B` | For a source file: also list the tests that protect each named unit |
| `--mode <m>`  | Explain the decision in this mode (default: the configured mode)    |

## `run`

| Flag                       | Meaning                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------ |
| `--affected`               | Analyse changes and run affected tests (default)                                           |
| `--all`                    | Full suite through the same pipeline                                                       |
| `--coverage`               | Collect coverage through the runner's provider. Labelled `selected` or `full`              |
| `--retries <n>`            | Retry failing files. A pass after a retry is reported as **flaky**                         |
| `--timeout <ms>`           | Per-runner timeout. Unfinished files become `timed-out`                                    |
| `--workers <n>`            | Passed to the runner as `--maxWorkers`                                                     |
| `--format <f>`             | Repeatable: `html`, `json`, `junit`, `markdown` (default from config)                      |
| `--open`                   | Open the HTML report                                                                       |
| `--no-cache`               | Run tests even when a validated cached pass exists                                         |
| `--shard <i/n>`            | Run shard i of n, balanced by recorded durations                                           |
| `--bail`                   | Stop starting runner groups after one has a failure                                        |
| `--annotations <provider>` | Annotate the CI job: `github`, `gitlab` or `bitbucket` (automatic when the CI is detected) |
| `--no-annotations`         | No CI annotations for this run                                                             |
| `--live`                   | Also run live Playwright specs (see below)                                                 |

`--hook` enables the commit-hook profile with affected-project checks, fail-fast execution, compact output and duration records. It accepts `--staged` or `--push` and rejects sharding. See [commit and push hooks](../guides/commit-hooks.md).

**Live specs.** A Playwright spec is _live_ when every project that runs it targets a deployed environment: its resolved `baseURL` is `https://` on a host that is not `localhost`, `127.x`, `::1` or the URL of a `webServer` the config starts, or it depends on a setup project that does. `run`, `ci`, `run --hook`, `validate-selection`, `benchmark` and `audit --mutate` select it like any spec but do not run it unless `--live` is given: it is reported as "live, not run" (`report.live`, `summary.live`, a skipped JUnit test case), never as passed, and a run that leaves it out does not advance the snapshot baseline or count as a full-suite run. The projects are read from Playwright itself (`playwright test --list` with SmartTest's reporter), so environment variables in the config apply: `E2E_BASE_URL=http://127.0.0.1:5173 smarttest run` treats the same specs as local. A config Playwright cannot list gives no live spec, and a warning: every selected spec runs. Setup projects a selected project depends on run once per run. See [running in CI](../guides/ci.md#live-end-to-end-specs).

Ctrl-C cancels the runner cleanly and reports `cancelled`.

A run the runner failed outside any test (a failing `beforeAll`/`afterAll`, an unhandled error, a failing global teardown or setup project, a non-zero exit with no failed test) is a test failure: the file gets a `(suite)` failure, or, when the runner cannot say which file, each file of that run gets a `(run)` failure quoting the runner's error. The command exits 1, and nothing from it is cached as a pass. Tests the runner did not run because of it are `cancelled`, not skipped.

## `init`

| Flag                          | Meaning                                                                                  |
| ----------------------------- | ---------------------------------------------------------------------------------------- |
| `--dry-run`                   | Print the plan and a diff of every file. Writes nothing, not even `.smarttest/`          |
| `--yes`                       | Apply all planned changes                                                                |
| `--auto`                      | Apply low-risk changes only (config file, `.gitignore`). Leaves `package.json` alone     |
| `--advanced`                  | Choose layout and mode interactively                                                     |
| `--layout <l>` / `--mode <m>` | Override recommendations                                                                 |
| `--rollback`                  | Undo what init changed. Files edited since init are reported and left untouched (exit 5) |

`--rollback` undoes only init's own steps (and `migrate`'s): a hook added later with `smarttest hook install` stays (remove it with `smarttest hook uninstall`). When a file was edited since init, rollback still undoes every other step, leaves that file as it is, lists it and exits 5. The journal then keeps only the steps left, so after you restore or remove the file yourself, `init --rollback` finishes them.

If `.smarttest/` was committed to the repository, `init` adds it to `.gitignore` (with `--yes`, `--auto` or after confirmation) and offers to run `git rm -r --cached .smarttest` interactively; otherwise it prints that command and exits 3 (`ST_STORE_TRACKED`). `doctor --fix` does the same.

In a Git repository, `init` also plans the pre-commit hook (see `hook`): it adds a marked block that runs `smarttest run --staged`, and comments out the hook's existing full-suite test steps (`jest`, `vitest`, `node --test`). The plan lists them; `smarttest hook uninstall` restores them. `--auto` leaves hooks alone.

When sub-projects lay out their tests differently (LeadsIt has colocated `*.server.test.ts` files in one project and `src/__tests__/` in another), `init` writes a `projects` block so generated tests follow each project's convention.

## `hook`

`smarttest hook status` shows the hook manager, whether SmartTest runs in the hook, and the steps that still run whole suites. `smarttest hook install` adds the marked block (`# >>> smarttest >>>` … `# <<< smarttest <<<`) to `.husky/pre-commit`, a `smarttest` command under `pre-commit` in `lefthook.yml`, the `simple-git-hooks` entry in `package.json`, or `.git/hooks/pre-commit` (respecting `core.hooksPath`). `--replace` comments out the existing full-suite test steps with a `: # smarttest-replaced:` prefix so the script stays valid. `--manager <husky|lefthook|simple-git-hooks|git>` overrides detection; `--dry-run` previews, `--yes` skips the confirmation. `smarttest hook uninstall` removes the block and restores replaced steps. When `node_modules/.bin/smarttest` is missing, the hook prints a notice instead of blocking the commit.

With `hook.trailer: true` in the configuration, `hook install` also adds a `commit-msg` step that runs `smarttest hook trailer <message file>` (a marked `# >>> smarttest trailer >>>` block in `.husky/commit-msg` or `.git/hooks/commit-msg`, a `smarttest-trailer` command under `commit-msg` in `lefthook.yml`, the `commit-msg` entry of `simple-git-hooks`, or an action under `commit-msg` in `captainhook.json` when SmartTest runs from CaptainHook). `smarttest hook trailer <file>` adds the `Tests:` trailer from the passing pre-commit record of the committed tree, or nothing; it always exits 0. `hook uninstall` removes the step. See [the commit trailer](../guides/commit-hooks.md#commit-trailer).

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

On GitHub Actions, GitLab CI and Bitbucket Pipelines, `ci`, `run` and `impact` also annotate the job: each selected test file with the reason `explain` gives, the files not run with their reasons, failing files, and a summary with the time saved. GitHub gets workflow commands (at most 10 per level, the last one summarising the rest) and the step summary; GitLab a Code Quality report (`.smarttest/reports/gl-code-quality.json`) and a collapsible log section; Bitbucket a Code Insights report file (`.smarttest/reports/bitbucket-insights.json`) for the pipeline to post. `--no-annotations` or `reports.annotations: false` turns them off; `--annotations <provider>` forces one. With `--json`, the log lines go to stderr. See [CI annotations](../guides/ci.md#annotations-on-the-pull-request).

## `generate`

| Flag                                          | Meaning                                                                 |
| --------------------------------------------- | ----------------------------------------------------------------------- |
| `--class <C>` / `--module <m>` / `--path <p>` | Target selection                                                        |
| `--type unit\|integration\|e2e`               | Category, used in mirror/domain paths                                   |
| `--dry-run`                                   | List files (and contents with `--verbose`) without writing              |
| `--sync`                                      | Report missing tests, orphaned tests and renamed sources. Proposes only |

## `benchmark`

`--commits <n>` (default 10) or `--since <ref>` (every first-parent commit after it), `--sample <n>` (at most n of them, evenly spaced), `--resume` (reuse commits already measured in `.smarttest/reports/benchmark.json`, which is written after each commit), `--traces` (trace the tests at each parent commit so selection uses observed execution), `--mode <m>`, `--live` (also replay live Playwright specs; left out of both runs by default), `--json`, `-o <file.md>`. It replays commits in a temporary Git worktree that reuses the project's installed `node_modules`. For each commit it runs the full suites, records the suites of the projects the commit touched ("project-gated", what most hooks do), then runs SmartTest's selection. Every failing test that wasn't selected is re-run on the parent commit to tell a real miss from a pre-existing failure. With `--traces` it also reports precision: the share of selected test files whose trace ran the changed code ([Runtime evidence](../concepts/runtime-evidence.md#selection-precision)); without traces precision is reported as unmeasured. Exits 5 if anything was missed. Writes `.smarttest/reports/benchmark.{md,json}`.

## `sync`

Compares the configuration with the project as it is now and patches only the keys that changed: `adapters` (a runner was added or replaced), `vcs.provider` (the project adopted Git, or left it), `projects` (new sub-projects with their own conventions). Declared `runners` that no longer exist are reported for a manual fix. `run` and `doctor` warn when the configuration is out of date. `doctor --fix` applies the same patch and also adds `.smarttest/` to `.gitignore` and removes unreadable local state files.

After an upgrade, `sync` also proposes what the new version offers, each proposal as a diff:

| Proposal             | When                                                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `redundant-triggers` | `triggers` lists built-in triggers (lockfiles, `package.json`…): lockfile changes select by package, the entry changes nothing |
| `language-include`   | a hand-written `include` leaves out Python (or PHP) files the project has                                                      |
| `hook-scope`         | Playwright or Cypress specs sit next to a unit runner and the hook runs them all: `hook.runners` leaves them to CI             |
| `hook-trailer`       | the project adds its own test trailer to commit messages (`scripts/test-trailer.sh`), and this version knows `hook.trailer`    |
| `hook-block:<stage>` | the SmartTest block in an installed hook was written by an older version (including a parallel pre-push it can run in again)   |

Nothing is written silently. `--dry-run` prints every diff and writes nothing. In a terminal, `sync` asks for each change; `--apply` (or `--yes`) writes all of them. Without a terminal and without `--apply`, nothing is written and the command exits 3 (`ST_INIT_CONFIRMATION_REQUIRED`). Each file is written once, atomically, and only if it is still the text the proposal was computed from. `--check` exits 3 on drift only; an upgrade proposal never fails it. `--json` adds `upgrades` (and `applied`, `skipped` after a write) to the `sync` document.

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

`graph why <dependency> <dependent>` prints the shortest path by which the dependent file depends on the dependency (a file or `file#Symbol`): `graph why src/math.ts src/math.test.ts` shows how the test reaches `src/math.ts`, and prints that it does not depend on it when no static path exists. `graph cycles` lists import cycles, `graph orphans` lists source files no test reaches.

`--from <file | file#Symbol>`, `--direction dependents|dependencies`, `--depth <n>`, `--format json|dot`, `-o <file>`. Without `--from` the whole graph is exported.

## `snapshot`

`create [--content] [--label <l>]` · `list` · `inspect [id]` · `diff [id]` · `prune [--keep <n>] [--force] [--dry-run]`. Verified baselines (snapshots taken after a fully passing run) survive pruning unless `--force` is passed.

## JSON output

Every `--json` call prints one document with `schemaVersion` and `command` (or the error document). Schemas ship with the package in [`packages/cli/schemas/`](../../packages/cli/schemas): `run`, `impact`, `scan`, `explain`, `ci`, `doctor`, `shard`, `flaky`, `validate-selection`, `hook`, `sync` and `error`, plus `config` for the configuration file. Other commands that accept `--json` are experimental. [Public contracts](contracts.md) lists what is frozen and the semver policy; breaking a schema requires a major version.

## Exit codes

These are versioned and part of the public contract (locked by tests in `@smarttest/shared` and `integration-tests/contracts.test.ts`; see [Public contracts](contracts.md)).

| Code | Category                | Examples                                                                                                                 |
| ---- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 0    | Success                 | All selected tests passed                                                                                                |
| 1    | Test failure            | A test failed, timed out or was cancelled                                                                                |
| 2    | Invalid usage           | Unknown command or flag, bad argument                                                                                    |
| 3    | Configuration failure   | Invalid config, rule conflict, confirmation required in non-interactive mode                                             |
| 4    | Infrastructure failure  | Runner crashed or missing, a selected test no runner executes, Git base missing in a shallow clone, edge provider failed |
| 5    | Safety / policy failure | `validate-selection`, `shadow` or `benchmark` found a missed failure, rollback conflict                                  |
| 70   | Internal error          | A SmartTest bug (e.g. a report integrity violation)                                                                      |
