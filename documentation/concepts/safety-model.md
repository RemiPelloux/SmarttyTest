# Safety model

No static analysis can guarantee that a skipped test would have passed. SmartTest's job is to make that risk small, measured and visible, and never hidden.

## What SmartTest will never do (PRD §32.2)

- Label skipped tests as passed.
- Treat unknown dependencies as definitely unrelated.
- Present partial coverage as global coverage.
- Claim generated tests are verified without running them.
- Reuse invalid cached results.
- Ignore critical configuration changes without warning.
- Suppress test failures to improve reported performance.

## How each guarantee is enforced

| Guarantee                  | Mechanism                                                                                                                            | Story              |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------ |
| Skipped ≠ passed           | Separate status `skipped by selection`. Report integrity suite in CI                                                                 | ST-051, ST-090     |
| Unknown ≠ unrelated        | Unresolved imports and dynamic patterns are stored as uncertainty and trigger fallback per mode                                      | ST-038, ST-059     |
| Global changes widen scope | Built-in mandatory triggers that can't be removed by rules                                                                           | ST-058, ST-066     |
| Partial ≠ full coverage    | Every coverage figure is labelled `full` or `selected`, and the two are never merged                                                 | ST-088             |
| No silent destruction      | Dry-run equals the real plan. Atomic writes. Init journal and rollback. Generator never overwrites                                   | ST-072–076, ST-082 |
| Evidence before trust      | `validate-selection`, `shadow` and `benchmark` compare against full runs. The regression harness runs in the pre-push gate           | ST-064, ST-095     |
| No stale evidence          | A trace is used only while every file it loaded is unchanged and the runtime/lockfile fingerprint matches                            | 0.5.0              |
| Observed skips are bounded | Traces never rule out tests in SAFE mode, never for env, translation or asset changes, and only tests selected by static edges alone | 0.5.0              |

## Adoption path we recommend

1. Observe. Run `smarttest impact` on PRs without changing CI and read the explanations.
2. Validate. Run `smarttest validate-selection` on a sample of real changes and check that 0 failures are missed.
3. Record. Run `smarttest trace` and, on a schedule, `smarttest shadow`; `shadow --report` shows whether any failure was ever missed.
4. Adopt on PRs. Use `run --affected --mode balanced` on pull requests and keep `run --all` on `main` and nightly.
5. Tighten. Add rules for critical areas (`risk: critical`) so they always run in SAFE mode.
