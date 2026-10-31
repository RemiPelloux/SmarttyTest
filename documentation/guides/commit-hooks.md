# Commit and push hooks

A hook tests the content being committed or pushed. In 0.9.0, `run --staged` uses the Git index and `run --push` uses committed content. When the working tree differs, SmartTest creates a temporary checkout, links installed dependencies, runs there, and removes the checkout. It never stashes the user's work. The checkout's Git index matches the content under test, so `git diff --cached` inside a check shows the staged change. Workspace packages linked in `node_modules` (for example `node_modules/@acme/lib -> ../../packages/lib`) point at the package in the checkout, so an import loads the staged content, not unstaged edits. A linked package's untracked build output (such as `dist/`) is taken from the working tree and named in a warning, because it may not match the staged source; any other link that still reaches the working tree, including links inside pnpm's store (`node_modules/.pnpm`), is reported the same way. A run ended by Ctrl-C, SIGTERM or SIGHUP removes its checkout; a checkout left by a killed run is removed at the start of the next one. Only SmartTest's own checkouts are unregistered: your worktrees are never pruned, even when their directory is missing for now. Files whose content is the same in the checkout and the working tree keep the working tree's index entries, so the next normal run does not re-read the whole project.

## Install

Preview before writing the hook:

```bash
smarttest hook install --replace --dry-run
smarttest hook install --replace --yes
```

For pre-push:

```bash
smarttest hook install --pre-push --replace --dry-run
smarttest hook install --pre-push --replace --yes
```

Husky, lefthook, simple-git-hooks and plain Git hooks are detected. `--manager` chooses one explicitly. Plain Git hooks go where Git looks for them: `.git/hooks` (shared by linked worktrees) or `core.hooksPath`, relative to the repository's top level. A `core.hooksPath` outside the repository is refused (`ST_HOOK_PATH_OUTSIDE_REPO`), and so is an existing hook that is not a shell script (`ST_HOOK_NOT_SHELL`); call SmartTest from such hooks yourself. When the project is in a subdirectory of the repository, the block (and the simple-git-hooks command) changes to that directory, in a subshell, before it looks for `node_modules/.bin/smarttest`. Lefthook only reads its configuration at the repository's top level: for a project in a subdirectory, install says so, and the command belongs in the top-level `lefthook.yml` with `root:` set to the project directory.

A pre-push hook receives the pushed refs on stdin. The SmartTest block reads them once, passes them to SmartTest and restores them, so later steps in the same script (such as a `while read local_ref local_sha remote_ref remote_sha` guard) still receive them. The simple-git-hooks command does the same for the existing command, and the lefthook entry sets `use_stdin: true`. Running install again upgrades a block written by an earlier version. With simple-git-hooks, run `npx simple-git-hooks` after applying the package.json plan. Lefthook test steps that cannot be safely rewritten are listed as remaining; remove duplicate commands after reviewing them.

`--replace` comments out recognised test steps, including `vitest related` and package scripts that invoke a runner. A background step retains a successful background job so the script's existing PID and `wait` statements still work. Uninstall restores the replaced steps:

```bash
smarttest hook uninstall --dry-run
smarttest hook uninstall --yes
```

An existing SmartTest hook is upgraded to the hook profile when you run install again. Hooks installed locally must also be set up on each teammate's machine using the project's hook manager.

## What runs

The pre-commit command is `smarttest run --staged --hook`; pre-push uses `smarttest run --push --hook`. The profile uses fail-fast ordering, bail, validated result caching and parallel runner groups. A cached result remains “cached, not run”. Tests outside the selection remain “skipped, not run”.

Pre-push compares HEAD with the upstream merge-base. With no upstream, it tries the remote's default branch and the conventional `origin/main` and `origin/master` refs. A missing comparison base must broaden selection; it cannot justify ignoring older commits. Push mode checks the current HEAD. A push that only deletes remote branches sends no content: it runs no tests or checks, exits 0 and is recorded as nothing pushed. A push that also sends another commit or ref is refused, because SmartTest will not report a pass for content it did not test; push the checked-out commit (for example `git push origin HEAD`) or check out the ref first.

The compact output shows the changed-file count, selected tests, failing files and their first errors, check results and elapsed time. `smarttest explain <test>` gives the full selection reason.

## Project checks

Checks run in the affected project's directory, alongside the tests, at most one per CPU core at a time:

```ts
import { defineConfig } from "smarttest";

export default defineConfig({
  hook: {
    budgetMs: 60000,
    checks: [
      { name: "Lint", run: "npx --no-install eslint {files}", files: "**/*.{ts,tsx,js,jsx}" },
      { name: "Types", run: "npm run type-check", projects: ["app", "backend"], stage: "both" },
      { name: "Build", run: "npm run build", projects: ["app"], stage: "pre-push" },
    ],
  },
});
```

`projects` contains project directories relative to the SmartTest root; `""` means the root project. Configured projects, workspace packages and runner directories count, and `./packages/app/` is the same as `packages/app`. A check naming a directory that is none of these is reported as a warning with the hook result, since it would never run. Omitting `projects` allows every affected project. The deepest detected project owns a changed file. `files` filters project-relative paths. `{files}` is replaced with the changed paths, quoted and prefixed with `./` so a file named like an option (`-rf`) is never read as one. Commands default to pre-commit; `stage` also accepts `pre-push` and `both`.

Use checks that inspect content. A command that rewrites or stages files runs inside the temporary checkout when isolation is necessary; those edits do not update the user's index. Locale generation, formatting with writes, and other commit preparation should happen before SmartTest.

## Budget and bypasses

`hook.budgetMs` is an expectation, not a timeout. When recorded test durations exceed it, SmartTest names the slowest files and suggests moving checks to pre-push or refreshing traces. Unknown durations make the estimate incomplete. The hook still runs the complete selection.

```bash
smarttest hook status
smarttest hook status --pre-push --json
smarttest doctor
```

Status includes recorded durations, recent failures, explicit bypasses and commits with no matching successful hook record. `SMARTTEST_SKIP=1` records an explicit bypass. Git's `--no-verify` prevents the hook from starting, so SmartTest can only infer a missing record later. A missing record also occurs when a hook is not installed; it does not prove a deliberate bypass. The local history cannot measure other developers' hook installations.
