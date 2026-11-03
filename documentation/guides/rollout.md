# Rolling SmartTest out to a repository

What the first rollouts (OpenPro's four JavaScript repositories, then Galdia, opal-frontend and OpenProAuto) showed: each step below catches a different problem before it reaches a commit hook.

## 1. Install and look

```bash
npm install -D @tkmremi/smarttest
npx smarttest doctor
npx smarttest scan
```

`doctor` lists each runner and how many test files it collects. Compare that count with your runner's own listing. `scan` and `doctor` also report **files a runner collects that SmartTest does not analyse** (excluded by `exclude`, or in a build-output folder): no change can select those, so fix them first.

## 2. Parity: the full suite through SmartTest

```bash
npx smarttest run --all
```

It must report the same tests and failures as your runner alone. A difference here is a configuration problem (a runner started the wrong way, a missing setup file), and every later step depends on it. To compare one runner at a time, keep the others out with `--runner vitest`.

## 3. Measure on your history

```bash
npx smarttest benchmark --commits 20          # real commits: missed failures and time saved
npx smarttest audit --mutate --resolution     # injected faults: missed tests, directly
```

Both must report **0 missed**. `benchmark` re-runs a missed failure alone on the commit and its parent, so failures that were already there, or that happen only under load, are reported apart. A failure the audit reports as missed is a SmartTest bug; please report it.

## 4. Hooks

```bash
npx smarttest init            # proposes the config and the hook; --dry-run shows the diff
npx smarttest hook install    # pre-commit; --pre-push for pre-push
```

- An existing hook is kept. A test step it already runs (`vitest related`, `jest --findRelatedTests`, a full suite) is commented out and replaced **in place**, so the steps before it keep running first; `hook uninstall` restores it.
- A hook the repository keeps in its tree and copies into `.git/hooks` (`cp scripts/hooks/pre-commit $(git rev-parse --git-path hooks)/` in `prepare`) is edited at its source; run the copy command again afterwards. `hook status` says when the installed copy is older.
- A pre-push step run in the background (`… &`) gets Git's refs from SmartTest's block. Without them, SmartTest compares with the upstream merge-base and says so.
- When SmartTest is not installed (dependencies not installed yet), the hook stops the commit with a message; `--no-verify` skips it.

## 5. What the hook runs, and what it leaves to CI

End-to-end suites against a live environment rarely belong in a commit hook. Keep them in CI with `hook.runners`:

```ts
export default defineConfig({
  hook: { runners: ["vitest"], budgetMs: 60_000 },
});
```

Selected tests outside the hook's runners are reported as left to CI, never as passed. When an estimate passes `budgetMs`, the warning names what widened the selection (a lockfile, a config file, a setup file) and the files with no recorded duration. `benchmark` follows `hook.runners`, so it measures what the hook runs (`--runner all` for everything).

## 6. CI

```yaml
- run: npx smarttest ci
```

`smarttest ci` picks the base itself on pull requests and branch builds; see [Running in CI](ci.md).

## Dependency updates

A lockfile or `package.json` dependency change selects the code that imports the packages that changed, and the packages depending on them. It still runs everything when a test or build tool changed, when a declared package is loaded by something other than code (a runner plugin, a CLI in a script), or when a config or stylesheet names it; the trigger's reason says which. Angular projects mostly hit the first case: the Angular builder lists the `@angular/*` packages as peers.
