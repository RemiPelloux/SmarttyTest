# ADR-0006: Contracts first, in `shared` during Sprint 0

- **Status:** Accepted
- **Related:** ST-009, ST-026, ST-044

## Context

Many engines are built in parallel. They need agreed data shapes from day one (`ChangeSet`, `SourceSymbol`, `ImpactDecision` and so on), and those shapes are already defined in the spec.

## Decision

- The spec's interfaces are written down as TypeScript types in `packages/shared/src/contracts` before any implementation, along with `SmartTestError` and the exit codes.
- Once a contract's owning package stabilises (`vcs-core`, `plugin-sdk`, `impact-engine`), the type moves there and `shared` re-exports it for one minor version.
- A contract change needs a PR that updates the spec reference in the type's TSDoc.

## Consequences

- Engines can be developed in parallel against stable types.
- `shared` will temporarily hold more than it should in the long run. That is acceptable.
