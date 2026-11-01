# Security review (1.0.0)

The 1.0.0 release gate "Security review: file writes, process execution, Studio" (PRD §30). It records what was reviewed, the threat model, every finding with its fix or the reason it is accepted, and what was not reviewed. Each fix has a regression test, named in the finding.

## Scope

- **File writes**: the store (`.smarttest/`), reports, the config loader's temporary file, `init`, `migrate`, `uninstall` and `rollback`, hook installation into `.git/hooks`, husky, lefthook and simple-git-hooks, test generation, native snapshots, logs and the shadow log. Also the commit hook's temporary checkout and its `node_modules` mirror, and atomic writes (`packages/shared/src/fs.ts`).
- **Process execution**: the runner adapters, `hook.checks` and its `{files}` substitution, Git, Subversion and Mercurial invocations, `smarttest ci`, opening a report, and the environment children inherit. Also the VS Code extension's executable resolution and Restricted Mode.
- **Studio** (`packages/studio`): binding, the session token, Host and Origin checks, CSP and headers, the source, report and export endpoints, the run endpoint, and rendering in `web/js`.
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

## Accepted risks

- **AR-1. Project code runs with the user's permissions.** Several things execute project code by design:
  - a TypeScript or JavaScript configuration file, when it is loaded;
  - tests;
  - `hook.checks`;
  - runner configuration files.

  This is the same trust as `npm test`. SmartTest does not sandbox it, and the temporary checkout isolates Git state, not processes.

  In CI, run fork pull requests without secrets: use `pull_request`, not `pull_request_target`, and never run SmartTest on a fork's code in a job that holds deploy credentials. SECURITY.md states this.
- **AR-2. Plugins.** 1.0.0 has no `plugins` option. Adapters are bundled and chosen from a fixed list (`vitest`, `jest`, `node`, `playwright`, `cypress`), and `@smarttest/plugin-sdk` serves only those. Third-party plugins are a post-1.0 feature and will need their own review, including a rule for whether project-local plugins load in CI on forks.
- **AR-3. Races with local processes.** The link checks (SR-01, SR-15, Studio source reads) look at the filesystem before acting. A local process that swaps a directory for a link in between is not defended against. Other local users of the machine are outside the file-write threat model; they could equally edit the repository.
- **AR-4. Untracked state is trusted.** SR-06 refuses state committed to Git. State restored from a CI cache, or copied in another way, is still trusted. Rules for CI caches:
  - Do not restore a store saved by an untrusted pull-request job into a trusted job. GitHub Actions scopes caches saved by pull requests to that pull request.
  - Use `--no-cache` or `safe` mode (traces never rule out tests in `safe`, ADR-0008) where cached passes must not count.
- **AR-5. Tracked-store detection covers Git only.** Subversion, Mercurial and native-snapshot projects are not checked for a committed store. Snapshot ids and hashes are validated (SR-04) and writes are confined (SR-01), but a planted result cache or index in those repositories is still read.
- **AR-6. Development dependency advisories.** `pnpm audit` of the workspace reports 1 low and 2 moderate advisories: `deepmerge`, `minimatch` and `glob`, all through `jest` in the `express-cjs-jest` test fixture. They are not shipped and have no patched release in that dependency range.

  The published package's runtime dependencies: `scripts/release/audit.mjs` reports 0 advisories. The CycloneDX SBOM lists 31 bundled packages and 1 runtime dependency.
- **AR-7. Studio token exposure to the launching user.** The token is printed once in the terminal URL, so anyone who can read that terminal (or its scrollback, or a screen share) can use Studio for as long as it runs. Do not share the URL or expose the port through a tunnel.

## Not reviewed

- **`packages/core/src/graph-store.ts` and index deltas.** They are not in this tree. Today the persisted graph state is the symbol index (`state/index.json`), which SR-01 and SR-06 cover. The new store needs the same review when it lands: confined writes, refused when tracked, and a crafted file must never drop an edge without a fallback.
- **AI and cloud features (§30.3, §30.5).** Not part of 1.0.0.
- **The publishing pipeline.** npm provenance, signing and CI workflow hardening (§30.6) are release tasks, not code.
- **Platform-specific paths not executed here.** The review ran on Linux:
  - Windows junction behaviour is covered by the same `lstat` checks and the existing Windows CI. The `explorer.exe` change (SR-09) was not run on Windows.
  - Mercurial is not installed on the review machine, so SR-05 for `hg` is covered by argument tests only.
- **Third-party runners.** Jest, Vitest, Playwright and Cypress themselves, and what they do with their own configuration files.
