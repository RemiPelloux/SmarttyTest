# Security review (1.0.0)

The 1.0.0 release gate "Security review: file writes, process execution, Studio" (PRD §30). It records what was reviewed, the threat model, every finding with its fix or the reason it is accepted, and what was not reviewed. Each fix has a regression test, named in the finding.

## Scope

- **File writes**: the store (`.smarttest/`), reports, the config loader's temporary file, `init`, `migrate`, `uninstall` and `rollback`, hook installation into `.git/hooks`, husky, lefthook and simple-git-hooks, test generation, native snapshots, logs and the shadow log. Also the commit hook's temporary checkout and its `node_modules` mirror, and atomic writes (`packages/shared/src/fs.ts`).
- **Process execution**: the runner adapters, `hook.checks` and its `{files}` substitution, Git, Subversion and Mercurial invocations, `smarttest ci`, opening a report, and the environment children inherit. Also the VS Code extension's executable resolution and Restricted Mode.
- **Studio** (`packages/studio`): binding, the session token, Host and Origin checks, CSP and headers, the source, report and export endpoints, the run endpoint, and rendering in `web/js`.
- **Second pass, over the merged `main`**:
  - the plugin loader and edge providers (`packages/core/src/plugins.ts`, `dependency-graph`);
  - the persisted graph (`graph-store.ts`) and index deltas;
  - every other state file that decides what runs;
  - the Studio impact map with its JSON, SVG and DOT exports;
  - line, branch and browser coverage (`coverage-lines.json`);
  - `--only` (`scope.ts`);
  - the hook scope (`hook.runners`, `hook.exclude`);
  - the `@tkmremi/smarttest/playwright` browser coverage fixture and its URL-to-file mapping.
- **Dependencies**: `scripts/release/audit.mjs` (npm audit of the packed CLI), `scripts/release/sbom.mjs`, and `pnpm audit` of the workspace.

## Threat model

SmartTest runs inside a developer's repository and in CI on pull requests, including pull requests from forks. Two kinds of attacker are considered.

1. **Repository content.** Anything in the checkout can be attacker-controlled: the configuration file, sources, test names, branch names, file paths, Git output, runner output, `.smarttest/` state files and coverage JSON.
2. **Local and browser attackers, for Studio.** Other users and processes on the machine, and web pages open in the developer's browser.

Running a repository's tests runs its code. So does loading a `smarttest.config.ts`. SmartTest does not try to sandbox that code (see [AR-1](#accepted-risks)). The review asks a narrower question: can repository content make SmartTest do something the developer or CI did not ask for? That covers:

- writing outside the project;
- running a program by any route other than the project's own test runner and configured checks;
- reading files outside the project into reports or Studio;
- reducing the test selection without running the tests;
- forging what the developer sees.

## Findings

