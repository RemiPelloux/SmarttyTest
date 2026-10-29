# RAID log — v1.0.0

Reviewed at every sprint review. Scores: Probability × Impact on a scale of 1–5.

## Risks

| ID  | Risk                                                                                                                                    | P   | I   | Score | Mitigation                                                                                                                                                            | Owner                | Linked stories                         |
| --- | --------------------------------------------------------------------------------------------------------------------------------------- | --- | --- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | -------------------------------------- |
| R1  | **Missed regressions**: the static model misses a dependency (dynamic import, DI container, global state) and a failing test is skipped | 3   | 5   | 15    | Unresolved imports recorded and never dropped. Safe fallback. Mandatory triggers. Regression harness gates CI. `validate-selection` for users. Runtime tracing in 1.x | Tech lead            | ST-038, ST-059, ST-058, ST-095, ST-064 |
| R2  | **Analysis overhead** exceeds the time saved on small repos                                                                             | 3   | 4   | 12    | Persistent incremental index. Benchmarks with published results. Adaptive policy recommends `--all` when selection doesn't pay off                                    | Core eng. (analysis) | ST-042, ST-047, ST-096                 |
| R3  | **TypeScript 7 native compiler** changes the programmatic API we depend on                                                              | 3   | 4   | 12    | Spike ST-012. Language adapter isolates the compiler (ADR-0002). Pin TS 6 JS API for 1.0 and track TS 7 API stability                                                 | Tech lead            | ST-012, ST-035                         |
| R4  | **Runner integration fragility**: Jest/Vitest internals or config shapes vary (multi-project, custom environments)                      | 3   | 4   | 12    | Use public CLIs/APIs only. Capability declarations. Fixture matrix across versions. Results compared to native runs                                                   | Core eng. (exec)     | ST-049, ST-050, ST-051                 |
| R5  | **Developer trust**: teams won't skip tests on a new tool's word                                                                        | 4   | 4   | 16    | `explain` from day one. Honest reports. `validate-selection`. FAST/BALANCED/SAFE modes. Design-partner beta at M3                                                     | PO                   | ST-062, ST-064, ST-086                 |
| R6  | **Init damages a project** (overwrites config, duplicates scripts)                                                                      | 2   | 5   | 10    | Dry-run equals the real plan. Atomic writes. Journal plus rollback. Idempotency tests on all fixtures                                                                 | DX eng.              | ST-072, ST-073, ST-075, ST-076         |
| R7  | **Name/npm unavailability** forces a rebrand late                                                                                       | 2   | 3   | 6     | Verify in S0 (ST-011). Brand assets are generated, so a rename is one script run                                                                                      | PO                   | ST-011                                 |
| R8  | **Windows path & process semantics** break selection or cancellation                                                                    | 3   | 3   | 9     | 3-OS CI from S0. Path normalisation utilities. Cancellation tests                                                                                                     | QA                   | ST-006, ST-053, ST-097                 |
| R9  | **Scope creep** toward AI/Studio before the core is trustworthy                                                                         | 3   | 4   | 12    | Charter's out-of-scope list. Changes require PO + tech lead sign-off at review                                                                                        | PO                   | —                                      |
| R10 | **Native SQLite dependency** causes install failures                                                                                    | 2   | 4   | 8     | Spike ST-013. Prefer `node:sqlite` (no native build). Fall back to `better-sqlite3` prebuilt binaries                                                                 | Core eng.            | ST-013, ST-045                         |
| R11 | **Velocity assumption** (40 pts) is optimistic for a new team                                                                           | 3   | 3   | 9     | S0 calibrates velocity. Hardening sprint has a 7-pt buffer. Should/Could stories are the release valve                                                                | Tech lead            | —                                      |

## Assumptions

| ID  | Assumption                                                                                                     | Validate by                 |
| --- | -------------------------------------------------------------------------------------------------------------- | --------------------------- |
| A1  | Node 22 and 24 LTS are the supported runtimes at GA (Node 26 becomes LTS during the release)                   | S0 ADR-0001, re-check at M4 |
| A2  | Jest and Vitest public APIs allow file-level selection and per-test results without private internals          | S4 adapters                 |
| A3  | Static import analysis plus mandatory triggers gives a useful selection ratio (< 40 % of tests on typical PRs) | M2 harness metrics          |
| A4  | 4 engineers are available full-time from S0                                                                    | Kick-off                    |
| A5  | Design partners (≥ 3 teams) will run the beta and `validate-selection` from M3                                 | PO outreach during S5–S7    |

## Issues

| ID  | Issue    | Status |
| --- | -------- | ------ |
| —   | none yet | —      |

## Dependencies

| ID  | Dependency                                                           | Needed by   | Notes   |
| --- | -------------------------------------------------------------------- | ----------- | ------- |
| D1  | `typescript` programmatic API (TS 6.x)                               | S2          | See R3  |
| D2  | `node:sqlite` stability on Node 22/24, or `better-sqlite3` prebuilds | S3          | See R10 |
| D3  | npm org/scope `@smarttest` and package `smarttest`                   | S10 publish | ST-011  |
| D4  | GitHub repository + Actions minutes for 3-OS matrix                  | S0          | —       |
