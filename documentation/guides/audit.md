# Auditing selection

SmartTest's promise is that a skipped test could not have failed. `smarttest audit` measures that promise on your project instead of asking you to trust it. Each check reports a miss when there is one; exit code 1 means it found one.

```bash
smarttest audit --mutate          # fault injection: the direct measure of missed tests
smarttest audit --resolution      # every import resolves as the TypeScript compiler resolves it
smarttest audit --traces          # every file a test loaded can select it
```

The report is written to `.smarttest/reports/audit.json` and `audit.md` (`-o file.md` copies it).

## Fault injection (`--mutate`)

One function at a time is made to throw on entry (`throw new Error(…)`, or `raise RuntimeError(…)` in Python), in a temporary checkout of HEAD. SmartTest selects the tests for that change, then the full suite runs. A test that fails but was not selected is a missed test, by definition.

| Outcome    | Meaning                                                                                                                         |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------- |
| caught     | A selected test failed                                                                                                          |
| survived   | No test failed at all: the function is not exercised by the suite (a gap in the tests, not in SmartTest)                        |
| missed     | A test failed and was not selected: a bug in SmartTest; please report it                                                        |
| load-flaky | A test failed in the full run but passes alone with the fault in place: it fails next to other tests, not because of the change |

Options: `--mutants n` (default 10) functions sampled with `--seed n` (default 1, so a run can be repeated), `--budget ms` to stop starting new ones. Tests that fail before any fault is injected are left out of every comparison. Your files are never changed: the faults go into the temporary checkout, which is removed afterwards. SmartTest's own configuration and local plugins are never broken.

Each mutant runs the full suite, so the time is about `mutants × full suite`. On a large project, start with `--mutants 10 --budget 900000`.

## Resolution (`--resolution`)

For each import the TypeScript compiler resolves into the project, with the nearest `tsconfig.json`, SmartTest must point to the same file. A mismatch where SmartTest took a project file for a package means a dependency it cannot see. Imports SmartTest leaves unresolved are counted apart: they are uncertainty, which selects.

## Reachability (`--traces`)

Each test file runs alone while SmartTest records what it loads: the code it ran (V8 coverage), the files it read through `fs` (templates, JSON, fixtures), and for Python the modules it imported and the files it opened. Every such project file must reach that test: through the graph, through the runner's configuration (setup files), or because the test is uncertain and always selected. A pair the graph does not link is confirmed with the full impact analysis before it is reported. `--sample n` limits the run to n test files.

A typical finding: a test reading `data/rates.json` through a path relative to the working directory. Nothing in the code ties the file to the test, so a change to it selects nothing. Read it through a path built from `import.meta.url` or `__dirname`, which SmartTest follows. Environment files are tracked by key and left out of this check.

## In CI

The repository's nightly workflow runs all three checks on every fixture (`pnpm audit:fixtures`). For your project, a scheduled job is enough:

```yaml
- run: npx smarttest audit --mutate --mutants 20 --resolution
```

`benchmark` complements it: it replays recent commits with their real changes, where `audit` injects synthetic ones.