| ID    | Severity | Area         | Title                                                                                             | Status |
| ----- | -------- | ------------ | ------------------------------------------------------------------------------------------------- | ------ |
| SR-01 | High     | File writes  | Committed symbolic links redirect store, log and config-loader writes                             | Fixed  |
| SR-02 | High     | File writes  | Configured paths (`storeDir`, `reports.outputDir`, generator and runner paths) escape the project | Fixed  |
| SR-03 | Medium   | File writes  | `init --rollback` journal and hook installation write outside the project                         | Fixed  |
| SR-04 | Medium   | File writes  | Native snapshot ids and hashes from file content become file paths                                | Fixed  |
| SR-05 | Medium   | Process exec | Option injection into `svn`, `hg`, `git` and Playwright arguments                                 | Fixed  |
| SR-06 | High     | Selection    | A committed store (result cache, index, traces) can reduce the selection                          | Fixed  |
| SR-07 | Low      | Output       | Terminal escape sequences from repository text                                                    | Fixed  |
| SR-08 | Low      | Hooks        | Temporary checkout: `node_modules` mirror through a linked project directory; Git variables       | Fixed  |
| SR-09 | Low      | Process exec | `--open` on Windows ran the report path through `cmd.exe`                                         | Fixed  |
| SR-10 | Low      | VS Code      | No single trust gate before starting the CLI; `executablePath` not a restricted setting           | Fixed  |
| SR-11 | Low      | Reports      | Markdown injection in the CI step summary                                                         | Fixed  |
| SR-12 | Low      | Studio       | Spreadsheet formula injection in the Tests CSV export                                             | Fixed  |
| SR-13 | Low      | Studio       | A malformed Host port skipped the port check                                                      | Fixed  |
| SR-14 | Low      | Studio       | Option-like revisions and traversing snapshot ids as change sources                               | Fixed  |
| SR-15 | Low      | Studio       | Report download followed links; served reports shared Studio's origin                             | Fixed  |
| SR-16 | High     | Selection    | Persisted state (index and delta, graph, discovery, result cache, traces) could be forged         | Fixed  |
| SR-17 | Medium   | Plugins      | Path plugins could be loaded from outside the project                                             | Fixed  |
| SR-18 | Low      | `--only`     | `src/../../x` passed the outside-the-project check                                                | Fixed  |
| SR-19 | Low      | Studio       | DOT export: a line break in the change description left its comment line                          | Fixed  |
| SR-20 | Low      | Studio       | A malformed `coverage-lines.json` entry broke the source view                                     | Fixed  |
| SR-21 | Low      | Coverage     | Browser coverage reported absolute paths when the root sat below a link                           | Fixed  |

SR-01 to SR-15 come from the first pass, on the tree before the persisted graph, plugins, the impact map and line coverage landed. SR-16 to SR-21 come from the second pass over the merged `main`.

### SR-01: committed symbolic links redirect writes (high)

**What happened.** Store writes used `join(storeDir, …)` with `mkdir -p`, `rename`, `appendFile` or `writeFile`. Each of these follows links in the directory components, and `appendFile` and `writeFile` also follow a link at the file itself. A pull request could commit links that redirected these writes:

- `.smarttest/state -> ~/.ssh` redirected the state files into `~/.ssh`.
- `.smarttest/logs/smarttest.log -> ~/.bashrc` made every log line an appended JSON line. A logged file name such as `$(curl … | sh)` then runs when the next shell starts.
- The config loader wrote the transpiled `smarttest.config.ts` to a predictable `.smarttest/tmp/config.<hash>.mjs` with `writeFile`, which follows a link planted at that name.

Any command triggered these writes, including analysis-only commands such as `impact` and `scan`, which never run tests.

**Fix.**

- `confineWrites(root, dir)` registers the store and the report directory when SmartTest opens.
- `writeFileAtomic`, `writeJson`, the file log sink and the shadow log check `assertConfinedWrite`. It refuses (`ST_UNSAFE_PATH`) a path where any existing component below the project root, including the store directory and the file itself, is a symbolic link or junction.
- The config loader checks its temporary path the same way and writes it atomically.
- Temporary files are created with `wx`.
- `doctor --fix` refuses a linked `.gitignore`.

**Tests:**

- `packages/shared/src/security.test.ts`: "store writes never follow a link out of the project".
- `packages/config/src/index.test.ts`: "does not write the transpiled config through a committed .smarttest/tmp link".
- `integration-tests/security.test.ts`: "never writes through a committed .smarttest/state link".

### SR-02: configured paths escape the project (high)

**What happened.** The configuration is repository content, even when it is JSON. Several of its paths were joined to the root unchecked:

- `storeDir` and `reports.outputDir` accepted absolute paths and `../`. `uninstall` removes `storeDir` recursively, so `storeDir: "../.."` or `"."` turned a confirmed uninstall into deleting a parent directory or the project.
- `tests.directory`, `tests.templates` and `runners[].dir`/`config` could point outside the project.
- Generated test targets were written without a containment check.

**Fix.**

- `validateConfig` refuses absolute paths, drive letters, `../` escapes and NUL in all of these, plus `storeDir: "."`. The error is `ST_CONFIG_INVALID`.
- `applyGeneration` checks every target with `assertNoSymlinkBelow`, which refuses `../` and directory links.
- The command-line `--output` flags stay unrestricted, because they are the user's own choice.

