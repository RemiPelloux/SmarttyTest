# Risks

Reviewed when a version ships. Probability and impact on a 1 to 5 scale.

| ID  | Risk                                                                                                 | P   | I   | Mitigation                                                                                                                                                                   | Roadmap       |
| --- | ---------------------------------------------------------------------------------------------------- | --- | --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| R1  | A finer graph (method level, mocks, env keys) misses a real dependency and a failing test is skipped | 3   | 5   | Every new edge type ships with a fixture and runs in the regression harness; unresolved relationships stay uncertainty and select the test; Shadow Mode on real repositories | 0.3, 0.4, 0.5 |
| R2  | Type-aware analysis is too slow for a pre-commit hook                                                | 3   | 4   | Build programs only for changed files and their dependents; cache per content hash; fall back to symbol level past a time budget                                             | 0.3           |
| R3  | Runtime tracing slows test runs                                                                      | 3   | 3   | Collect traces on full runs and in Shadow Mode, not on every hook run; per-file granularity                                                                                  | 0.5           |
| R4  | Framework conventions (Next.js, Wasp, NestJS) change between versions                                | 3   | 3   | Edge providers are plugins with version-aware detection; unknown versions fall back to plain import edges                                                                    | 0.4           |
| R5  | No hosted CI, so Windows and macOS regressions go unnoticed                                          | 3   | 3   | Run `pnpm verify` on all three systems before each release (local machines or VMs); path handling is POSIX-normalised and unit-tested                                        | 0.6           |
| R6  | The npm name `smarttest` is not available                                                            | 2   | 3   | Decide before 0.6.0; brand assets are generated, so a rename is mechanical                                                                                                   | 0.6           |
| R7  | The result cache returns a stale result                                                              | 2   | 5   | Content-addressed keys over all inputs; cached results always labelled; integrity suite in `pnpm verify`                                                                     | 0.8           |
| R8  | Studio exposes the file system to other local processes                                              | 2   | 4   | Loopback only, session token, origin checks, restricted project root                                                                                                         | 0.9           |
| R9  | Analysis overhead exceeds the time saved on small repositories                                       | 3   | 3   | Adaptive policy skips analysis when a full run is cheaper; benchmarks published per release                                                                                  | 0.6           |
| R10 | TypeScript 7 removes the API the analyzer uses                                                       | 4   | 3   | Analyzer isolated in `language-typescript`; TS 6 pinned; TS 7 adapter in 0.7                                                                                                 | 0.7           |

## Assumptions

| ID  | Assumption                                                          | Checked by   |
| --- | ------------------------------------------------------------------- | ------------ |
| A1  | Node 22.12+ and 24 remain the supported runtimes until 1.0.0        | each release |
| A2  | Jest, Vitest and Node expose per-file coverage without private APIs | 0.5 spike    |
| A3  | Five external repositories are available for the 0.6.0 gate         | before 0.6   |

## Dependencies

| ID  | Dependency                                                      | Needed by |
| --- | --------------------------------------------------------------- | --------- |
| D1  | `typescript` 6.x programmatic API (and a TS 7 equivalent later) | 0.3, 0.7  |
| D2  | npm name and scope                                              | 0.6       |
