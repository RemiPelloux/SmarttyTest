# ADR-0004: Deterministic, local-first core; AI optional

- **Status:** Accepted
- **Related:** PRD §1.4, §17.3, §30.2

## Context

Developers must be able to trust that skipped tests were skipped for verifiable reasons. AI is valuable for generating and auditing tests, but it is not deterministic, it costs money, and it may send code off the machine.

## Decision

- Source analysis, impact selection, rules, execution and reporting are **deterministic and work offline with no account**.
- No package at or below `core` may depend on `ai-*`, `studio-*` or `cloud-*` packages, or make network calls. This is enforced by the boundary checks in ST-002.
- **No telemetry** in 1.0. Local timings stay local (ST-055).
- AI features (Release 3) plug in as optional packages that consume the core's indexes and propose changes. They never decide on selection.

## Consequences

- Each selection decision can be reproduced from its inputs (ChangeSet, graph, rules, mode).
- Some "smart" behaviour, such as guessing the intent of a change, is deliberately out of scope for the core.
