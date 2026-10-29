# ADR-0005: Capability-declared adapters, never emulate

- **Status:** Accepted
- **Related:** ST-009, PRD §7.3, §12.5, §27.5

## Context

Runners and VCS providers differ. Some support test-case selection, per-test coverage, rename detection or merge-base, and some don't. Quietly approximating a missing feature would weaken selection safety without anyone noticing.

## Decision

- Every adapter returns a capabilities object where each value is `true | false | "partial"`. **Anything not declared counts as unsupported.**
- The impact engine adapts its granularity to what the adapter declares. For example, it selects at file level when test-case selection is unsupported. Any downgrade is reported in the decision's warnings.
- A conformance kit in `plugin-sdk` checks the declared capabilities against fixtures.

## Consequences

- Selection may be coarser on some runners. That is fine because it stays honest.
- Third-party adapters get a clear contract and a test suite to run against.
