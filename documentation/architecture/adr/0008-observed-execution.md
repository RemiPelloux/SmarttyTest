# ADR-0008: Observed execution may rule out tests, except in SAFE mode

- **Status:** Accepted (0.5.0)
- **Related:** roadmap 0.5.0, [runtime evidence](../../concepts/runtime-evidence.md), risk R12

## Context

Static analysis over-approximates: a test that reaches a class through a value of unknown type depends on every method of that class. Per-test V8 coverage (`smarttest trace`) shows which functions a test actually ran. Using it to drop tests saves time but relies on the test being deterministic.

## Decision

- A trace is used only while every project file it loaded has the content it had when traced (compared at the base of the change) and the Node/lockfile fingerprint matches. Stale traces are ignored, never reused.
- In FAST and BALANCED mode, a test selected only by static edges (or by uncertainty) is skipped when its fresh trace ran none of the changed functions. A test that ran a changed function is added even when static analysis does not reach it.
- In SAFE mode traces only add tests.
- Traces are never used for non-code changes (environment keys, translation keys, assets, deleted files).
- A skip caused by a trace says so, with the trace date, in `explain` and the reports.

## Consequences

- Fewer tests on code with class-level fallbacks; on LeadsIt the effect was small (1 of 11 files) because static selection was already narrow.
- Data-dependent paths are a residual risk, watched with Shadow Mode (`smarttest shadow`) and SAFE mode for critical code.

## Alternatives considered

- Union only (traces add, never remove): safest, but no time saved. Kept for SAFE.
- Line-level coverage: more precise, but tied to transformed code; function names were robust across Vitest, Jest and `node:test`.