**Tests:**

- `packages/config/src/index.test.ts`: "configured paths stay inside the project".
- `packages/test-generator/src/index.test.ts`: "applyGeneration".

### SR-06: a committed store can reduce the selection (high)

**What happened.** Three files in the store decide what runs:

- `.smarttest/cache/results.json` holds cached passes, which are reported as `cached-pass` and not run.
- `.smarttest/state/index.json` caches each file's imports by content hash.
- `.smarttest/state/traces.json` lets a fresh trace rule a test out in balanced and fast modes.

A fork's pull request could commit all three. Content hashes are public, so a crafted cache could claim passes for the changed tests, or a crafted index could drop an import edge. Either way CI turns green without running the affected tests. This breaks the rule that SmartTest never reports a test as passed unless it ran (§32.2).

**Fix.** `SmartTest.open` runs `git ls-files -- <store>/`. When any file under the store is tracked, it refuses with `ST_STORE_TRACKED` (configuration, exit 3) and reads no state. The PRD already requires the store to be excluded from version control (§8.3), and `init` ignores it.

**Test:** `integration-tests/security.test.ts`, "refuses a store that is committed to the repository". It also opens the same project successfully after `git rm --cached`.

**Remaining risk:** see [AR-4](#accepted-risks) and [AR-5](#accepted-risks).

### SR-03: rollback journal and hook installation (medium)

**What happened.**

- `init --rollback` restored every entry of `.smarttest/state/init-journal.json` with `join(root, entry.path)`. A planted journal entry such as `../../.bashrc`, carrying the well-known hash of a default `~/.bashrc` and a malicious `before`, overwrote that file.
- `applyPlan` wrote `.husky/pre-commit` (mode 755) through a committed `.husky -> ~/bin` link. The plan showed only the lexical path, so the approval did not reveal the real destination.

**Fix.**

- A rollback entry is honoured only when one of these holds:
  - it is inside the project and reached without directory links;
  - it is exactly one of Git's own hook files for this repository, which Git may keep outside a subdirectory project or a linked worktree.
- Any other entry is reported as a conflict and left untouched.
- `applyPlan` refuses a directory link below the project root for files inside the project. Git hook paths are already resolved through real paths, and a `core.hooksPath` outside the repository was already refused.

**Test:** `packages/smart-init/src/security.test.ts`.

### SR-04: native snapshot ids and hashes (medium)

**What happened.** Native snapshots are used without a VCS. `list()` returned the `id` written inside each snapshot file, and `prune` and `markVerified` then built ``join(dir, `${id}.json`)`` from it. A crafted id such as `../../../package` made `prune` delete, or `markVerified` rewrite, any `.json` file. Blob paths were also built from the stored `hash`.

**Fix.**

- Ids must match `snap_<time>_<hex>` and equal their file name. Other files are skipped.
- `read` validates ids passed on the command line.
- Blob paths require a 64-hex SHA-256.

**Test:** `packages/native-snapshots/src/index.test.ts`, "never takes a file path from a crafted snapshot's id or hash".

### SR-05: option injection into VCS and runner arguments (medium)

**What happened.**

- **Subversion.** `svn cat -r REV <path>` received repository file names without `--`. A file named `--config-dir=…` points Subversion at a configuration directory from the repository. Such a directory can define tunnel commands and external diff programs, which are command execution. A name containing `@` was also read as a peg revision.
- **Mercurial.** `hg cat -r REV <path>` received file names without `--`. Mercurial accepts global options such as `--config` after the command, and an alias defined with `--config` can run a shell command. File arguments were also read as glob patterns.
- **Git.** A base ref from `vcs.base`, `--base` or Studio, such as `--output=/path`, reached `git merge-base` and `git diff` as an option. CI variables reached `git fetch` the same way.
- **Playwright.** A spec file named like an option reached the command line unescaped.

**Fix.**

- `assertSafeRevision` (`ST_UNSAFE_REVISION`) refuses revisions that start with `-`, contain control characters or exceed 256 characters. It is applied in the Git, Mercurial and Subversion adapters, and Studio validates revisions as well.
- Git's `merge-base` receives the verified commit id instead of the user's text.
- `svn cat` uses `--` and appends a trailing `@` when the name contains one.
- `hg cat` uses `--` and the `path:` pattern kind.
- `smarttest ci` runs the full suite, with a warning, when a CI ref looks like an option.
- Playwright filters start with `[-]` instead of `-`.

**Tests:**

- `packages/vcs-svn/src/index.test.ts`, with a real Subversion repository and a file named `--config-dir=evil`.
- `packages/vcs-hg/src/index.test.ts`.
- `packages/vcs-git/src/index.test.ts`.
- `packages/adapter-playwright/src/index.test.ts`.
- `integration-tests/security.test.ts`, "CI variables".

**Checked and already safe:**

- Runner adapters spawn `node <runner bin>` without a shell and pass absolute file paths.
- `hook.checks` runs the configured command through `sh -c` by design. Its `{files}` substitution single-quotes each file and prefixes it with `./`; this was already tested.

### SR-07: terminal escape sequences (low)

**What happened.** Test names, file paths, branch names, error messages and configuration keys were printed raw. An escape sequence in them could do three things:

- move the cursor over a failure line;
- set the window title;
- write the clipboard (OSC 52) or forge a hyperlink.

**Fix.** `terminalSafe` is applied to every CLI output line, error, warning and verbose log line. It keeps tab, newline and the SGR colour codes SmartTest itself uses, and removes every other escape and C0/C1 control character. `--json` output was already safe because JSON escapes control characters.

**Tests:**

- `packages/shared/src/security.test.ts`, "terminal output".
- `packages/cli/src/main.test.ts`.

### SR-08: hook temporary checkout (low)

**What happened.** The `node_modules` mirror wrote into `join(checkout, projectDir, "node_modules")`, including a `.modules.yaml` file. If the content under test committed that project directory as a link, the mirror landed outside the temporary checkout. Separately, Git variables that locate a repository (`GIT_COMMON_DIR`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_NAMESPACE`) were not removed for the checkout.

**Fix.**

- `escapesCheckout` skips the mirror, with a warning, for a directory that resolves outside the checkout.
- These variables are now also removed for the checkout, and restored for reads of the original repository.

**Test:** `packages/core/src/hook.test.ts`, "temporary checkout isolation".

### SR-09: opening a report on Windows (low)

**What happened.** `--open` ran `cmd /c start "" <path>`. `cmd.exe` interprets `&`, `|` and `^` in the path (for example a project in `R&D`) as commands.

**Fix.** On Windows the path is now passed to `explorer.exe` as a single argument.

**Test:** `packages/cli/src/main.test.ts`, "opening a report".

### SR-10: VS Code Restricted Mode (low)

**What happened.** In Restricted Mode, every feature already checked trust before it acted. But no single gate guarded starting the CLI, and `smarttest.executablePath` was not declared a restricted setting. A workspace's `.vscode/settings.json` is repository content.

**Fix.**

- `ExtensionState.resolveFolder` is the path every CLI start takes. It now refuses with `ST_EXT_UNTRUSTED` in an untrusted workspace.
- The manifest lists `smarttest.executablePath` under `restrictedConfigurations`.
- The existing protection is unchanged: Windows `.cmd` shims are refused when an argument contains a cmd.exe metacharacter, and the JS entry is preferred.

**Test:** `extensions/vscode/test/trust.test.ts`.

### SR-11: markdown injection in the CI summary (low)

**What happened.** `summary.md` is appended to `GITHUB_STEP_SUMMARY` and posted to pull requests. It wrapped file names in single backticks and printed selection reasons unescaped. A file or symbol name could therefore close the code span, add links or tracking images, or split the failing-files table.

**Fix.**

- File names use a code span whose fence is longer than any backtick run in the name, with escaped pipes.
- Text has its markdown punctuation and HTML escaped.

**Test:** `packages/report-engine/src/index.test.ts`, "keeps repository names from injecting markdown into the CI summary".

### SR-12 to SR-15: Studio (low)

Studio was already strong. It binds to loopback only and uses a 32-byte token, compared in constant time, sent only in a header, and kept in the URL fragment, which is removed after load and never sent to the server. It also has:

- `Referrer-Policy: no-referrer`;
- an exact allowlist for Host and Origin, with `Sec-Fetch-Site` checks;
- JSON-only POST mutations and no CORS;
- `default-src 'none'`, `script-src 'self'` and `frame-ancestors 'none'`;
- a 64 KB body limit;
- source reads limited to analysed files, checked by real path;
- a fixed allowlist of report names;
- a run endpoint that takes enums and discovered test files, never command text;
- no `innerHTML` anywhere in `web/js`.

Four gaps were found and fixed:

- **SR-12.** The Tests CSV export wrote repository-controlled cells such as `=HYPERLINK(…)` unchanged. Cells that start with `= + - @`, a tab or a carriage return now get a `'` prefix. Test: `packages/studio/src/web-export.test.ts`.
- **SR-13.** `Host: 127.0.0.1:4173@evil` parsed as "no port", so the port check was skipped. A non-numeric port is now refused. This was not exploitable through DNS rebinding, because the host name must still be loopback. Test: `packages/studio/src/security.test.ts`.
- **SR-14.** `/api/refresh` and `/api/run` passed `source.ref` and `source.target` unchecked, and a `source.id` such as `../../x`. These needed the token. Revisions and snapshot ids are now validated, in addition to SR-04 and SR-05. Test: `packages/studio/src/server.test.ts`.
- **SR-15.** Report downloads followed a link such as `reports/junit.xml -> ~/.ssh/id_rsa`. Served report HTML, which contains repository text, ran on Studio's origin. Downloads now refuse any link below the project root, including a linked `reports/` or store directory. Reports are served with the Studio CSP plus `sandbox`, so they get an opaque origin and no scripts. Test: `packages/studio/src/server.test.ts`.

### SR-16: persisted state could be forged (high)

**What happened.** SR-06 refuses a store committed to Git, but six files decide what runs:

- the symbol index, `state/index.json`, and its delta, `state/index-delta.json`;
- the persisted graph, `state/graph.json`;
- the discovery cache, `state/discovery.json`;
- the result cache, `cache/results.json`;
- traces, `state/traces.json`.

These files also arrive without being committed: from a CI cache, a copied directory, or a Subversion, Mercurial or no-VCS project (AR-5). Every check on them was against public data:

- The index reuses an analysis when the file's size and mtime match, so a forged entry with no imports drops an edge.
- The graph header holds content hashes and a SHA-256 of its own body. A forger recomputes all of them for a body with edges removed.
- The discovery cache maps a key, which hashes public inputs, to the test files of a runner. A forged entry with an empty list hides every test of that runner, even from `--all`.

Any of these turns a CI run green without running the affected tests.

**Fix.** These six files are now authenticated (`packages/shared/src/state.ts`):

- Each file is written with a sibling `<file>.mac`, an HMAC-SHA256 over its exact bytes and its name.
- The key is `SMARTTEST_STATE_KEY` when it is set (at least 32 characters). Otherwise it is a random per-user key in `<user cache dir>/smarttest/state.key` (mode 0600), outside every project.
- A missing or wrong MAC reads as no file, so the state is rebuilt: a cold run, never a smaller selection.
- Restoring a CI cache keeps its benefit only when the saving and restoring jobs share `SMARTTEST_STATE_KEY` as a secret. Fork jobs receive no secrets, so anything a fork wrote, or anything restored into a fork's job, is rebuilt.
- Studio's cache counts read the cache the same way.
- The first run after upgrading rebuilds state once.

**Tests:**

- `packages/shared/src/state.test.ts`.
- `packages/symbol-index/src/index.test.ts`, "SymbolIndex trust".
- `packages/core/src/graph-store.test.ts`: "never restores a graph this machine did not write".
- `packages/core/src/state-trust.test.ts`.
- `integration-tests/security.test.ts`: "does not let a planted discovery cache hide test files".

**Checked and already safe:**

- A restored graph and the index are parsed as JSON only: no code runs, and malformed parts make the graph unusable rather than half-used.
- History, durations, timings and hook records only order, shard or report. The adaptive policy can only widen the selection, to every test.

### SR-17: plugins outside the project (medium)

**What happened.** `plugins` entries that start with `.` or are absolute were resolved with `resolve(root, spec)`. So `../shared/evil.mjs`, `/tmp/x.mjs` or a link inside the project that leads out was imported and run.

**Fix.**

- Path plugins must resolve, by real path, to a file inside the project (`ST_PLUGIN_OUTSIDE_PROJECT`, exit 3), and the configuration validator refuses absolute and `../` entries.
- Package names still resolve from the project's `node_modules`.
- What was already safe, and is now documented in `documentation/guides/plugins.md`:
  - Provider output only adds edges, and `unresolved` becomes uncertainty.
  - A throwing or malformed provider fails the analysis with `ST_PLUGIN_FAILED`. It is never treated as "no edges".
  - `ctx.readFile` refuses paths outside the project.

**Test:** `packages/core/src/plugins.test.ts`.

**Loading on CI forks:** see AR-2.

### SR-18: `--only` traversal (low)

**What happened.** `normalizeScopePath` checked for `../` before normalising, so `src/../../x` passed. The value is the user's own command-line flag and only filters the change set, so this was a correctness gap rather than an escalation.

**Fix.** The path is normalised first.

**Test:** `packages/core/src/scope.test.ts`.

**Hook scope (`hook.runners`, `hook.exclude`), reviewed with no finding:**

- It applies only to the hook's own run. `run` and `ci` ignore it.
- Every file it removes stays selected and is reported as "left to CI", never as passed.
- It is read from the configuration under test, so it is the committer's own setting.

### SR-19 and SR-20: impact map export and line coverage in Studio (low)

**What was checked.**

- The impact map, its JSON export and the on-screen SVG are built with `createElementNS`, `setAttribute` and text nodes. The SVG export serialises that DOM, so names cannot inject markup or scripts.
- DOT identifiers and labels are quoted with `JSON.stringify`.

**SR-19.** The DOT export's first line is a `//` comment that holds the change description, and the description can contain repository text: refs and `--only` paths. A line break in it ended the comment and added DOT statements. Graphviz attributes such as `image=` read local files when the graph is rendered. Line breaks and control characters are now folded into the comment. Test: `packages/studio/src/repository-data.test.ts`.

**SR-20.** `runs/coverage-lines.json` comes from runner output. A malformed entry (no arrays) or a key such as `constructor` threw in `sourceCoverageOf` and broke the source view. Entries are now read as own keys only, with their shape checked. Test: `packages/studio/src/repository-data.test.ts`.

**Checked and already safe:** coverage is shown only for files the source endpoint has already validated, and only when the file's SHA-256 matches the measured one.

### SR-21: browser coverage URL mapping (low)

**What was checked.** The `@tkmremi/smarttest/playwright` fixture writes dumps under a hashed name into the directory SmartTest gives it. `ingestBrowserV8` maps `http(s)`, `/@fs/` and `file:` URLs to candidate files. It reads a file only when its real path is inside the project's real path, and uses it only when the browser's source is byte for byte that file. So encoded `../`, `/@fs/` outside the project and `file:` URLs outside it are never read, which was already tested.

**SR-21.** When the project root was reached through a link, the real file path was made relative to the unresolved root. Coverage then fell back to the absolute path, which leaked it into the report and Studio. Paths are now relative to the root's real path, and dropped if that fails.

**Test:** `packages/coverage-engine/src/lines.test.ts`, "reports project-relative paths when the root is reached through a link". It also covers `/@fs/` and `file:` URLs outside the project.

## Accepted risks

- **AR-1. Project code runs with the user's permissions.** Several things execute project code by design:
  - a TypeScript or JavaScript configuration file, when it is loaded;
  - tests;
  - `hook.checks`;
  - runner configuration files.

  This is the same trust as `npm test`. SmartTest does not sandbox it, and the temporary checkout isolates Git state, not processes.

  In CI, run fork pull requests without secrets: use `pull_request`, not `pull_request_target`, and never run SmartTest on a fork's code in a job that holds deploy credentials. SECURITY.md states this.
- **AR-2. Plugins run their code, including in CI on forks.** The `plugins` option loads edge-provider modules: a file inside the project (SR-17) or an installed package. Loading one runs it with the user's permissions, exactly like loading a TypeScript configuration, and a pull request can add one.

  Disabling plugins on forks would not help. Without its plugins a project loses edges, so a "safe" no-plugin mode would have to select every test. The fork's tests run its code anyway. The answer is the same as AR-1: run fork pull requests without secrets.

  Provider output can only add tests, and a failing provider fails the analysis.
- **AR-3. Races with local processes.** The link checks (SR-01, SR-15, Studio source reads) look at the filesystem before acting. A local process that swaps a directory for a link in between is not defended against. Other local users of the machine are outside the file-write threat model; they could equally edit the repository.
- **AR-4. State written under the same key is trusted.** Since SR-16, state is used only with a valid MAC. Anyone who holds the key can still write state that is trusted: the developer's own user account, or a CI job that holds the `SMARTTEST_STATE_KEY` secret. The rest is ordinary secret hygiene:
  - Give the secret only to jobs that run trusted code.
  - Never expose it to `pull_request_target` jobs that check out a fork.
  - Remember that the per-user key file protects nothing from other processes of the same user.

  Rules for CI caches:
  - Do not restore a store saved by an untrusted pull-request job into a trusted job. GitHub Actions scopes caches saved by pull requests to that pull request.
  - Use `--no-cache` or `safe` mode (traces never rule out tests in `safe`, ADR-0008) where cached passes must not count.
- **AR-5. Tracked-store detection covers Git only.** Subversion, Mercurial and native-snapshot projects are not checked for a committed store. Snapshot ids and hashes are validated (SR-04) and writes are confined (SR-01). Since SR-16 a planted result cache, index, graph, discovery cache or traces file is not read there either, because it has no valid MAC. What remains untrusted-but-read is non-selecting state: history, durations, hook records and reports, which only order, shard or display.
- **AR-6. Development dependency advisories.** `pnpm audit` of the workspace reports 1 low and 2 moderate advisories: `deepmerge`, `minimatch` and `glob`, all through `jest` in the `express-cjs-jest` test fixture. They are not shipped and have no patched release in that dependency range.

  The published package's runtime dependencies: `scripts/release/audit.mjs` reports 0 advisories. The CycloneDX SBOM lists 31 bundled packages and 1 runtime dependency.
- **AR-7. Studio token exposure to the launching user.** The token is printed once in the terminal URL, so anyone who can read that terminal (or its scrollback, or a screen share) can use Studio for as long as it runs. Do not share the URL or expose the port through a tunnel.

## Not reviewed

- **AI and cloud features (§30.3, §30.5).** Not part of 1.0.0.
- **The publishing pipeline.** npm provenance, signing and CI workflow hardening (§30.6) are release tasks, not code.
- **Platform-specific paths not executed here.** The review ran on Linux:
  - Windows junction behaviour is covered by the same `lstat` checks and the existing Windows CI. The `explorer.exe` change (SR-09) was not run on Windows.
  - Mercurial is not installed on the review machine, so SR-05 for `hg` is covered by argument tests only.
- **Third-party runners.** Jest, Vitest, Playwright and Cypress themselves, and what they do with their own configuration files.
- **Third-party plugins.** The code of any plugin a project lists, and packages it resolves from `node_modules`, is the project's code (AR-2). The review covers the loader and what SmartTest does with provider output, not the plugins.
- **Resource exhaustion.** Very large coverage dumps, graphs or reports from repository content can slow or exhaust memory. This is a denial of service against the project's own CI, not an integrity problem.
