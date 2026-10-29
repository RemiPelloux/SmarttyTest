# Roadmap

| Release       | Version            | Theme                                                                                                                                          | Status                                                                                   |
| ------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Release 0 + 1 | **1.0.0 "Impact"** | Foundation + intelligent npm MVP: Smart Init, Git + snapshots, TS/JS analysis, graph, impact selection, rules, Jest/Vitest, generator, reports | **In progress · v0.1.0 alpha · 389 / 422 pts done** → [charter](release-1.0.0/README.md) |
| Release 2     | 1.x                | Advanced intelligence: adaptive config/`sync`, SVN, runtime tracing, diff coverage, result cache, watch mode, Shadow Mode                      | Backlog                                                                                  |
| Release 3     | 2.0 (tentative)    | AI test engineering, optional: provider manager, generation, audit, repair, review                                                             | Backlog                                                                                  |
| Release 4     | —                  | SmartTest Studio: local web GUI                                                                                                                | Backlog                                                                                  |
| Release 5     | —                  | SmartTest Cloud: team analytics, PR intelligence, shared cache, billing                                                                        | Backlog                                                                                  |
| Release 6     | —                  | Multi-language: Python, Java, Go; more VCS; cross-language analysis                                                                            | Backlog                                                                                  |

The sequence follows [PRD §35](../product/PRD.md#35-release-roadmap). It is re-evaluated at each milestone using benchmark results and feedback from design partners.

```mermaid
flowchart LR
  S0["S0 Foundation · 39"] --> S1["S1 Detect & diff · 36"] --> S2["S2 Changes & parsing · 36"] --> S3["S3 Symbols & graph · 39"]
  S3 --> S4["S4 Semantics & runners · 39"] --> S5["S5 Selection engine · 40"] --> S6["S6 First affected run · 39"]
  S6 --> S7["S7 Smart Init · 40"] --> S8["S8 Generate & polish · 40"] --> S9["S9 Reports & trust · 41"] --> S10["S10 Hardening & GA · 33"]
  S3 -.-> M1(("M1 0.1.0-alpha"))
  S6 -.-> M2(("M2 0.3.0-alpha"))
  S8 -.-> M3(("M3 0.6.0-beta"))
  S9 -.-> M4(("M4 1.0.0-rc.1"))
  S10 -.-> M5(("M5 1.0.0"))
```
