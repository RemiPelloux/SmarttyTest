# Architecture Decision Records

We record significant decisions as lightweight ADRs (context → decision → consequences). An ADR is **Proposed** until it is accepted at a sprint review. Superseded ADRs stay in place and link to the ADR that replaces them.

| ADR                                            | Title                                                                | Status                      |
| ---------------------------------------------- | -------------------------------------------------------------------- | --------------------------- |
| [0001](0001-typescript-pnpm-monorepo.md)       | TypeScript pnpm monorepo, Node 22+/24 LTS                            | Accepted                    |
| [0002](0002-typescript-analysis-engine.md)     | TypeScript analysis engine (TS 6 API, syntactic + resolveModuleName) | Accepted                    |
| [0003](0003-local-store-sqlite.md)             | Local intelligence store (JSON store, SQLite deferred)               | Accepted (amended)          |
| [0004](0004-deterministic-core-ai-optional.md) | Deterministic, local-first core; AI optional                         | Accepted                    |
| [0005](0005-capability-declared-adapters.md)   | Capability-declared adapters, never emulate                          | Accepted                    |
| [0006](0006-contracts-first.md)                | Contracts first, in `shared` during Sprint 0                         | Accepted                    |
| [0007](0007-name-license-distribution.md)      | Name, license and distribution                                       | Proposed (decision pending) |
| [0008](0008-observed-execution.md)             | Observed execution may rule out tests, except in SAFE mode           | Accepted (0.5.0)            |
| [0009](0009-validated-result-cache.md)         | Validated result cache, reported as cached                           | Accepted (0.8.0)            |

Boundaries from ADR-0004 are enforced by `pnpm check:boundaries` (`scripts/check-boundaries.mjs`).

Template: copy [`template.md`](template.md).
