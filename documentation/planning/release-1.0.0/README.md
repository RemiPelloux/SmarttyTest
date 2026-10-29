# SmartTest v1.0.0 "Impact" — release charter

> **Release goal:** ship a reliable, useful npm package that initialises itself, understands what changed, runs only the tests that matter (with conservative fallbacks), explains every decision and organises the test architecture. No account, no cloud and no AI required.

|                |                                                                                                                                                    |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spec mapping   | Release 0 (Foundation) + Release 1 (Intelligent npm MVP) of [PRD §35](../../product/PRD.md#35-release-roadmap). Covers every **P0** module in §3.2 |
| Capacity       | 11 sprints (S0–S10) × **40 points** (hard cap 42 per sprint)                                                                                       |
| Scope          | **15 epics · 103 user stories · 422 committed points** (+6 stretch)                                                                                |
| Team           | 4 engineers + 0.5 QA/reliability + 0.5 PO/DevRel · planned velocity 40 pts per sprint                                                              |
| Implementation | **v0.1.0 alpha: 389 / 422 committed points done**. 10 stories partial, 2 stretch todo. See the status column in [epics](epics/README.md)           |
| Milestones     | M0 Foundation → M1 `0.1.0-alpha` → M2 `0.3.0-alpha` → M3 `0.6.0-beta` → M4 `1.0.0-rc.1` → **M5 `1.0.0`**                                           |

**Documents in this folder**

| File                                                                 | What it is                                                                    |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| [`sprints.md`](sprints.md)                                           | Sprint calendar, goals, demos, burn-up, milestones (generated)                |
| [`epics/`](epics/README.md)                                          | One file per epic, with full user stories and acceptance criteria (generated) |
| [`backlog.csv`](backlog.csv)                                         | Import file for GitHub Projects / Jira / Linear (generated)                   |
| [`backlog.data.mjs`](backlog.data.mjs)                               | **Source of truth.** Edit this, then run `pnpm planning:build`                |
| [`definition-of-ready-and-done.md`](definition-of-ready-and-done.md) | Working agreements                                                            |
| [`risks.md`](risks.md)                                               | RAID log (risks, assumptions, issues, dependencies)                           |

---

## 1. Scope

### In scope for 1.0.0

| Capability                                                                                   | Commands                                    | Epics    |
| -------------------------------------------------------------------------------------------- | ------------------------------------------- | -------- |
| Project detection                                                                            | `scan`, `doctor`                            | DET, CLI |
| Smart Init: explained plan, dry-run, safe writes, idempotent, rollback                       | `init`, `init --dry-run`, `init --rollback` | INI      |
| Change tracking: Git (branches, staged, uncommitted, renames) + native snapshots + hybrid    | `vcs`, `snapshot`                           | VCS      |
| TS/JS source intelligence: symbols, imports, classes, exports, semantic diff                 | (internal), `graph`                         | SRC, GRA |
| Impact selection: direct + transitive, FAST/BALANCED/SAFE, mandatory triggers, safe fallback | `impact`, `run --affected`, `run --all`     | IMP      |
| Explanations                                                                                 | `explain`                                   | IMP      |
| Selection validation against a full run                                                      | `validate-selection`                        | IMP, QLT |
| Rules engine                                                                                 | `rules list / validate / explain`           | RUL      |
| Jest + Vitest adapters with honest statuses, scheduling, timeouts, cancellation, retries     | `run`                                       | EXE      |
| Test architecture generator: mirror/colocated/custom, templates, scaffolds (`it.todo`), sync | `generate`                                  | GEN      |
| Reports: HTML, JSON, JUnit, Markdown, coverage ingestion with scope                          | `report`, `coverage`                        | REP      |
| CI: versioned JSON contracts, GitHub Actions template                                        | —                                           | CI       |
| Trust: regression harness, benchmarks, cross-platform, provenance, SBOM                      | —                                           | QLT, REL |

### Explicitly out of scope (planned later)

| Deferred                                         | Target          | Why it waits                                                                |
| ------------------------------------------------ | --------------- | --------------------------------------------------------------------------- |
| Adaptive configuration / `sync` / `migrate`      | Release 2 (1.x) | Needs a stable config model and usage data first                            |
| SVN, Mercurial, Perforce adapters                | Release 2 / 6   | Git + native covers the 1.0 audience; the contract is ready for them        |
| Runtime tracing, OBSERVED_EXECUTION edges        | Release 2       | Static analysis + safe fallback first; tracing then makes selection tighter |
| Persistent result cache, watch mode              | Release 2       | Cache correctness depends on tracing and fingerprints maturing              |
| Continuous Shadow Mode                           | Release 2       | 1.0 ships `validate-selection` (on demand) as the trust tool                |
| Diff/branch coverage gates                       | Release 2       | 1.0 ingests and scopes coverage honestly                                    |
| AI (provider manager, generation, audit, repair) | Release 3       | AI stays optional (ADR-0004); the deterministic core comes first            |
| SmartTest Studio GUI                             | Release 4       | HTML report + `graph` export are the 1.0 visual surfaces                    |
| Cloud / SaaS                                     | Release 5       | Open-core adoption first                                                    |
| Python / Java / Go                               | Release 6       | Plugin SDK contracts are designed for it from S0                            |

## 2. Release exit criteria (Definition of Done for 1.0.0)

All must be true to tag `1.0.0`:

1. **Correctness:** regression harness (ST-095) reports **0 missed known failures** across all fixtures in BALANCED and SAFE modes.
2. **Honesty:** report integrity suite (ST-090) is green. Skipped ≠ passed, partial ≠ full, fallback is always flagged.
3. **Setup:** `smarttest init` succeeds on **8/8 fixtures**, is idempotent, and `init --rollback` restores the original tree byte for byte.
4. **Non-destructive:** no test in the suite observes an existing user file being overwritten by `init` or `generate`.
5. **Performance:** benchmarks (ST-096) are published. Warm startup < 300 ms, warm selection < 200 ms, HTML report < 2 s on the medium repo. Any target that is missed is reported as missed.
6. **Compatibility:** e2e suite green on Linux, macOS and Windows with Node 22 and 24, npm/pnpm/Yarn, Jest and Vitest.
7. **Docs:** time to first affected run is under 5 minutes for 3 of 3 external testers who follow only the docs.
8. **Supply chain:** published with npm provenance and a CycloneDX SBOM. No high-severity advisories.
9. **All Must stories** are done. Should stories are done or explicitly moved to 1.1 at sprint review.

## 3. Product metrics we will watch after GA

From PRD §33, kept small for 1.0:

| Metric                                                                | Target after GA                   |
| --------------------------------------------------------------------- | --------------------------------- |
| Setup success rate (`init` completes without manual edit)             | ≥ 85 %                            |
| Time to first meaningful run                                          | median < 5 min                    |
| Missed reproducible failures reported by users (`validate-selection`) | 0 unexplained                     |
| Fallback frequency in BALANCED                                        | measured; < 25 % on typical repos |
| Median CI time saved on suitable suites                               | 30 %+ (reported, not promised)    |

## 4. Ways of working

| Ceremony             | When               | Output                                                       |
| -------------------- | ------------------ | ------------------------------------------------------------ |
| Sprint planning      | Start of sprint    | Sprint goal + committed stories (≤ 42 pts)                   |
| Daily sync           | Daily, async-first | Blockers surfaced                                            |
| Backlog refinement   | Mid-sprint         | Next 2 sprints meet the Definition of Ready                  |
| Sprint review / demo | End of sprint      | Demo script from [`sprints.md`](sprints.md), milestone check |
| Retrospective        | End of sprint      | ≤ 3 actions, tracked                                         |
| Risk review          | Every review       | [`risks.md`](risks.md) updated                               |

**Branching & versions:** trunk-based, short-lived branches, Changesets for versioning. Pre-releases go to the `next` dist-tag. Feature flags are used for incomplete commands, which stay hidden from `--help` until they are ready.

**Estimation:** Fibonacci story points (1–8). Anything above 8 gets split. Spikes are time-boxed and pointed.

## 5. Updating the plan

```bash
# 1. edit documentation/planning/release-1.0.0/backlog.data.mjs
pnpm planning:build                # regenerates epics/, sprints.md, backlog.csv (validates deps & capacity)
pnpm planning:issues               # dry run of GitHub labels/milestones/issues
pnpm planning:issues --apply       # create them (requires `gh auth login`)
```

CI runs `pnpm planning:build --check`, so generated files can never drift from the data.
