# Architecture overview

> SmartTest is an intelligent layer **on top of** existing test runners. It works out what changed, what depends on it and which tests protect it, then lets Jest, Vitest, `node --test`, Playwright or Cypress do the running.

This document describes the architecture as of 0.9.0, including the local Studio server and the VS Code CLI client. The full long-term architecture (AI and Cloud) is in [PRD §4](../product/PRD.md#4-system-architecture). Decisions are recorded in [ADRs](adr/README.md).

## Layers

```mermaid
flowchart TB
  subgraph Surface["Surfaces"]
    CLI["smarttest CLI<br/><small>packages/cli</small>"]
    Studio["Local Studio<br/><small>packages/studio</small>"]
    Editor["VS Code extension<br/><small>extensions/vscode</small>"]
  end

  CORE["Application core<br/><small>packages/core</small>"]

  subgraph Project["Project engine"]
    DET["project-detector"]
    INIT["smart-init"]
    CFG["config"]
  end

  subgraph Change["Change engine"]
    VCSCORE["vcs-core"]
    GIT["vcs-git"]
    SVN["vcs-svn"]
    HG["vcs-hg"]
    SNAP["native-snapshots"]
  end

  subgraph Code["Code engine"]
    PARSER["source-parser"]
    TS["language-typescript"]
    JS["language-javascript"]
    SYM["symbol-index"]
    SEM["semantic-diff"]
    GRAPH["dependency-graph"]
  end

  subgraph Decide["Decision engine"]
    RULES["rules-engine"]
    IMPACT["impact-engine"]
    SEL["test-selector"]
  end

  subgraph Test["Test engine"]
    DISC["test-discovery"]
    EXEC["test-executor"]
    VIT["adapter-vitest"]
    JEST["adapter-jest"]
    NODE["adapter-node"]
    PW["adapter-playwright"]
    CY["adapter-cypress"]
    COV["coverage-engine"]
    GEN["test-generator"]
  end

  REP["report-engine"]
  STORE[("Local intelligence store<br/>.smarttest/")]

  CLI --> CORE
  CLI --> Studio
  Studio --> CORE
  Editor --> CLI
  CORE --> Project & Change & Code & Decide & Test & REP
  Code --> STORE
  Change --> STORE
  Test --> STORE
  REP --> STORE
```

**Rules of the road**

1. **Dependencies point inwards.** `shared` → contracts → engines → `core` → `studio` → `cli`. The manifest (`scripts/packages.manifest.json`) is the source of truth and the scaffolder rejects cycles.
2. **The core is deterministic and local.** Nothing in `core` or below may make network calls or depend on `ai-*` packages ([ADR-0004](adr/0004-deterministic-core-ai-optional.md)).
3. **Adapters declare capabilities.** Anything not declared counts as unsupported and is never emulated ([ADR-0005](adr/0005-capability-declared-adapters.md)).
4. **Uncertainty is data.** Unresolved imports, dynamic patterns and partial change sets are stored and passed along. They never get dropped.

## The `run --affected` data flow

```mermaid
sequenceDiagram
  autonumber
  actor Dev as Developer
  participant CLI as cli
  participant Core as core
  participant VCS as vcs-git / native-snapshots
  participant Code as symbol-index + semantic-diff
  participant G as dependency-graph
  participant R as rules-engine
  participant I as impact-engine
  participant X as test-executor (+ adapter)
  participant Rep as report-engine

  Dev->>CLI: smarttest run --affected --base main
  CLI->>Core: runAffected(options)
  Core->>VCS: getChanges(base, working-tree)
  VCS-->>Core: ChangeSet (completeness, warnings)
  Core->>Code: update index for changed files (incremental)
  Code-->>Core: SemanticChange[] (with confidence)
  Core->>G: apply updates, reverse-traverse from changed symbols
  G-->>Core: candidate tests + paths + uncertainty
  Core->>Core: compare with fresh traces (observed execution)
  Core->>R: evaluate rules for affected symbols
  R-->>Core: risk, mandatory tests, effective mode
  Core->>I: decide(candidates, rules, mode, uncertainty)
  I-->>Core: ImpactDecision (selected / skipped / reasons / fallback)
  Core->>X: execute(selection) via Jest / Vitest / node --test
  X-->>Core: TestRunResult (normalized statuses)
  Core->>Rep: write JSON / HTML / JUnit / Markdown
  Core-->>CLI: summary + exit code
  CLI-->>Dev: 12 selected · 474 skipped (not run) · why? smarttest explain
```

## Package map

| Package                                          | Responsibility                                                     | Epic |
| ------------------------------------------------ | ------------------------------------------------------------------ | ---- |
| `@smarttest/shared`                              | Contracts from the spec, primitives, `SmartTestError`, exit codes  | FND  |
| `@smarttest/config`                              | `defineConfig`, schema, loader, validation                         | FND  |
| `@smarttest/plugin-sdk`                          | Public adapter contracts + conformance kit                         | FND  |
| `@smarttest/project-detector`                    | Runtime, package manager, workspaces, frameworks, runners, VCS, CI | DET  |
| `@smarttest/smart-init`                          | Recommendation engine, plan, safe writes, journal, rollback        | INI  |
| `@smarttest/vcs-core`                            | `VersionControlAdapter`, `ChangeSet` utilities                     | VCS  |
| `@smarttest/vcs-git`                             | Git adapter                                                        | VCS  |
| `@smarttest/vcs-svn` / `vcs-hg`                  | Subversion and Mercurial adapters                                  | VCS  |
| `@smarttest/native-snapshots`                    | Snapshots, fingerprints, comparisons                               | VCS  |
| `@smarttest/source-parser`                       | Language-neutral parse pipeline & cache                            | SRC  |
| `@smarttest/language-typescript` / `-javascript` | Language adapters                                                  | SRC  |
| `@smarttest/symbol-index`                        | Persistent incremental symbol index                                | SRC  |
| `@smarttest/semantic-diff`                       | Change classification with confidence                              | SRC  |
| `@smarttest/dependency-graph`                    | Member-level graph, resource nodes, mock-aware traversal, queries  | GRA  |
| `@smarttest/rules-engine`                        | Rule evaluation, precedence, explanations                          | RUL  |
| `@smarttest/impact-engine`                       | Modes, mandatory triggers, fallbacks, decisions                    | IMP  |
| `@smarttest/test-selector`                       | Decision → runnable selection                                      | IMP  |
| `@smarttest/test-discovery`                      | Normalized discovery                                               | EXE  |
| `@smarttest/test-executor`                       | Scheduling, timeouts, cancellation, retries                        | EXE  |
| `@smarttest/adapter-vitest` / `-jest` / `-node`  | Runner adapters (Vitest, Jest, `node --test`)                      | EXE  |
| `@smarttest/adapter-playwright` / `-cypress`     | End-to-end runner adapters                                         | EXE  |
| `@smarttest/coverage-engine`                     | Coverage ingestion with scope                                      | REP  |
| `@smarttest/test-generator`                      | Layouts, templates, scaffolds, sync                                | GEN  |
| `@smarttest/report-engine`                       | JSON / HTML / JUnit / Markdown + integrity                         | REP  |
| `@smarttest/core`                                | Orchestration API used by CLI and Studio                           | FND  |
| `@smarttest/studio`                              | Loopback HTTP API, session security, run stream and web interface  | UI   |
| `smarttest`                                      | The CLI (`bin: smarttest`)                                         | CLI  |

## Interface and hook boundaries

Studio binds to loopback and serves its packaged assets without a CDN. A session token, host checks and origin checks protect its API; state changes require POST. It delegates analysis and execution to `core` and stores reports in the same `.smarttest/` directory as the CLI. Only Studio may import `node:http` and `node:net`; network imports remain forbidden in the engine packages. The VS Code extension calls the installed local CLI in a trusted workspace.

Commit and push profiles share the core API. When the working tree differs from the content under test, core creates a temporary checkout, materialises the staged index or committed HEAD and links installed dependencies. Checks and tests use that checkout; reports and history use the original store. The user's index and working files are not stashed or rewritten. Push hooks validate Git's input refs and reject non-HEAD content that the profile cannot test.

## Local intelligence store

```text
.smarttest/                    (git-ignored, path configurable via storeDir)
├── state/
│   ├── index.json             per-file analyses (content-hash cached), file stats, resolution context
│   ├── discovery.json         files each runner collects (cached per config and file list)
│   ├── durations.json         last measured duration per test file
│   ├── traces.json            observed execution per test file (smarttest trace)
│   ├── history.json           last results per test (fail-fast order, smarttest flaky)
│   ├── timings.json           typical analysis time and last full run (adaptive policy)
│   ├── hooks.json             checked trees, durations, checks and explicit bypasses
│   ├── snapshots/             snapshot manifests (hashes; content optional)
│   ├── blobs/                 deduplicated gzip content (when snapshots.storeContent)
│   └── init-journal.json      what init changed → rollback
├── runs/                      latest.json, <runId>.json, last-decision.json, coverage.json, flaky.json
├── reports/                   report.html · report.json · junit.xml · summary.md · setup.md
├── shadow/                    history.jsonl (smarttest shadow)
├── cache/                     results.json: validated passing results (ADR-0009)
├── coverage/                  raw coverage per runner root
└── logs/                      smarttest.log (JSON, redacted, rotated at 1 MB)
```

See [ADR-0003](adr/0003-local-store-sqlite.md) for why this is a JSON store and not SQLite in 1.0.

## Distribution

Internal `@smarttest/*` packages are private. `scripts/release/bundle-cli.mjs` bundles the CLI and every engine into one ESM package, `smarttest`, with `typescript` as its only runtime dependency (loaded with `require`, so Node does not scan it for ESM exports). A separate `parse-worker.js` entry parses files in worker threads on cold starts. The engine is loaded lazily and Node's compile cache is enabled, so `--help` and `--version` start in under 100 ms. `release:pack` also writes a CycloneDX SBOM and runs `npm audit`.

## Where the spec contracts live

The TypeScript contracts from the spec (`ChangeSet`, `SourceSymbol`, `ImpactDecision`, `TraceRecord`, `TestAdapter`, `LanguageAdapter`, `VersionControlAdapter`) are in [`packages/shared/src/contracts`](../../packages/shared/src/contracts) for Sprint 0. They will move to their owning packages once their APIs stabilise ([ADR-0006](adr/0006-contracts-first.md)).
