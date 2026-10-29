# SMARTTEST

## Complete Product Requirements Document & Technical Design Specification

**Document Version:** 2.0<br>
**Document Status:** Master Specification<br>
**Product Name:** SmartTest (working name)<br>
**Product Type:** Intelligent Testing Platform<br>
**Distribution:** npm, CLI, SDK, Desktop/Web Studio, CI/CD, SaaS<br>
**Business Model:** Open Source Core + Commercial Cloud<br>
**Initial Languages:** TypeScript / JavaScript<br>
**Future Languages:** Python, Java, Go, C#, PHP, Rust, Kotlin, and more<br>
**Core Philosophy:** Intelligent by default. Deterministic at its core. AI-enhanced. Developer-first.

> This is the master specification, kept as the source of truth. It covers the intelligent testing engine, automated setup, Git/SVN/native version tracking, AI-powered test engineering, a Cypress-like GUI, multi-language architecture and the commercial SaaS model.
> It is written for developers, AI coding agents, architects and QA engineers.
> **Scope for v1.0.0** is defined in the [roadmap](../planning/roadmap.md) (what is built so far: [delivery log](../planning/delivery.md); the first 103 stories: [foundation backlog](../planning/foundation/README.md)). Section numbers (§) are what the backlog and ADRs cite.

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Target Users and Use Cases](#2-target-users-and-use-cases)
3. [Product Scope and Delivery Priorities](#3-product-scope-and-delivery-priorities)
4. [System Architecture](#4-system-architecture)
5. [Smart Init — Fully Automated Setup](#5-smart-init--fully-automated-setup)
6. [Adaptive Configuration Engine](#6-adaptive-configuration-engine)
7. [Universal Version Control System](#7-universal-version-control-system)
8. [SmartTest Native Snapshot Engine](#8-smarttest-native-snapshot-engine)
9. [Source Code Intelligence Engine](#9-source-code-intelligence-engine)
10. [Dependency Graph Engine](#10-dependency-graph-engine)
11. [Intelligent Test Impact Engine](#11-intelligent-test-impact-engine)
12. [Runtime Tracing Engine](#12-runtime-tracing-engine)
13. [Automatic Test Architecture Generator](#13-automatic-test-architecture-generator)
14. [Custom Rules Engine](#14-custom-rules-engine)
15. [Smart Test Execution Engine](#15-smart-test-execution-engine)
16. [Coverage Intelligence](#16-coverage-intelligence)
17. [SmartTest AI — Universal AI Testing Assistant](#17-smarttest-ai--universal-ai-testing-assistant)
18. [AI Provider Setup and Model Discovery](#18-ai-provider-setup-and-model-discovery)
19. [AI Command System](#19-ai-command-system)
20. [AI Test Generation Engine](#20-ai-test-generation-engine)
21. [AI Coverage Audit and Gap Detection](#21-ai-coverage-audit-and-gap-detection)
22. [AI Test Repair, Improvement, and Review](#22-ai-test-repair-improvement-and-review)
23. [SmartTest Autopilot](#23-smarttest-autopilot)
24. [SmartTest Studio — Interactive GUI](#24-smarttest-studio--interactive-gui)
25. [Reporting Engine](#25-reporting-engine)
26. [CLI Developer Experience](#26-cli-developer-experience)
27. [Plugin SDK and Multi-Language Support](#27-plugin-sdk-and-multi-language-support)
28. [SmartTest Cloud — Commercial Platform](#28-smarttest-cloud--commercial-platform)
29. [Business Model and Monetization](#29-business-model-and-monetization)
30. [Security and Privacy](#30-security-and-privacy)
31. [Performance Requirements](#31-performance-requirements)
32. [Reliability and Correctness](#32-reliability-and-correctness)
33. [Metrics and KPIs](#33-metrics-and-kpis)
34. [Engineering Backlog](#34-engineering-backlog)
35. [Release Roadmap](#35-release-roadmap)
36. [Definition of Done](#36-definition-of-done)
37. [Key Technical Risks](#37-key-technical-risks)
38. [Product Success Criteria](#38-product-success-criteria)
39. [Final Product Positioning](#39-final-product-positioning)
40. [Final Product Objective](#40-final-product-objective)

---

# 1. Executive Summary

## 1.1. Product Vision

SmartTest is a next-generation software testing intelligence platform designed to automatically understand source code changes, identify affected components, select the most relevant tests, execute them efficiently, and generate detailed, interactive reports.

Unlike conventional testing tools, SmartTest should understand the relationship between source code, dependencies, tests, runtime execution, coverage, and code history.

SmartTest must also automatically discover and configure existing software projects, generate organized test architectures, adapt to changing development environments, and optionally use artificial intelligence to generate, audit, repair, and improve tests.

The platform will include:

1. **SmartTest Core:** Intelligent code analysis and test-impact engine.
2. **Smart Init:** Fully automated project discovery and configuration.
3. **Universal Version Control:** Support for Git, SVN, Mercurial, Perforce, and a native snapshot engine.
4. **Adaptive Configuration:** Automatic detection of project and environment changes.
5. **Automatic Test Architecture:** Source-aware organization and generation of test directories.
6. **Rules Engine:** Custom testing policies at project, package, class, and method levels.
7. **Smart Execution:** Selective, risk-aware, parallelized test execution.
8. **Coverage Intelligence:** Analysis of code coverage and missing test protection.
9. **SmartTest AI:** Optional AI-driven test generation, auditing, repair, and optimization.
10. **SmartTest Studio:** An interactive testing GUI inspired by the usability of Cypress.
11. **Reporting Engine:** Modern, detailed, explainable test and coverage reports.
12. **SmartTest Cloud:** Collaboration, CI optimization, historical analytics, and enterprise capabilities.

## 1.2. Main Objective

Transform software testing from a mostly static and repetitive process into a continuously adaptive system that understands:

- What changed.
- Which components depend on the changed code.
- Which behaviors may be affected.
- Which tests can detect relevant regressions.
- Which tests are missing.
- Which tests should execute.
- Why those tests were selected.
- How to improve test quality.
- How much execution time and CI capacity can be saved.

## 1.3. Product Statement

**SmartTest — Understand the change. Test what matters.**

## 1.4. Fundamental Principles

**Local-first:** Core functionality must work without cloud services or user accounts.

**Framework-agnostic:** SmartTest orchestrates existing testing frameworks rather than replacing them.

**Deterministic-first:** Critical decisions must be based on verifiable analysis and explicit policies.

**AI-optional:** Artificial intelligence enhances the experience but is not required.

**Non-destructive:** SmartTest must preserve existing source files, tests, and custom configurations unless explicitly authorized to modify them.

**Explainable:** Every test-selection decision must have a traceable explanation.

**Adaptive:** SmartTest should evolve with the project without requiring repeated manual setup.

**Secure:** Source code, credentials, and execution artifacts must be protected.

**Performance-oriented:** Analysis overhead must remain lower than the savings it enables whenever selective execution is appropriate.

**Extensible:** New languages, frameworks, providers, and version-control systems must be supported through plugins.

## 1.5. Important Engineering Constraint

No static or dynamic analysis engine can universally guarantee that a skipped test could not detect a regression.

Dynamic imports, reflection, shared state, external services, environment changes, and other runtime behaviors create uncertainty.

SmartTest must therefore use conservative fallbacks, explicit risk policies, and periodic full-suite validation.

The product must never present skipped tests as passed tests.

---

# 2. Target Users and Use Cases

## 2.1. Independent Developers

Primary needs:

- Simple installation.
- Automatic test organization.
- Intelligent local testing.
- Coverage reports.
- Fast feedback.
- Optional AI assistance.
- No account or subscription requirements.

## 2.2. Development Teams

Primary needs:

- Faster pull request validation.
- Lower CI execution costs.
- Shared testing rules.
- Reliable regression detection.
- Test-quality monitoring.
- Historical reports.
- Collaboration.

## 2.3. Engineering Managers

Primary needs:

- Visibility into test quality.
- CI execution efficiency.
- Coverage trends.
- Flaky-test monitoring.
- Maintenance costs.
- Engineering productivity metrics.
- Risk identification.

## 2.4. QA Engineers

Primary needs:

- Test discovery.
- Coverage analysis.
- Missing scenario detection.
- Test creation and maintenance.
- Test execution visualization.
- Regression investigation.
- Test architecture management.

## 2.5. Enterprise Organizations

Primary needs:

- Multi-repository support.
- Custom version-control systems.
- Centralized governance.
- Security controls.
- Private deployments.
- Compliance features.
- Organization-wide analytics.

---

# 3. Product Scope and Delivery Priorities

## 3.1. Priority Definitions

**P0 — Core MVP:** Essential for a usable, publicly distributable package.

**P1 — Advanced Product:** High-value enhancements after the core is stable.

**P2 — Platform Expansion:** Commercial, AI, and multi-language extensions.

## 3.2. Functional Modules

| Module                 | Priority | Description                              |
| ---------------------- | -------- | ---------------------------------------- |
| Smart Init             | P0       | Automatic project setup                  |
| Project Detector       | P0       | Technology and structure discovery       |
| Git Adapter            | P0       | Git change tracking                      |
| Native Snapshot Engine | P0       | Local changes without Git                |
| Source Parser          | P0       | AST and semantic analysis                |
| Dependency Graph       | P0       | Code relationship mapping                |
| Impact Engine          | P0       | Change-impact calculation                |
| Test Discovery         | P0       | Existing test identification             |
| Test Selector          | P0       | Intelligent test selection               |
| Rules Engine           | P0       | Custom testing policies                  |
| Test Generator         | P0       | Automatic test structure and scaffolding |
| Jest Adapter           | P0       | Jest integration                         |
| Vitest Adapter         | P0       | Vitest integration                       |
| Report Engine          | P0       | Local HTML and machine-readable reports  |
| CLI UX                 | P0       | Interactive and scriptable terminal      |
| Adaptive Configuration | P1       | Project evolution detection              |
| SVN Adapter            | P1       | Subversion integration                   |
| Runtime Tracer         | P1       | Execution-to-test mapping                |
| Advanced Coverage      | P1       | Diff and branch coverage intelligence    |
| SmartTest Studio       | P1       | Interactive local GUI                    |
| Watch Mode             | P1       | Continuous incremental testing           |
| Intelligent Cache      | P1       | Validated execution caching              |
| CI Integrations        | P1       | GitHub Actions and other CI systems      |
| AI Provider Manager    | P1       | LLM connection and model discovery       |
| AI Test Generation     | P1       | Automated test creation                  |
| AI Coverage Audit      | P1       | Coverage and behavior analysis           |
| AI Test Repair         | P2       | Assisted test maintenance                |
| Mercurial Adapter      | P2       | Mercurial integration                    |
| Perforce Adapter       | P2       | Perforce integration                     |
| Cloud SaaS             | P2       | Commercial platform                      |
| Multi-language SDK     | P2       | New language support                     |
| Enterprise Features    | P2       | Governance and private deployment        |

## 3.3. Initial Compatibility

The MVP must support:

- Node.js projects.
- JavaScript.
- TypeScript.
- ESM and CommonJS projects.
- npm.
- pnpm.
- Yarn.
- Standard workspaces and monorepos.
- Jest.
- Vitest.
- Git.
- Projects without version control.

Framework-specific detection should initially prioritize:

- React.
- Next.js.
- Express.
- NestJS.
- Node.js libraries.

The architecture must not assume that every supported project uses one of these frameworks.

---

# 4. System Architecture

## 4.1. Architectural Overview

SmartTest will use a modular architecture separating project discovery, source intelligence, change tracking, test selection, execution, reporting, and optional AI capabilities.

```text
                         SMARTTEST
                             |
                   CLI / Studio / SDK
                             |
                  APPLICATION CORE
                             |
       +---------------------+--------------------+
       |                     |                    |
   PROJECT ENGINE        CODE ENGINE         TEST ENGINE
       |                     |                    |
   Smart Init            AST Analysis         Test Discovery
   Configuration         Symbol Index         Test Selection
   Environment           Dependency Graph     Execution
   VCS Adapters          Semantic Diff        Coverage
   Native Snapshots      Impact Analysis      Runtime Tracing
       |                     |                    |
       +---------------------+--------------------+
                             |
                     RULES & SAFETY ENGINE
                             |
                    LOCAL INTELLIGENCE STORE
                             |
                 Cache / Traces / Graph / Runs
                             |
                      REPORTING ENGINE
                             |
                  CLI / HTML / JSON / CI
                             |
                    OPTIONAL AI ENGINE
                             |
                    OPTIONAL CLOUD API
```

## 4.2. Monorepo Structure

```text
smarttest/
├── apps/
│   ├── studio/
│   ├── docs/
│   ├── playground/
│   ├── cloud-console/
│   └── cloud-api/
│
├── packages/
│   ├── cli/
│   ├── core/
│   ├── config/
│   ├── shared/
│   │
│   ├── smart-init/
│   ├── project-detector/
│   ├── environment-scanner/
│   ├── adaptive-config/
│   │
│   ├── vcs-core/
│   ├── vcs-git/
│   ├── vcs-svn/
│   ├── vcs-mercurial/
│   ├── vcs-perforce/
│   ├── native-snapshots/
│   │
│   ├── source-parser/
│   ├── symbol-index/
│   ├── semantic-diff/
│   ├── dependency-graph/
│   ├── impact-engine/
│   │
│   ├── test-discovery/
│   ├── test-selector/
│   ├── test-generator/
│   ├── test-executor/
│   ├── runtime-tracer/
│   ├── coverage-engine/
│   ├── rules-engine/
│   ├── quality-engine/
│   ├── cache-engine/
│   │
│   ├── report-engine/
│   ├── studio-server/
│   │
│   ├── ai-core/
│   ├── ai-provider-manager/
│   ├── ai-test-generator/
│   ├── ai-test-auditor/
│   ├── ai-test-repair/
│   ├── ai-test-review/
│   │
│   ├── adapter-jest/
│   ├── adapter-vitest/
│   ├── adapter-playwright/
│   ├── adapter-cypress/
│   │
│   ├── language-typescript/
│   ├── language-javascript/
│   └── plugin-sdk/
│
├── examples/
│   ├── node/
│   ├── react/
│   ├── nextjs/
│   ├── nestjs/
│   ├── monorepo/
│   └── no-vcs/
│
├── benchmarks/
├── fixtures/
├── integration-tests/
├── e2e-tests/
├── scripts/
└── documentation/
```

## 4.3. Technology Stack

### Core

- TypeScript in strict mode.
- Supported Node.js LTS versions.
- pnpm Workspaces.
- TypeScript Compiler API for TypeScript-aware semantic analysis.
- Tree-sitter where incremental parsing or additional language support provides value.
- SQLite for persistent local metadata.
- Worker threads or child processes where appropriate.
- Schema validation for external configuration.
- Content-addressed caching.

### SmartTest Studio

- React.
- TypeScript.
- Vite or equivalent build tooling.
- Tailwind CSS.
- Accessible component library.
- Interactive graph visualization.
- WebSocket-based live updates.
- Local HTTP API.

### Cloud

- TypeScript backend.
- PostgreSQL.
- Object storage.
- Queue-based background jobs.
- Tenant-aware authentication and authorization.
- Usage metering.
- OpenTelemetry instrumentation.

### Future Native Acceleration

High-cost CPU operations may be migrated to Rust if measured benchmarks justify the complexity.

This must not be a prerequisite for the initial npm package.

---

# 5. Smart Init — Fully Automated Setup

## 5.1. Objective

`smarttest init` must provide a near-zero-configuration installation experience.

The developer should not need to manually identify their test framework, source directories, module structure, or version-control system.

SmartTest should inspect the project, create a recommended setup plan, explain it, and apply authorized changes.

## 5.2. Main Commands

```bash
smarttest init
smarttest init --auto
smarttest init --advanced
smarttest init --dry-run
smarttest init --yes --non-interactive
smarttest doctor
smarttest sync
```

## 5.3. Project Discovery

Smart Init must detect:

### Runtime Environment

- Operating system.
- CPU architecture.
- Node.js version.
- Available CPU resources.
- Available memory.
- Relevant environment variables.
- Filesystem permissions.
- Installed runtime tools.

### Project Structure

- Package manager.
- Package manifest.
- Workspace configuration.
- Monorepo boundaries.
- Source directories.
- Application entry points.
- Internal packages.
- Import aliases.
- Build configuration.
- Generated-code directories.
- Existing test folders.

### Frameworks

Detect frameworks through package manifests, configuration files, source imports, and known project conventions.

### Existing Tests

Detect:

- Test runners.
- Existing test suites.
- Test filenames.
- Test placement conventions.
- Fixtures.
- Mocks.
- Shared setup files.
- Coverage providers.
- Reporter configurations.
- E2E test tools.

### Version Control

Detect:

- Git.
- SVN.
- Mercurial.
- Perforce.
- Nested repositories.
- Projects without version control.

### CI/CD

Detect supported configuration files for:

- GitHub Actions.
- GitLab CI.
- Jenkins.
- Azure Pipelines.
- Other integration plugins.

## 5.4. Smart Init Pipeline

```text
START
  |
Environment Scan
  |
Project Discovery
  |
Framework Detection
  |
Test Runner Detection
  |
Version Control Detection
  |
Existing Test Analysis
  |
Rules & Coverage Discovery
  |
Compatibility Checks
  |
Recommended Setup Plan
  |
User Review
  |
Apply Authorized Changes
  |
Validate Installation
  |
Generate Setup Report
  |
READY
```

## 5.5. Setup Recommendation Engine

The initialization engine should determine:

- Recommended test directory layout.
- Test naming convention.
- Suitable framework adapters.
- Coverage provider.
- Source inclusion patterns.
- Exclusion patterns.
- Initial impact strategy.
- Snapshot configuration.
- Cache location.
- Recommended worker configuration.
- Required optional dependencies.
- Suggested testing rules.

Recommendations must include a reason.

Example:

```text
Detected: NestJS + TypeScript + Jest

Recommended:
  Test layout: Mirror source
  Unit tests: Jest
  Integration tests: Jest
  Source tracking: Git + Native Snapshots
  Impact mode: Balanced
  Coverage: Existing Jest provider
  Cache: Local persistent

Warnings:
  4 modules have no matching tests
  2 configuration files may affect all suites
```

## 5.6. Setup Modes

### Interactive

Guided setup with suggested defaults.

### Automatic

Applies only permitted, low-risk actions.

### Advanced

Exposes all configuration options.

### Non-Interactive

Designed for CI, scripts, and automated environments.

Missing required configuration must produce a deterministic error rather than an interactive prompt.

### Dry Run

Displays the proposed changes without writing files.

## 5.7. Installation Safety

Smart Init must:

- Preserve existing configuration.
- Avoid duplicate script entries.
- Detect naming collisions.
- Preview file modifications.
- Ask before replacing existing files.
- Avoid automatic major dependency upgrades.
- Avoid executing arbitrary installation hooks without appropriate controls.
- Record changes made during setup.
- Support rollback of generated or modified configuration files.

## 5.8. Idempotency

Executing `smarttest init` repeatedly must not create duplicated configuration, scripts, or directories.

Existing user customizations must be retained.

## 5.9. Acceptance Criteria

- Automatic detection works for supported project fixtures.
- Existing tests remain unchanged.
- The generated configuration validates successfully.
- The selected test adapter can discover tests.
- The setup report explains warnings and actions.
- Repeated initialization is idempotent.
- Unsupported configurations produce actionable diagnostics.

---

# 6. Adaptive Configuration Engine

## 6.1. Objective

SmartTest must adapt to changes in the project after initial setup.

A project may begin without version control, adopt Git later, change test frameworks, introduce new packages, or migrate to a monorepo.

SmartTest should identify these changes and propose the necessary updates.

## 6.2. Events to Detect

- New version-control repository.
- Repository removal.
- VCS provider replacement.
- New workspace package.
- Package removal.
- Test framework installation.
- Test framework migration.
- TypeScript configuration changes.
- Import alias changes.
- New source directory.
- New test directory.
- Package manager changes.
- Runtime version changes.
- Coverage configuration changes.
- New supported programming language.
- AI provider configuration changes.

## 6.3. Adaptation Process

1. Detect environment change.
2. Compare with the previous known configuration.
3. Identify affected SmartTest components.
4. Invalidate stale metadata.
5. Build a migration or synchronization plan.
6. Preserve existing user settings.
7. Request approval when modifications are required.
8. Apply changes.
9. Validate the new state.
10. Record the adaptation event.

## 6.4. Commands

```bash
smarttest sync
smarttest sync --check
smarttest sync --vcs
smarttest sync --tests
smarttest sync --frameworks

smarttest doctor
smarttest doctor --fix
smarttest migrate
```

## 6.5. Example: Adding Git After Initialization

Initial state:

```text
Project:
  Version control: None
  Change tracking: Native Snapshots
```

Developer runs:

```bash
git init
```

SmartTest detects Git.

Suggested adaptation:

```text
New version control detected: Git

Recommended actions:
  Connect Git adapter
  Preserve native snapshots
  Establish a new Git baseline
  Reconcile source fingerprints
  Validate existing impact graph
```

SmartTest must not silently assume that old native snapshot identifiers are equivalent to Git commits.

## 6.6. Acceptance Criteria

- Project changes are detected reliably.
- Existing configuration is preserved.
- Invalidated traces are not reused.
- Version-control transitions maintain historical metadata where valid.
- Conflicts are surfaced explicitly.
- Migration is reversible where feasible.

---

# 7. Universal Version Control System

## 7.1. Objective

The impact engine must work independently of the source-control provider.

Supported providers should produce a common normalized representation of changes.

## 7.2. Planned Providers

| Provider         | Support    |
| ---------------- | ---------- |
| Git              | Initial    |
| SmartTest Native | Initial    |
| SVN              | Advanced   |
| Mercurial        | Extension  |
| Perforce         | Extension  |
| Custom VCS       | Plugin SDK |

## 7.3. Common Adapter Contract

```ts
interface VersionControlAdapter {
  readonly id: string;

  detect(root: string): Promise<boolean>;

  getWorkingState(): Promise<WorkingState>;

  getChanges(base: RevisionRef, target?: RevisionRef): Promise<ChangeSet>;

  getFileContent(path: string, revision: RevisionRef): Promise<Uint8Array | null>;

  getCapabilities(): VersionControlCapabilities;
}
```

Each adapter must declare supported capabilities.

Git branches, SVN revisions, and Perforce changelists must not be treated as semantically identical.

## 7.4. Unified ChangeSet

```ts
interface ChangeSet {
  provider: string;

  baseRevision?: string;
  targetRevision?: string;

  changes: FileChange[];

  completeness: "complete" | "partial" | "unknown";

  warnings: string[];
}

interface FileChange {
  path: string;
  previousPath?: string;

  type: "added" | "modified" | "deleted" | "renamed";

  changedRanges?: SourceRange[];

  previousHash?: string;
  currentHash?: string;
}
```

## 7.5. Git Integration

Support:

- Branch comparison.
- Commit comparison.
- Working-tree changes.
- Staged changes.
- Untracked files.
- File renames.
- Deleted files.
- Merge-base calculations.
- Worktrees.
- Monorepos.
- Nested repositories.

Example:

```bash
smarttest run --base main
smarttest run --staged
smarttest run --uncommitted
```

## 7.6. SVN Integration

Support:

- Revision comparisons.
- Working-copy modifications.
- Added files.
- Deleted files.
- Renamed or copied paths where detectable.
- Repository revisions.
- Local working-copy state.

Example:

```bash
smarttest run --vcs svn --base r142
```

## 7.7. Mercurial and Perforce

Provide extension adapters for:

- Changesets.
- Changelists.
- Depot paths.
- Revision comparisons.
- Workspace state.
- Provider-specific configuration.

## 7.8. Multiple VCS Detection

If multiple providers are detected, SmartTest must:

- Identify repository boundaries.
- Determine which source directories belong to each provider.
- Avoid silently mixing unrelated revision references.
- Allow explicit provider selection.
- Support distinct adapters within a monorepo where necessary.

---

# 8. SmartTest Native Snapshot Engine

## 8.1. Objective

Allow intelligent change tracking without Git, SVN, or another VCS.

Native Snapshots are a testing-oriented history system, not a full source-control replacement.

## 8.2. Features

- Initial project baseline.
- Incremental file snapshots.
- Content fingerprints.
- File rename detection.
- Modification history.
- Source comparisons.
- Test-result associations.
- Dependency graph snapshots.
- Snapshot restoration of metadata.
- Retention policies.

## 8.3. Local Storage Structure

```text
.smarttest/
├── state/
│   ├── index.db
│   ├── snapshots/
│   ├── graph/
│   └── fingerprints/
├── traces/
├── cache/
├── runs/
├── reports/
└── logs/
```

Actual storage paths must be configurable.

Generated files should be excluded from source-control commits by default.

## 8.4. Storage Strategy

Prefer:

- Content hashing.
- Incremental indexing.
- Deduplication.
- Compressed metadata.
- Configurable retention.
- Optional source-content storage.

Snapshots must not copy entire repositories unnecessarily.

## 8.5. Hybrid Mode

SmartTest should support:

```text
Git / SVN / Perforce
        +
SmartTest Native Snapshots
        |
Semantic Change Analysis
        |
Impact Graph
        |
Test Selection
```

Native snapshots provide local incremental analysis while external VCS providers supply official repository revisions.

## 8.6. Commands

```bash
smarttest snapshot create
smarttest snapshot list
smarttest snapshot inspect
smarttest snapshot diff
smarttest snapshot prune

smarttest vcs detect
smarttest vcs status
smarttest vcs connect
```

## 8.7. Snapshot Reliability

A source snapshot must be distinguished from a verified testing baseline.

A verified baseline requires associated execution evidence.

Snapshot comparisons must indicate missing or incomplete content.

---

# 9. Source Code Intelligence Engine

## 9.1. Objective

Analyze code at a finer level than files.

SmartTest must understand symbols, references, exports, and dependency relationships.

## 9.2. Supported Symbol Types

- Modules.
- Classes.
- Interfaces.
- Functions.
- Methods.
- Constructors.
- Properties.
- Type declarations.
- Exports.
- Imports.
- Decorators.
- Relevant configuration entities.

## 9.3. Symbol Data Model

```ts
interface SourceSymbol {
  id: string;

  filePath: string;
  qualifiedName: string;

  kind: "module" | "class" | "interface" | "function" | "method" | "property" | "type";

  signature?: string;

  sourceRange: SourceRange;

  parentSymbolId?: string;

  visibility?: "public" | "protected" | "private";

  decorators: string[];

  dependencies: string[];
}
```

## 9.4. Semantic Change Detection

Classify changes such as:

- Comment-only modification.
- Formatting modification.
- Function implementation change.
- Method signature change.
- Exported API change.
- Interface change.
- Inheritance change.
- Decorator change.
- Import change.
- Configuration change.
- Potential behavioral change.
- Unclassifiable change.

Classification must report uncertainty.

## 9.5. Incremental Analysis

Only changed and invalidated portions of the project should be reparsed when possible.

The engine must maintain persistent indexes and update dependent relationships incrementally.

## 9.6. Generated Code

Generated code must be handled separately.

The engine should understand whether generated output must be rebuilt, tested, or excluded based on explicit rules.

---

# 10. Dependency Graph Engine

## 10.1. Objective

Build a graph representing relationships between source code, tests, configuration, and observed execution paths.

## 10.2. Node Types

- Workspace.
- Package.
- Module.
- File.
- Class.
- Function.
- Method.
- Test suite.
- Test case.
- Configuration.
- External dependency.

## 10.3. Edge Types

- IMPORTS.
- EXPORTS.
- CALLS.
- REFERENCES.
- EXTENDS.
- IMPLEMENTS.
- INSTANTIATES.
- DEPENDS_ON.
- TESTS.
- COVERS.
- OBSERVED_EXECUTION.
- CONFIGURES.

## 10.4. Static Dependency Graph

Built through source analysis.

Captures known code relationships.

## 10.5. Dynamic Execution Graph

Built from observed test execution and coverage information.

Captures which source elements were exercised by tests.

## 10.6. Hybrid Graph

Combines static and dynamic information, preserving provenance and confidence.

A relationship observed during execution must not automatically invalidate other potential static relationships.

## 10.7. Reverse Dependency Analysis

Example:

```text
AuthService.validateToken()
          |
          +-- AuthService.test.ts
          |
          +-- AuthController
          |       |
          |       +-- AuthController.test.ts
          |
          +-- AuthenticationMiddleware
                  |
                  +-- ProtectedRoutes.test.ts
```

## 10.8. Graph Requirements

- Persistent indexing.
- Direct dependency traversal.
- Transitive dependency traversal.
- Cycle detection.
- Incremental updates.
- Graph snapshots.
- Symbol lookup.
- Query performance measurements.
- Uncertainty tracking.
- Graph visualization API.

---

# 11. Intelligent Test Impact Engine

## 11.1. Objective

Identify a defensible set of tests relevant to a change.

The selection engine must combine:

- File changes.
- Semantic changes.
- Static dependencies.
- Dynamic execution traces.
- Test-to-source mapping.
- Custom rules.
- Risk levels.
- Cache validity.
- Environment changes.
- Adapter capabilities.

## 11.2. Impact Selection Pipeline

```text
Changed Files
     |
Semantic Diff
     |
Affected Symbols
     |
Static Dependencies
     |
Runtime Execution Traces
     |
Risk and Safety Policies
     |
Candidate Test Set
     |
Confidence and Completeness Check
     |
Final Test Selection
     |
Execution Plan
```

## 11.3. Selection Modes

### FAST

Optimized for local feedback.

Characteristics:

- Highly targeted selection.
- Minimal analysis overhead.
- Cache-first where valid.
- Direct and observed relationships prioritized.
- Clear warnings for unresolved risk.

### BALANCED

Recommended default for pull requests.

Characteristics:

- Static and dynamic analysis.
- Transitive dependency expansion.
- Critical rule enforcement.
- Conservative handling of uncertainty.
- Periodic full-suite validation.

### SAFE

Recommended for releases and critical code.

Characteristics:

- Strict invalidation.
- Mandatory critical tests.
- Broad dependency selection.
- Full-suite execution when required.
- Conservative risk handling.

## 11.4. Mandatory Test Selection

Certain events must trigger broader verification.

Examples:

- Compiler configuration changes.
- Test runner configuration changes.
- Shared authentication changes.
- Global middleware changes.
- Package dependency changes.
- Database schema modifications.
- Shared environment configuration changes.
- Framework upgrades.
- Changes with unresolved dependencies.

## 11.5. Selection Result Model

```ts
interface ImpactDecision {
  selectedTests: SelectedTest[];

  skippedTests: SkippedTest[];

  affectedFiles: string[];

  affectedSymbols: string[];

  analysisStatus: "complete" | "partial" | "fallback";

  safetyMode: "fast" | "balanced" | "safe";

  reasons: SelectionReason[];

  warnings: string[];

  fallbackApplied: boolean;
}
```

## 11.6. Explainability

Every selected test must expose its selection reasons.

Example:

```text
SELECTED: AuthService.test.ts

Reasons:
  Modified symbol: AuthService.validateToken
  Direct dependency relationship
  Previously observed execution coverage
  Matched rule: authentication-critical
```

For skipped tests:

```text
SKIPPED: CatalogService.test.ts

Reasons:
  No detected static dependency
  No valid observed execution overlap
  No mandatory rule matched
  Baseline available

Confidence:
  Limited to the analyzed dependency model
```

## 11.7. Safety Validation

Provide:

```bash
smarttest validate-selection
```

The validation workflow should compare selective execution against a full reference run.

Measure:

- Tests selected.
- Tests skipped.
- Failing tests discovered.
- Failing tests missed.
- Runtime savings.
- Analysis overhead.
- Flaky-test interference.

The product must not guarantee zero missed regressions beyond what its evidence supports.

---

# 12. Runtime Tracing Engine

## 12.1. Objective

Record which source elements are actually exercised by each test.

## 12.2. Supported Granularity

Depending on adapter capabilities:

- Test suite.
- Individual test case.
- Source file.
- Function.
- Method.
- Executed line.
- Executed branch.

## 12.3. Trace Record

```ts
interface TraceRecord {
  testId: string;
  runId: string;

  sourceFingerprint: string;

  environmentFingerprint: string;

  granularity: "suite" | "test" | "file" | "symbol";

  coveredFiles: string[];

  coveredSymbols: string[];

  collectedAt: string;

  valid: boolean;
}
```

## 12.4. Requirements

- Framework-compatible instrumentation.
- Low-overhead collection.
- Explicit granularity reporting.
- Persistent storage.
- Reliable invalidation.
- Source-map support where possible.
- Trace-to-test mapping.
- Safe fallback when trace data is unavailable.

## 12.5. Important Limitation

Individual test-to-method mapping cannot be assumed universally available for every framework and execution mode.

Adapters must declare what they actually support.

If only suite-level tracing is available, SmartTest must select at suite granularity or use additional conservative evidence.

---

# 13. Automatic Test Architecture Generator

## 13.1. Objective

SmartTest should automatically create and maintain a well-organized test architecture derived from the source code.

## 13.2. Example Source Structure

```text
src/
├── modules/
│   ├── auth/
│   │   ├── AuthController.ts
│   │   ├── AuthService.ts
│   │   └── TokenManager.ts
│   └── users/
│       ├── UserController.ts
│       ├── UserService.ts
│       └── UserRepository.ts
└── shared/
    └── validators/
        └── EmailValidator.ts
```

## 13.3. Generated Test Structure

```text
tests/
├── unit/
│   ├── modules/
│   │   ├── auth/
│   │   │   ├── AuthController.test.ts
│   │   │   ├── AuthService.test.ts
│   │   │   └── TokenManager.test.ts
│   │   └── users/
│   │       ├── UserController.test.ts
│   │       ├── UserService.test.ts
│   │       └── UserRepository.test.ts
│   └── shared/
│       └── validators/
│           └── EmailValidator.test.ts
├── integration/
├── e2e/
├── fixtures/
├── mocks/
├── helpers/
└── setup.ts
```

## 13.4. Organization Strategies

### MIRROR

Mirror the source structure.

### COLOCATED

Place tests alongside source files.

### DOMAIN

Group tests by business domain.

### CUSTOM

Use user-defined path and naming templates.

## 13.5. Naming Tokens

Supported template variables should include:

```text
{ClassName}
{FunctionName}
{MethodName}
{FileName}
{ModuleName}
{PackageName}
{DomainName}
{Type}
{Extension}
```

Example:

```text
{ClassName}.{Type}.test.ts
```

## 13.6. Generation Modes

### SCAFFOLD

Create directories and explicit test placeholders.

### ANALYZE

Inspect public behavior, dependencies, and likely scenarios.

### AI GENERATE

Produce meaningful proposed tests using the configured AI provider.

### SYNC

Compare test architecture with the current source layout.

### REFACTOR

Propose a non-destructive reorganization of existing tests.

## 13.7. Commands

```bash
smarttest generate
smarttest generate --mode scaffold
smarttest generate --mode analyze
smarttest generate --sync

smarttest generate --class UserService
smarttest generate --module auth
smarttest generate --type integration

smarttest generate --dry-run
smarttest generate --ai
```

## 13.8. Safety Requirements

The generator must:

- Preserve existing tests.
- Never overwrite by default.
- Detect duplicates.
- Detect naming collisions.
- Support dry-run.
- Use atomic writes.
- Respect custom folder structures.
- Handle renamed files.
- Avoid empty passing tests.
- Generate valid imports where possible.
- Report unresolved dependencies.

Incomplete test skeletons must not count as meaningful test coverage.

## 13.9. Architecture Synchronization

When source code changes, SmartTest should identify:

- Missing test files.
- Orphaned tests.
- Renamed classes.
- Moved modules.
- Newly introduced public methods.
- Changed testing conventions.
- Coverage gaps.

The generator should propose updates rather than silently restructuring user code.

---

# 14. Custom Rules Engine

## 14.1. Objective

Allow developers to define fine-grained test requirements based on source architecture.

## 14.2. Rule Scopes

- Organization.
- Workspace.
- Project.
- Package.
- Module.
- Directory.
- File.
- Class.
- Function.
- Method.
- Individual test.

## 14.3. Supported Selectors

- Path glob.
- Class name.
- Method name.
- Function name.
- Decorator.
- Interface.
- Inheritance.
- Package name.
- Visibility.
- Symbol type.
- Domain.
- Custom annotation.

## 14.4. Rule Types

### Generation Rules

Define test folder layout and templates.

### Coverage Rules

Define required line and branch coverage.

### Execution Rules

Define mandatory tests and execution policies.

### Risk Rules

Classify critical components.

### Quality Rules

Define limits for instability, redundancy, and excessive execution time.

### CI Rules

Define pass/fail quality gates.

## 14.5. Example Configuration

```ts
export default defineConfig({
  rules: [
    {
      name: "service-tests",

      match: {
        class: "*Service",
      },

      require: ["unit"],

      coverage: {
        lines: 90,
        branches: 85,
      },

      generate: {
        template: "service",
      },
    },

    {
      name: "repository-tests",

      match: {
        class: "*Repository",
      },

      require: ["unit", "integration"],

      generate: {
        template: "database",
      },
    },

    {
      name: "authentication-critical",

      match: {
        path: "src/modules/auth/**",
      },

      risk: "critical",

      execution: {
        alwaysRunOnAffected: true,
        mode: "safe",
      },
    },
  ],
});
```

## 14.6. Rule Precedence

Rule evaluation must be deterministic.

Mandatory safeguards cannot be weakened by lower-priority rules.

Conflicting destination paths or incompatible templates must produce an explicit error.

Rule decisions must be inspectable.

## 14.7. Commands

```bash
smarttest rules list
smarttest rules validate

smarttest rules explain \
  src/modules/auth/AuthService.ts
```

---

# 15. Smart Test Execution Engine

## 15.1. Objective

Execute selected tests efficiently through existing test frameworks.

SmartTest should not unnecessarily rebuild the full functionality of Jest, Vitest, Playwright, or Cypress.

## 15.2. Features

- File-level selection.
- Test-case selection where supported.
- Package-level execution.
- Class-targeted execution.
- Full-suite execution.
- Parallel execution.
- Adaptive worker scheduling.
- Timeouts.
- Cancellation.
- Retry policies.
- Safe caching.
- Live output.
- Machine-readable results.

## 15.3. Intelligent Scheduling

The scheduler may consider:

- Historical duration.
- Memory usage.
- Worker availability.
- Resource contention.
- Isolation requirements.
- Test dependencies.
- Previous instability.
- Execution priority.

## 15.4. Cache Requirements

Cache validity must consider relevant inputs, including:

- Source code.
- Test code.
- Dependencies.
- Runtime version.
- Test configuration.
- Relevant environment configuration.
- Fixtures.
- Compiler configuration.
- Adapter version.

Tests dependent on uncontrolled external state should be excluded from caching unless a valid reproducibility contract exists.

## 15.5. Result Statuses

Required statuses:

- Passed.
- Failed.
- Skipped.
- Pending.
- Cancelled.
- Timed out.
- Cached pass.
- Cached failure.
- Flaky.
- Infrastructure error.

A cached result must not appear as a fresh execution.

## 15.6. Flaky Test Detection

Track:

- Historical failures.
- Retry outcomes.
- Failure frequency.
- Execution environment.
- Duration variance.
- Known instability patterns.

A test that fails and later passes on retry must remain visibly marked as unstable.

---

# 16. Coverage Intelligence

## 16.1. Supported Measurements

- Line coverage.
- Statement coverage.
- Branch coverage.
- Function coverage.
- Changed-line coverage.
- Package-level coverage.
- Class-level coverage where supported.
- Critical-domain coverage.

## 16.2. Coverage Types

SmartTest must clearly distinguish:

**Full Coverage:** Coverage from a complete test-suite execution.

**Selected Coverage:** Coverage from the selected subset.

**Diff Coverage:** Coverage of changed lines or branches.

These figures must never be combined or substituted without explanation.

## 16.3. Coverage Gaps

Detect:

- Uncovered methods.
- Uncovered branches.
- Critical code with insufficient tests.
- Changed code without relevant test protection.
- Newly introduced public behavior.
- Tests targeting deleted functionality.
- Missing required test categories.

## 16.4. Quality Gates

Examples:

```text
Changed line coverage >= 90%
Critical branch coverage >= 95%
No untested critical public API changes
No required integration tests missing
```

Thresholds must be configurable.

## 16.5. Commands

```bash
smarttest coverage
smarttest coverage --changed
smarttest coverage --explain

smarttest generate --missing-coverage
```

## 16.6. Coverage Quality Principle

High execution coverage does not automatically imply strong assertions.

Coverage quality should also be evaluated through behavioral tests, edge-case analysis, and optional mutation testing.

---

# 17. SmartTest AI — Universal AI Testing Assistant

## 17.1. Objective

Provide an optional AI engineering assistant that can understand project structure, generate tests, analyze coverage, explain failures, suggest improvements, and maintain test quality.

The AI system must use SmartTest's existing project indexes and impact graph to minimize unnecessary context and repeated analysis.

## 17.2. Architecture

```text
SmartTest AI CLI / Studio
             |
       AI Task Manager
             |
        Context Builder
             |
   Provider Abstraction Layer
             |
    Model Discovery & Routing
             |
       AI Model Endpoint
             |
      Structured Proposal
             |
   Validation & Safety Engine
             |
     Review / Apply Changes
```

## 17.3. AI Must Remain Optional

All deterministic source analysis, test selection, rule evaluation, and execution must work with AI disabled.

AI must not become a required dependency for the core engine.

---

# 18. AI Provider Setup and Model Discovery

## 18.1. Main Commands

```bash
smarttest ai setup
smarttest --ai setup

smarttest ai providers list
smarttest ai providers add
smarttest ai providers remove

smarttest ai models
smarttest ai models --refresh

smarttest ai test-connection
smarttest ai config
```

## 18.2. Interactive Setup Flow

The user provides:

1. Provider type.
2. API base URL.
3. API key if required.
4. Preferred model.

SmartTest should automatically:

- Normalize the URL.
- Test connectivity.
- Validate authentication.
- Attempt model discovery.
- Display available models.
- Detect supported API capabilities.
- Allow manual model entry.
- Validate a selected model.
- Store credentials securely.
- Save non-sensitive configuration.

## 18.3. Supported Provider Types

- OpenAI-compatible APIs.
- OpenAI native adapter.
- Anthropic native adapter.
- DeepSeek-compatible endpoints.
- Ollama.
- LM Studio.
- vLLM.
- LiteLLM.
- Other custom providers through plugins.

## 18.4. Model Discovery

For compatible APIs, SmartTest should attempt:

```http
GET {baseURL}/models
Authorization: Bearer <API_KEY>
```

The base URL must be normalized carefully to avoid duplicated API prefixes.

When model discovery is unavailable:

- Explain the failure.
- Allow manual model selection.
- Support custom model IDs.
- Perform optional capability probes.

## 18.5. Capability Detection

Where supported, determine:

- Text generation.
- Structured JSON output.
- Streaming.
- Tool calling.
- Context limits.
- Maximum output limits.
- Reasoning-related controls.
- Token usage reporting.

Capability detection must not assume that all OpenAI-compatible servers implement identical parameters.

Unknown capabilities must remain explicitly unknown.

## 18.6. Multiple AI Profiles

Support multiple provider configurations.

Example:

```text
Profiles:

default
  Provider: Custom API
  Model: coding-model

fast
  Provider: Local Ollama
  Model: lightweight-model

review
  Provider: Remote API
  Model: reasoning-model
```

## 18.7. Model Routing

Allow models to be assigned to different tasks:

- Planning.
- Generation.
- Repair.
- Explanation.
- Coverage audit.
- Code review.
- Refactoring.

## 18.8. Credential Security

Requirements:

- Never store keys directly in shared project configuration.
- Prefer operating-system secure credential storage.
- Support environment variables.
- Hide credentials in logs.
- Never include keys in reports.
- Require HTTPS for non-local remote endpoints by default.
- Protect against accidental source-code disclosure.

## 18.9. Usage Budgets

Support:

- Request limits.
- Token limits.
- Estimated cost limits.
- Per-task limits.
- Per-provider limits.
- Explicit approval for large jobs.

If reliable pricing information is unavailable, SmartTest must not present an estimated cost as guaranteed.

---

# 19. AI Command System

## 19.1. CLI Design

Primary syntax:

```bash
smarttest ai <command>
```

Compatibility alias:

```bash
smarttest --ai <command>
```

Optional enhancement syntax:

```bash
smarttest generate --ai
smarttest coverage --ai
smarttest run --ai
```

The CLI parser must define these behaviors consistently and avoid ambiguous command combinations.

## 19.2. AI Command Catalog

| Command             | Responsibility                        |
| ------------------- | ------------------------------------- |
| `ai setup`          | Configure a provider                  |
| `ai models`         | Discover and select models            |
| `ai generate-tests` | Generate tests                        |
| `ai audit`          | Audit overall test quality            |
| `ai gaps`           | Identify missing scenarios            |
| `ai coverage`       | Analyze coverage weaknesses           |
| `ai fix`            | Propose test repairs                  |
| `ai improve`        | Improve existing tests                |
| `ai explain`        | Explain failures                      |
| `ai review`         | Review code changes and tests         |
| `ai mutation`       | Suggest or analyze mutation tests     |
| `ai mocks`          | Generate mocks                        |
| `ai fixtures`       | Generate fixtures                     |
| `ai edge-cases`     | Discover boundary conditions          |
| `ai refactor`       | Refactor tests                        |
| `ai rules`          | Suggest testing rules                 |
| `ai optimize`       | Identify expensive or redundant tests |
| `ai plan`           | Create a testing strategy             |
| `ai doctor`         | Diagnose setup and testing issues     |

---

# 20. AI Test Generation Engine

## 20.1. Objective

Generate meaningful tests for selected source files, modules, classes, methods, or complete repositories.

## 20.2. Targeting Commands

```bash
smarttest ai generate-tests

smarttest ai generate-tests --module auth

smarttest ai generate-tests --class AuthService

smarttest ai generate-tests \
  --method AuthService.login

smarttest ai generate-tests \
  --path src/modules/users

smarttest ai generate-tests --changed

smarttest ai generate-tests --missing

smarttest ai generate-tests --all
```

## 20.3. Generation Pipeline

### Step 1 — Analyze

Collect:

- Target source symbols.
- Method signatures.
- Public behavior.
- Dependencies.
- Existing tests.
- Project conventions.
- Rules.
- Coverage.
- Relevant execution history.

### Step 2 — Plan

Build a testing plan containing:

- Happy paths.
- Error cases.
- Boundary cases.
- Invalid inputs.
- Exception behavior.
- State transitions.
- Security-sensitive behavior.
- Integration cases.

### Step 3 — Generate

Produce:

- Test code.
- Imports.
- Mocks.
- Fixtures.
- Setup and teardown code.
- Assertions.
- Test metadata.

### Step 4 — Validate

Check:

- Syntax.
- Type compatibility.
- Compilation.
- Test execution.
- Assertion quality.
- Relevant coverage.
- Obvious false-positive patterns.

### Step 5 — Improve

Revise invalid or weak tests within a configured retry and cost budget.

### Step 6 — Review

Display proposed changes and validation evidence.

### Step 7 — Apply

Write only explicitly approved changes.

## 20.4. Full Project Generation

`--all` must not attempt to place the entire repository into one model prompt.

Instead:

1. Analyze the complete source index.
2. Build a dependency-aware work plan.
3. Split work into modules or symbols.
4. Estimate requests and resource usage.
5. Obtain approval.
6. Generate in bounded batches.
7. Validate each batch.
8. Store resumable checkpoints.
9. Produce a consolidated report.

## 20.5. Non-Destructive Behavior

Default behavior must be:

```text
Analyze
  -> Propose
  -> Generate Draft
  -> Validate
  -> Review
  -> Apply
```

Automatic application must be an explicit opt-in.

## 20.6. Generated Test Quality

Tests should not be considered valid merely because they pass.

SmartTest should detect suspicious patterns such as:

- Assertions that always pass.
- Tests that do not invoke target behavior.
- Empty test bodies.
- Excessive mocking of the subject under test.
- Assertions unrelated to expected behavior.
- Duplicate scenarios.
- Skipped or disabled generated tests.

---

# 21. AI Coverage Audit and Gap Detection

## 21.1. Commands

```bash
smarttest ai audit

smarttest ai audit --coverage

smarttest ai gaps

smarttest ai gaps --module auth

smarttest ai coverage --changed
```

## 21.2. Audit Dimensions

- Line coverage.
- Branch coverage.
- Function coverage.
- Changed-code coverage.
- Behavioral scenarios.
- Boundary conditions.
- Assertion quality.
- Critical-path protection.
- Mutation-test results where available.
- Test stability.

## 21.3. Findings

Each finding should contain:

- Affected source symbol.
- Problem description.
- Evidence.
- Severity.
- Confidence.
- Related existing tests.
- Recommended action.
- Optional generated test proposal.

## 21.4. Example

```text
AI COVERAGE AUDIT

Module: Authentication

Line Coverage:   87%
Branch Coverage: 63%

Potential gaps:
  [HIGH] Expired token behavior
  [HIGH] Password validation boundaries
  [MED]  Database connection failure
  [LOW]  Optional parameter behavior

Suggested:
  6 additional test scenarios
```

Coverage findings must be supported by verifiable source or test evidence rather than unsupported model guesses.

---

# 22. AI Test Repair, Improvement, and Review

## 22.1. AI Fix

```bash
smarttest ai fix --failed
```

SmartTest should analyze failures and distinguish between:

- Real regressions.
- Outdated test expectations.
- Broken mocks.
- Fixture errors.
- Dependency changes.
- Environment issues.
- Flaky behavior.

The assistant must not automatically modify assertions simply to make a failing test pass.

## 22.2. AI Improve

```bash
smarttest ai improve --module auth
```

Suggested improvements may include:

- Stronger assertions.
- Better isolation.
- Reduced duplication.
- More relevant test inputs.
- Additional boundary scenarios.
- Clearer test descriptions.
- Improved fixture reuse.

## 22.3. AI Review

```bash
smarttest ai review --base main
```

Review:

- Changed code.
- Affected dependencies.
- Selected tests.
- Coverage.
- Unverified behaviors.
- Missing tests.
- Critical risk.

Output should be suitable for:

- CLI.
- HTML report.
- SmartTest Studio.
- Pull request summaries.

## 22.4. AI Mutation Assistance

The AI may recommend mutation-testing targets or interpret mutation results.

Mutation execution should rely on a compatible mutation-testing engine rather than model-generated assumptions.

---

# 23. SmartTest Autopilot

## 23.1. Objective

Provide a unified workflow for project testing intelligence.

Command:

```bash
smarttest autopilot
```

## 23.2. Workflow

```text
Project Audit
     |
Detect Changes
     |
Update Dependency Graph
     |
Identify Affected Tests
     |
Check Coverage Gaps
     |
Generate Improvement Plan
     |
Optional AI Test Generation
     |
Validate Proposed Tests
     |
Execute Approved Tests
     |
Generate Final Report
```

## 23.3. Default Mode

Autopilot must operate in planning and review mode by default.

It must not silently:

- Modify source code.
- Overwrite tests.
- Install dependencies.
- Execute arbitrary generated scripts.
- Send source code to remote providers.
- Spend AI credits.
- Modify CI configuration.

## 23.4. Commands

```bash
smarttest autopilot

smarttest autopilot --plan

smarttest autopilot --changed

smarttest autopilot --module auth

smarttest autopilot --non-interactive
```

More autonomous behavior should require explicit policies describing permitted actions and limits.

---

# 24. SmartTest Studio — Interactive GUI

## 24.1. Vision

SmartTest Studio should deliver an interactive testing experience comparable in usability to tools such as Cypress, but covering a broader range of testing activities.

The Studio must support unit, integration, and E2E workflows through their respective adapters.

## 24.2. Launch

```bash
smarttest open
```

Or:

```bash
smarttest studio
```

The CLI starts a local server and opens the Studio in the default browser.

## 24.3. Initial Architecture

Use a local web application rather than requiring Electron from the beginning.

```text
React Studio
     |
Local HTTP API + WebSocket
     |
SmartTest Core
     |
Test Framework Adapters
     |
Project Source / Tests
```

A native desktop wrapper may be introduced later.

## 24.4. Primary Navigation

The Studio should contain:

1. Overview.
2. Test Explorer.
3. Impact Map.
4. Test Builder.
5. Live Runner.
6. Coverage.
7. Reports.
8. AI Assistant.
9. Rules.
10. Settings.

## 24.5. Overview

Display:

- Project health.
- Current branch or revision.
- Last test execution.
- Test totals.
- Passed and failed tests.
- Changed files.
- Coverage.
- Time saved.
- Active warnings.
- Missing test protection.

## 24.6. Test Explorer

Tree structure:

```text
Workspace
  Package
    Module
      Class
        Test Suite
          Test Case
```

Features:

- Search.
- Filters.
- Tags.
- Test selection.
- Individual execution.
- Multi-selection.
- Test history.
- Direct source navigation.
- Status indicators.
- Test duration.
- Coverage information.

## 24.7. Impact Map

Interactive dependency graph displaying:

- Changed symbols.
- Affected files.
- Transitive dependencies.
- Related tests.
- Selected tests.
- Skipped tests.
- Risk levels.

Interactions:

- Zoom and pan.
- Node inspection.
- Dependency path highlighting.
- Filtering.
- Search.
- Export.
- Source navigation.

## 24.8. Test Builder

Allow users to:

- Select a class.
- Inspect its methods.
- Select scenarios.
- Configure test categories.
- Configure mocks and fixtures.
- Choose test file destinations.
- Generate scaffolds.
- Generate tests with AI.
- Review generated code.
- Validate proposed tests.

The Test Builder should work without AI for structural generation.

## 24.9. Live Runner

Provide real-time execution views:

- Running tests.
- Progress.
- Logs.
- Failures.
- Stack traces.
- Execution duration.
- Worker activity.
- Retries.
- Cancellation.
- Watch mode.

For supported browser-testing adapters, additional capabilities may include:

- Browser preview.
- DOM inspection.
- Screenshots.
- Interaction recording.
- Browser traces.
- Test-step inspection.

Browser time-travel functionality must only be offered when the underlying framework or recording mechanism actually supports it.

## 24.10. Coverage Viewer

Display annotated source code:

- Covered lines.
- Uncovered lines.
- Changed lines.
- Uncovered branches.
- Associated tests.
- Coverage history.
- AI recommendations.

## 24.11. Rules Editor

Provide a visual interface for configuring rules by:

- Package.
- Module.
- Class.
- Method.
- Risk.
- Test category.
- Coverage threshold.

Rules must remain editable as code or structured configuration.

## 24.12. AI Assistant Panel

Support:

- Project questions.
- Test generation.
- Coverage audits.
- Test repair suggestions.
- Explanation of failures.
- Missing scenario detection.
- Testing plans.

The GUI must display which provider and model are being used and whether remote source access is enabled.

## 24.13. Studio UX Requirements

- Modern professional interface.
- Light and dark themes.
- Fast navigation.
- Keyboard shortcuts.
- Compact but readable tables.
- Clear status hierarchy.
- Responsive layouts.
- Accessible controls.
- Live updates.
- Non-blocking interactions.
- Explicit progress for long-running operations.
- Preservation of UI state during navigation.

## 24.14. Local Studio Security

The local server must:

- Bind to loopback by default.
- Use authenticated local sessions or equivalent protection.
- Validate origin and request authorization.
- Protect file modification and command execution endpoints.
- Avoid exposing secrets.
- Avoid rendering untrusted repository content as executable HTML.
- Restrict access to configured project roots.

---

# 25. Reporting Engine

## 25.1. Objective

Produce attractive, useful, and technically accurate reports.

## 25.2. Export Formats

- HTML.
- JSON.
- JUnit XML.
- LCOV.
- Cobertura where supported.
- SARIF for applicable diagnostics.
- Markdown summaries.
- CI-specific outputs.

## 25.3. Report Sections

### Executive Summary

- Overall result.
- Tests selected.
- Tests executed.
- Tests skipped.
- Tests cached.
- Tests passed.
- Tests failed.
- Tests flaky.
- Total duration.

### Change Analysis

- Modified files.
- Modified symbols.
- Dependency impact.
- Risk classification.
- Analysis completeness.

### Test Selection

- Selected tests.
- Skipped tests.
- Selection reasons.
- Mandatory rule matches.
- Safety fallbacks.

### Coverage

- Full-suite baseline coverage.
- Selected-run coverage.
- Diff coverage.
- Missing critical protection.

### Performance

- Analysis overhead.
- Test execution time.
- Cache savings.
- Worker utilization.
- Historical comparisons.

### AI Findings

When AI is enabled:

- Suggested tests.
- Quality warnings.
- Coverage gaps.
- Repair proposals.
- Validation status.

## 25.4. Report Integrity

Reports must never imply:

- Skipped tests passed.
- Cached results were freshly executed.
- AI-generated tests were validated if they were not.
- Partial coverage represents full-project coverage.
- An incomplete impact graph provides exhaustive certainty.

---

# 26. CLI Developer Experience

## 26.1. Main UX Principle

The CLI must be intuitive for beginners and fully scriptable for advanced users.

Three interaction patterns:

**Interactive:** Guided menus and intelligent defaults.

**Direct:** Explicit commands and options.

**Automation:** Stable non-interactive behavior and machine-readable output.

## 26.2. Main Commands

```bash
smarttest
smarttest init
smarttest doctor
smarttest sync

smarttest scan
smarttest impact
smarttest explain
smarttest graph

smarttest run
smarttest run --affected
smarttest run --all

smarttest watch

smarttest generate
smarttest coverage
smarttest report

smarttest rules
smarttest snapshot
smarttest vcs

smarttest ai
smarttest autopilot

smarttest studio
```

## 26.3. Interactive Root Command

Running:

```bash
smarttest
```

Should display an interactive menu.

Example:

```text
SMARTTEST

Workspace: my-project
Status: Ready

> Run affected tests
  Open SmartTest Studio
  Generate test architecture
  AI Test Assistant
  Coverage and reports
  Project diagnostics
  Settings

↑↓ Navigate   Enter Select   / Search
```

## 26.4. Common Flags

Where relevant:

```text
--dry-run
--json
--quiet
--verbose
--non-interactive
--output
--config
--workspace
--profile
--help
```

## 26.5. CLI Output Requirements

- Clear progress.
- Compact summaries.
- Structured diagnostics.
- Stable exit codes.
- Colored output when supported.
- Proper non-TTY behavior.
- Searchable interactive lists.
- Keyboard navigation.
- Helpful error messages.
- No unnecessary prompts.
- No hidden destructive operations.

## 26.6. Exit Codes

Define stable categories for:

- Success.
- Test failure.
- Configuration failure.
- Infrastructure failure.
- Safety or policy failure.
- Invalid command usage.

The exact numeric mapping should be documented and versioned.

---

# 27. Plugin SDK and Multi-Language Support

## 27.1. Objective

Allow SmartTest to expand without rebuilding its core.

## 27.2. Plugin Categories

- Language adapters.
- Test runner adapters.
- Coverage providers.
- Version-control adapters.
- Framework detectors.
- Test generators.
- Reporter exporters.
- CI integrations.
- AI providers.
- Rules extensions.

## 27.3. Test Runner Adapter

```ts
interface TestAdapter {
  id: string;

  discover(): Promise<TestCase[]>;

  execute(selection: TestSelection, options: ExecutionOptions): Promise<TestRunResult>;

  collectCoverage?(): Promise<CoverageArtifact>;

  getCapabilities(): TestAdapterCapabilities;
}
```

## 27.4. Language Adapter

```ts
interface LanguageAdapter {
  language: string;

  analyze(files: string[]): Promise<SymbolGraph>;

  findTestTargets(symbol: SourceSymbol): Promise<TestTarget[]>;
}
```

## 27.5. Adapter Capabilities

Adapters must declare:

- Test discovery support.
- File-level selection.
- Test-case selection.
- Coverage support.
- Tracing support.
- Parallel execution.
- Cancellation.
- Retry support.
- Source-map support.

Unsupported capabilities must not be silently emulated inaccurately.

## 27.6. Language Expansion

### JavaScript / TypeScript

Initial implementation.

### Python

pytest adapter and Python source analysis.

### Java

JUnit integration and Java source analysis.

### Go

go test integration and Go source analysis.

### Additional Languages

C#, PHP, Rust, Kotlin, and others based on demand.

## 27.7. Cross-Language Analysis

Future versions should support dependencies across languages and service boundaries.

Examples:

- TypeScript API calling Python service.
- Frontend consuming generated API contracts.
- Java application relying on shared schemas.

Cross-language relationships must be based on detectable contracts, configuration, or explicitly declared mappings.

---

# 28. SmartTest Cloud — Commercial Platform

## 28.1. Objective

Provide paid collaboration and organization-wide intelligence while keeping the local core valuable and accessible.

## 28.2. Cloud Features

### Project Management

- Organizations.
- Workspaces.
- Projects.
- Repositories.
- Members.
- Roles.

### Test Analytics

- Execution history.
- Failure trends.
- Coverage trends.
- Flaky tests.
- CI duration trends.
- Test efficiency.
- Historical comparisons.

### Pull Request Intelligence

- Change impact summaries.
- Selected test reports.
- Missing test warnings.
- Quality gates.
- Risk scores.
- PR comments.

### Shared Execution Infrastructure

- Shared metadata cache.
- Remote execution cache.
- Distributed execution as a future capability.
- Usage monitoring.

### AI Collaboration

- Shared AI review reports.
- Organization-wide testing recommendations.
- Centralized provider policies.
- Configurable usage budgets.

## 28.3. Organization Data Model

```text
Organization
├── Members
├── Roles
├── Policies
├── Subscriptions
└── Workspaces
    └── Projects
        └── Repositories
            └── Branches
                └── Commits
                    └── TestRuns
                        ├── TestExecutions
                        ├── CoverageSnapshots
                        ├── ImpactDecisions
                        └── Reports
```

## 28.4. Example API

```http
POST /v1/runs

GET /v1/runs/:id

GET /v1/projects/:id/metrics

GET /v1/projects/:id/coverage

GET /v1/projects/:id/impact

GET /v1/projects/:id/flaky-tests

POST /v1/impact/analyze

POST /v1/reports

GET /v1/organizations/:id/usage
```

## 28.5. Enterprise Capabilities

- Single Sign-On.
- Advanced RBAC.
- Audit logs.
- Private deployment.
- Self-hosting options.
- Configurable retention.
- Data residency.
- Security policies.
- Compliance support.
- Dedicated support.
- Custom integrations.

## 28.6. Data Minimization

Cloud operation should prefer:

- Hashes.
- Test identifiers.
- Source identifiers.
- Metrics.
- Statuses.
- Coverage metadata.
- Impact decisions.

Uploading full source code should not be required for standard reporting features.

---

# 29. Business Model and Monetization

## 29.1. Strategy

Use an **Open Core + SaaS** model.

The open-source engine creates adoption and developer trust.

The commercial service monetizes collaboration, organization-wide analytics, and advanced infrastructure.

## 29.2. Proposed Pricing

| Plan       | Proposed Price      | Target                    |
| ---------- | ------------------- | ------------------------- |
| Community  | Free                | Individual developers     |
| Team       | $12/developer/month | Small teams               |
| Business   | $29/developer/month | Engineering organizations |
| Enterprise | Custom              | Large companies           |

Pricing is an initial commercial hypothesis and must be validated with customers.

## 29.3. Community Edition

Include:

- Smart Init.
- Git support.
- Native Snapshots.
- Core impact analysis.
- Local selective execution.
- Automatic test architecture.
- Custom rules.
- Basic coverage.
- Local reporting.
- Local Studio.
- Basic framework adapters.
- User-provided AI integration where sustainable.

## 29.4. Team Edition

Include:

- Shared dashboards.
- Historical reports.
- CI analytics.
- Pull request integration.
- Shared cache.
- Team-level insights.
- Flaky-test monitoring.
- Collaboration.

## 29.5. Business Edition

Include:

- Multi-repository analytics.
- Centralized policies.
- Advanced governance.
- Organization-wide quality insights.
- Cost analytics.
- Advanced AI workflows.
- Extended history.
- Private integration options.

## 29.6. Enterprise Edition

Include:

- Private deployments.
- Custom security controls.
- SSO.
- Advanced auditability.
- Contractual support.
- Custom integrations.
- Organization-specific operational requirements.

## 29.7. Commercial Value

SmartTest should sell measurable improvements:

- Faster CI pipelines.
- Reduced compute consumption.
- Reduced developer waiting time.
- Improved test maintainability.
- Better visibility into regressions.
- More reliable release processes.

## 29.8. Go-to-Market

Primary channels:

- npm.
- GitHub.
- Technical documentation.
- Developer communities.
- Public benchmarks.
- CI integration templates.
- Tutorial videos.
- Engineering blogs.
- Open-source contributors.
- Framework ecosystem partnerships.

## 29.9. Adoption Strategy

1. Publish a genuinely useful free CLI.
2. Demonstrate reliable savings on representative repositories.
3. Make installation exceptionally simple.
4. Offer impressive local reports and Studio.
5. Encourage CI adoption.
6. Introduce commercial team features.
7. Expand to additional language ecosystems.

---

# 30. Security and Privacy

## 30.1. General Requirements

SmartTest operates on developer repositories and may execute arbitrary project tests.

It must therefore assume repository content, plugins, test results, and generated code can be untrusted.

## 30.2. Local Security

- Minimal permissions.
- No mandatory telemetry.
- No automatic source upload.
- Safe filesystem handling.
- Path traversal protection.
- Atomic file updates.
- Explicit authorization for modifications.
- Clear execution boundaries.
- Secure temporary files.
- Secret redaction.
- Controlled plugin execution.

## 30.3. AI Security

- Explicit provider connection.
- Explicit remote-source access approval.
- Secure credential storage.
- Secret detection and redaction.
- Context minimization.
- Protection against prompt injection.
- No unreviewed application of generated code by default.
- Controlled execution of generated tests.
- Provider-specific privacy disclosures.
- Usage limits.

## 30.4. Studio Security

- Loopback binding by default.
- Request authentication or equivalent local access controls.
- Origin verification.
- CSRF protection where applicable.
- Safe rendering of source files and logs.
- Restricted filesystem access.
- Protected execution endpoints.

## 30.5. Cloud Security

- Tenant isolation.
- Encryption in transit.
- Encryption at rest.
- RBAC.
- Secure tokens.
- Audit logging.
- Retention controls.
- Data deletion.
- Rate limiting.
- Backup and recovery.
- Security monitoring.

## 30.6. Supply Chain Security

- Secure npm publishing.
- Package provenance where available.
- Dependency vulnerability checks.
- SBOM generation.
- Signed releases where feasible.
- CI workflow hardening.
- Secret scanning.
- Reproducible build practices.

---

# 31. Performance Requirements

## 31.1. Philosophy

Performance is a core product feature.

SmartTest must measure its own overhead and avoid expensive analysis when the expected benefit is smaller than the cost.

## 31.2. Optimization Techniques

- Incremental parsing.
- Persistent symbol indexes.
- Persistent dependency graphs.
- Content-addressed caching.
- Lazy analysis.
- Worker pools.
- Adaptive concurrency.
- Batch graph updates.
- Efficient filesystem scanning.
- Query optimization.
- Test duration-aware scheduling.
- Controlled memory usage.

## 31.3. Initial Performance Targets

Targets must be evaluated under explicitly defined benchmark conditions.

| Operation                             | Initial Target           |
| ------------------------------------- | ------------------------ |
| Warm CLI startup                      | Under 300 ms             |
| Simple diff analysis with warm index  | Under 500 ms             |
| Warm graph selection                  | Under 200 ms             |
| Standard report generation            | Under 2 seconds          |
| Small-project overhead                | Below 10% where feasible |
| End-to-end savings on suitable suites | Target 30–80%            |

These are aspirational engineering targets, not guaranteed results.

## 31.4. Performance Observability

Measure:

- Initialization duration.
- Source scanning duration.
- Parsing duration.
- Graph update duration.
- Impact calculation duration.
- Test discovery duration.
- Test execution duration.
- Coverage collection duration.
- Report generation duration.
- Peak memory.
- Cache hit rate.
- Overall time saved.

## 31.5. Adaptive Performance Policy

If selective execution is slower than a full run for a specific workload, SmartTest should recommend or automatically use an appropriate fallback within the configured policy.

---

# 32. Reliability and Correctness

## 32.1. Reliability Goals

- Deterministic analysis where possible.
- Stable adapter behavior.
- Graceful failure handling.
- Cache integrity.
- Reproducible decisions.
- Correct test statuses.
- Safe fallback.
- Cross-platform compatibility.

## 32.2. Critical Correctness Rules

SmartTest must never:

- Label skipped tests as passed.
- Treat unknown dependencies as definitely unrelated.
- Present partial coverage as global coverage.
- Claim AI-generated tests are verified without running validation.
- Reuse invalid cached results.
- Ignore critical configuration changes without warning.
- Suppress test failures to improve reported performance.

## 32.3. Testing Strategy

SmartTest itself requires:

- Unit tests.
- Integration tests.
- E2E tests.
- Adapter compatibility tests.
- Mutation-testing experiments.
- Benchmark suites.
- Regression fixtures.
- Security tests.
- Snapshot integrity tests.

## 32.4. Shadow Mode

Provide a validation mode that executes both:

- SmartTest-selected tests.
- The full reference suite.

Compare the outcomes to detect incorrect exclusions.

Shadow Mode should be a key feature during early adoption and on customer pilot repositories.

---

# 33. Metrics and KPIs

## 33.1. Technical KPIs

- Total execution time saved.
- Percentage of tests selected.
- Percentage of tests skipped.
- Analysis overhead.
- Cache hit rate.
- Graph update performance.
- Memory usage.
- Adapter compatibility rate.

## 33.2. Correctness KPIs

- Missed reproducible failures.
- False-negative selection rate.
- Invalid trace frequency.
- Fallback frequency.
- Unknown dependency count.
- Full-suite comparison outcomes.
- Selection explanation completeness.

## 33.3. Test Quality KPIs

- Changed-code coverage.
- Branch coverage.
- Critical-path coverage.
- Missing test scenarios.
- Valid generated tests.
- Flaky-test frequency.
- Mutation score where measured.

## 33.4. Developer Experience KPIs

- Setup success rate.
- Time to first meaningful run.
- Installation friction.
- Number of manual configuration steps.
- Studio usage.
- Watch mode adoption.
- Report engagement.

## 33.5. Commercial KPIs

- npm installations.
- Active repositories.
- Active organizations.
- Cloud conversion rate.
- Paying seats.
- MRR.
- ARR.
- Churn.
- Average revenue per organization.
- Infrastructure cost per customer.
- Gross margin.

---

# 34. Engineering Backlog

> For v1.0.0 these spec items are decomposed into user stories in [`../planning/foundation/epics/`](../planning/foundation/epics/README.md).

## Epic A — Core Project Foundation

- A01 — Initialize the TypeScript monorepo.
- A02 — Define package boundaries.
- A03 — Implement core configuration contracts.
- A04 — Configure linting, formatting, and strict typing.
- A05 — Create testing fixtures.
- A06 — Establish CI.
- A07 — Implement structured logging.
- A08 — Implement stable error handling.
- A09 — Create the Plugin SDK foundation.
- A10 — Publish architecture documentation.

**Acceptance Gate:** Core packages build and test independently.

## Epic B — Smart Init

- B01 — Runtime detection.
- B02 — Package manager detection.
- B03 — Framework detection.
- B04 — Test runner detection.
- B05 — Source layout analysis.
- B06 — Existing test discovery.
- B07 — VCS detection.
- B08 — Coverage provider detection.
- B09 — Setup recommendation engine.
- B10 — Interactive setup wizard.
- B11 — Dry-run and preview.
- B12 — Safe configuration writing.
- B13 — Setup validation.
- B14 — Idempotency tests.
- B15 — Rollback support.

**Acceptance Gate:** Supported repositories can be initialized safely with minimal manual configuration.

## Epic C — Adaptive Configuration

- C01 — Environment fingerprinting.
- C02 — Configuration change detection.
- C03 — Framework migration detection.
- C04 — New package discovery.
- C05 — VCS transition detection.
- C06 — Metadata invalidation.
- C07 — Synchronization planning.
- C08 — Configuration reconciliation.
- C09 — Migration diagnostics.
- C10 — Non-destructive adaptation.

**Acceptance Gate:** Existing test architecture and valid history survive supported project changes.

## Epic D — Version Control and Snapshots

- D01 — Define the VCS adapter contract.
- D02 — Implement Git detection.
- D03 — Implement Git diff handling.
- D04 — Support staged and uncommitted changes.
- D05 — Handle renames and deletions.
- D06 — Implement Native Snapshots.
- D07 — Implement incremental fingerprinting.
- D08 — Implement snapshot comparison.
- D09 — Implement hybrid VCS mode.
- D10 — Implement SVN adapter.
- D11 — Implement Mercurial adapter.
- D12 — Implement Perforce adapter.
- D13 — Support custom VCS plugins.
- D14 — Implement snapshot retention.

**Acceptance Gate:** All adapters produce consistent normalized changes within their declared capabilities.

## Epic E — Source Intelligence

- E01 — TypeScript parser.
- E02 — JavaScript parser.
- E03 — Symbol indexing.
- E04 — Import resolution.
- E05 — Class and method analysis.
- E06 — Export analysis.
- E07 — Semantic diff.
- E08 — Incremental parsing.
- E09 — Source-map handling.
- E10 — Generated-code policies.

**Acceptance Gate:** Known source fixtures produce expected symbols and relationships.

## Epic F — Dependency Graph

- F01 — Graph node model.
- F02 — Graph edge model.
- F03 — Persistent storage.
- F04 — Reverse dependency traversal.
- F05 — Transitive analysis.
- F06 — Cycle handling.
- F07 — Incremental updates.
- F08 — Uncertainty metadata.
- F09 — Graph snapshots.
- F10 — Graph query API.

**Acceptance Gate:** Dependency queries are reproducible and benchmarked.

## Epic G — Impact Engine

- G01 — Direct test selection.
- G02 — Transitive test selection.
- G03 — Runtime trace integration.
- G04 — Risk classification.
- G05 — Mandatory test policies.
- G06 — FAST mode.
- G07 — BALANCED mode.
- G08 — SAFE mode.
- G09 — Safe fallback.
- G10 — Selection explanation.
- G11 — Shadow Mode.
- G12 — Full-suite comparison.

**Acceptance Gate:** No known reproducible failing test is missed in the defined validation fixtures.

## Epic H — Test Architecture Generator

- H01 — Mirror layout.
- H02 — Colocated layout.
- H03 — Domain layout.
- H04 — Custom layout.
- H05 — Naming templates.
- H06 — Class-specific templates.
- H07 — Module-specific templates.
- H08 — Unit scaffolding.
- H09 — Integration scaffolding.
- H10 — Existing test detection.
- H11 — Duplicate prevention.
- H12 — Dry-run.
- H13 — Rename handling.
- H14 — Architecture synchronization.
- H15 — Non-destructive migration preview.

**Acceptance Gate:** Generation is repeatable and does not overwrite user content by default.

## Epic I — Rules Engine

- I01 — Global rules.
- I02 — Package rules.
- I03 — Module rules.
- I04 — Class rules.
- I05 — Method rules.
- I06 — Decorator selectors.
- I07 — Coverage requirements.
- I08 — Criticality policies.
- I09 — Execution policies.
- I10 — Rule conflict resolution.
- I11 — Rule explanation.
- I12 — Configuration validation.

**Acceptance Gate:** Rule evaluation is deterministic and explainable.

## Epic J — Test Execution and Cache

- J01 — Vitest adapter.
- J02 — Jest adapter.
- J03 — Test discovery normalization.
- J04 — Test execution normalization.
- J05 — Parallel scheduling.
- J06 — Timeout handling.
- J07 — Cancellation.
- J08 — Retry policies.
- J09 — Local cache.
- J10 — Cache invalidation.
- J11 — Flaky-test tracking.
- J12 — Execution telemetry.

**Acceptance Gate:** Native runner results and SmartTest results remain consistent.

## Epic K — Tracing and Coverage

- K01 — Coverage ingestion.
- K02 — Test-to-source mapping.
- K03 — Runtime trace collection.
- K04 — Trace storage.
- K05 — Trace invalidation.
- K06 — Diff coverage.
- K07 — Branch coverage.
- K08 — Coverage gaps.
- K09 — Coverage quality gates.
- K10 — Full versus partial coverage separation.

**Acceptance Gate:** Coverage reports accurately describe collection scope and granularity.

## Epic L — AI Provider Manager

- L01 — Provider abstraction.
- L02 — Interactive AI setup.
- L03 — API URL normalization.
- L04 — Authentication testing.
- L05 — Automatic model discovery.
- L06 — Manual model fallback.
- L07 — Capability probes.
- L08 — Secure credential management.
- L09 — Multiple AI profiles.
- L10 — Model routing.
- L11 — Usage accounting.
- L12 — Request and cost budgets.
- L13 — Local model support.
- L14 — Provider error handling.

**Acceptance Gate:** Custom compatible endpoints can be configured without hardcoded provider assumptions.

## Epic M — AI Test Engineering

- M01 — AI context builder.
- M02 — Test planning.
- M03 — Test generation.
- M04 — Class targeting.
- M05 — Method targeting.
- M06 — Module targeting.
- M07 — Full-project batch generation.
- M08 — Missing test detection.
- M09 — Coverage audit.
- M10 — Behavioral gap analysis.
- M11 — Edge-case generation.
- M12 — Mock generation.
- M13 — Fixture generation.
- M14 — Test repair.
- M15 — Test improvement.
- M16 — AI review.
- M17 — Mutation analysis.
- M18 — Generated test validation.
- M19 — Review and apply workflow.
- M20 — Resumable generation jobs.
- M21 — AI audit logs.
- M22 — Source privacy controls.

**Acceptance Gate:** Proposed tests are validated and cannot silently replace existing behavior.

## Epic N — SmartTest Studio

- N01 — Local Studio server.
- N02 — Authentication and local security.
- N03 — Design system.
- N04 — Overview dashboard.
- N05 — Test Explorer.
- N06 — Impact Map.
- N07 — Test Builder.
- N08 — Live Runner.
- N09 — Coverage Viewer.
- N10 — Rules Editor.
- N11 — AI Assistant panel.
- N12 — Report Explorer.
- N13 — Real-time updates.
- N14 — Source navigation.
- N15 — Dark and light modes.
- N16 — Keyboard navigation.
- N17 — Browser testing integrations.
- N18 — Responsive and accessible interface.

**Acceptance Gate:** Core testing workflows can be completed from the Studio without a Cloud account.

## Epic O — Reporting

- O01 — JSON reporting.
- O02 — HTML reporting.
- O03 — JUnit XML.
- O04 — Coverage export.
- O05 — Impact explanations.
- O06 — Source annotations.
- O07 — Historical comparison.
- O08 — Performance insights.
- O09 — Report integrity validation.
- O10 — PR summary export.

**Acceptance Gate:** Reports are accurate, portable, and clear about skipped, cached, and executed tests.

## Epic P — CI/CD

- P01 — GitHub Actions integration.
- P02 — PR summaries.
- P03 — Quality gates.
- P04 — CI cache integration.
- P05 — GitLab CI integration.
- P06 — Jenkins support.
- P07 — Safe handling of untrusted PRs.
- P08 — Artifact publishing.
- P09 — Machine-readable output.
- P10 — CI diagnostics.

**Acceptance Gate:** CI integration remains deterministic and secure.

## Epic Q — Cloud SaaS

- Q01 — Authentication.
- Q02 — Organizations.
- Q03 — Workspaces.
- Q04 — Projects and repositories.
- Q05 — Run ingestion.
- Q06 — Historical analytics.
- Q07 — Shared reports.
- Q08 — Shared cache.
- Q09 — Pull request intelligence.
- Q10 — Billing.
- Q11 — RBAC.
- Q12 — Audit logs.
- Q13 — Usage metering.
- Q14 — Retention controls.
- Q15 — Enterprise deployment options.

**Acceptance Gate:** Multi-tenant isolation, billing accuracy, and operational cost controls are verified.

## Epic R — Performance and Reliability

- R01 — Incremental analysis benchmarks.
- R02 — Graph performance benchmarks.
- R03 — Cache benchmarks.
- R04 — Execution scheduling benchmarks.
- R05 — Memory profiling.
- R06 — Stress tests.
- R07 — Failure recovery.
- R08 — Cross-platform validation.
- R09 — Regression detection benchmark suite.
- R10 — Shadow Mode validation.
- R11 — Performance regression CI.

**Acceptance Gate:** Performance claims are reproducible under documented conditions.

## Epic S — Ecosystem Expansion

- S01 — Stable Plugin SDK.
- S02 — Python adapter.
- S03 — pytest integration.
- S04 — Java adapter.
- S05 — JUnit integration.
- S06 — Go adapter.
- S07 — go test integration.
- S08 — Cross-language dependency mappings.
- S09 — Plugin documentation.
- S10 — Community plugin testing.

**Acceptance Gate:** New languages can be added through documented plugin contracts without rewriting the core engine.

---

# 35. Release Roadmap

## Release 0 — Foundation

Deliverables:

- Monorepo architecture.
- Configuration system.
- Plugin contracts.
- Project detection.
- Base CLI.
- Testing fixtures.
- Documentation.
- CI foundation.

## Release 1 — Intelligent npm MVP

Deliverables:

- Smart Init.
- Git integration.
- Native Snapshots.
- TypeScript and JavaScript source analysis.
- Dependency graph.
- Impact selection.
- Custom rules.
- Jest and Vitest adapters.
- Automatic test structure generation.
- Basic HTML reports.
- Explanation commands.
- Safe fallback.

**Release Goal:** A reliable, useful npm package that reduces unnecessary tests and organizes test architecture.

## Release 2 — Advanced Intelligence

Deliverables:

- Adaptive Setup.
- SVN support.
- Runtime tracing.
- Advanced coverage.
- Incremental cache.
- Watch Mode.
- Shadow Mode.
- Improved scheduling.
- Performance dashboards.

**Release Goal:** Stronger selection accuracy, better performance, and continuous project adaptation.

## Release 3 — AI Test Engineering

Deliverables:

- Universal AI setup.
- Model discovery.
- Provider profiles.
- AI test generation.
- Coverage auditing.
- Missing scenario analysis.
- Test validation pipeline.
- AI repair proposals.
- AI review.

**Release Goal:** Optional AI assistance for test creation and maintenance.

## Release 4 — SmartTest Studio

Deliverables:

- Interactive GUI.
- Test Explorer.
- Impact Map.
- Test Builder.
- Live Runner.
- Coverage Viewer.
- AI Assistant.
- Visual Rules Editor.
- Browser testing integrations.

**Release Goal:** A unified interactive developer experience across testing workflows.

## Release 5 — Commercial Cloud

Deliverables:

- Organizations.
- Workspaces.
- Shared reports.
- Historical analytics.
- CI integrations.
- Billing.
- Team permissions.
- Shared cache.
- Enterprise controls.

**Release Goal:** Recurring revenue through collaborative testing intelligence.

## Release 6 — Multi-Language Platform

Deliverables:

- Python.
- Java.
- Go.
- Additional VCS adapters.
- Cross-language analysis.
- Broader ecosystem integrations.
- Advanced enterprise deployment.

**Release Goal:** A language-independent testing intelligence platform.

Release sequencing may be adjusted based on technical dependencies, benchmark results, and customer validation.

---

# 36. Definition of Done

A feature is considered complete only when:

- Functional requirements are implemented.
- Public APIs are typed and documented.
- Errors are handled.
- Edge cases are covered.
- Unit tests pass.
- Relevant integration tests pass.
- Regression tests pass.
- Compatibility is verified.
- Security implications are reviewed.
- Performance is measured where relevant.
- Documentation is updated.
- Examples remain functional.
- Logs and diagnostics are useful.
- No unexpected destructive behavior occurs.
- Test selection remains explainable.
- Fallback behavior is defined.
- Reports accurately represent execution evidence.

---

# 37. Key Technical Risks

## Risk 1 — Missed Regressions

An incomplete dependency model may exclude tests that could detect failures.

**Mitigation:** Hybrid analysis, mandatory rules, conservative fallbacks, Shadow Mode, and periodic full-suite execution.

## Risk 2 — Analysis Overhead

The analysis engine may cost more than the test time it saves.

**Mitigation:** Incremental analysis, caching, benchmarks, and adaptive execution policies.

## Risk 3 — Framework Compatibility

Some frameworks may not expose sufficiently precise tracing or selection APIs.

**Mitigation:** Capability-aware adapters and explicit granularity fallback.

## Risk 4 — Poor AI-Generated Tests

Generated tests may pass while failing to validate meaningful behavior.

**Mitigation:** Compilation, execution, assertion analysis, coverage checks, and optional mutation testing.

## Risk 5 — VCS Complexity

Different VCS providers have different revision and workspace semantics.

**Mitigation:** Explicit provider capabilities, normalized changes, and careful baseline reconciliation.

## Risk 6 — Cloud Cost

Storage, remote execution, and AI services may reduce margins.

**Mitigation:** Data minimization, usage limits, retention policies, and cost-aware architecture.

## Risk 7 — Market Competition

Existing test frameworks and CI platforms already provide affected-test selection and caching.

**Mitigation:** Differentiate through semantic intelligence, source-aware test generation, universal configuration, explainability, adaptive setup, and unified tooling.

## Risk 8 — Developer Trust

Teams may be reluctant to skip tests using a new tool.

**Mitigation:** Transparent reports, reproducible benchmarks, Shadow Mode, and safe adoption workflows.

---

# 38. Product Success Criteria

## 38.1. Technical Success

SmartTest should demonstrate:

- Reliable project detection.
- Correct source change normalization.
- Accurate dependency mapping within supported language capabilities.
- Explainable test selection.
- Safe fallbacks.
- Non-destructive test generation.
- Accurate reports.
- Measurable performance improvements on representative workloads.

## 38.2. Developer Success

Developers should be able to:

- Install SmartTest easily.
- Initialize a supported project.
- Run affected tests.
- Inspect why tests were selected.
- Generate a coherent test structure.
- Review coverage gaps.
- Use the Studio locally.
- Connect an optional AI provider.
- Remove SmartTest without losing their existing tests.

## 38.3. Commercial Success

The platform should demonstrate:

- Organic adoption.
- Repeated usage.
- Validated time savings.
- CI integration adoption.
- Willingness to pay for team capabilities.
- Recurring revenue.
- Sustainable infrastructure margins.
- Growing ecosystem participation.

---

# 39. Final Product Positioning

SmartTest is not simply a faster test runner.

It is an intelligent testing layer connecting source code, version history, dependencies, test execution, coverage, quality policies, and optional AI assistance.

Its main product pillars are:

### 1. Smart Init

Understand and configure a project automatically.

### 2. Universal Change Intelligence

Analyze modifications across Git, SVN, other VCS providers, and native snapshots.

### 3. Semantic Impact Analysis

Determine which parts of the software may be affected by code changes.

### 4. Intelligent Test Selection

Execute relevant tests while respecting correctness and safety requirements.

### 5. Automatic Test Architecture

Generate and maintain consistent test organization based on source structure and developer rules.

### 6. AI Test Engineering

Generate, audit, repair, and improve tests using configurable AI providers.

### 7. SmartTest Studio

Provide a modern visual interface for test development, execution, debugging, and analysis.

### 8. Coverage and Quality Intelligence

Identify gaps, weak tests, unstable suites, and unprotected behavior.

### 9. Open Ecosystem

Support additional languages, frameworks, test runners, and version-control systems through plugins.

### 10. Commercial Cloud

Deliver collaboration, historical intelligence, CI optimization, governance, and enterprise capabilities.

---

# 40. Final Product Objective

The long-term ambition is to make SmartTest a universal testing intelligence platform that can be introduced into almost any software project, automatically understand its structure, adapt to its environment, and continuously improve the way tests are organized, selected, executed, and maintained.

The user experience should ultimately be as simple as:

```bash
npm install -D smarttest

npx smarttest init

npx smarttest run --affected

npx smarttest studio
```

With optional AI:

```bash
npx smarttest ai setup

npx smarttest ai generate-tests --changed

npx smarttest ai audit --coverage

npx smarttest autopilot
```

**Final vision: SmartTest should make software testing faster, more intelligent, more maintainable, and easier to understand without forcing developers to abandon their existing tools.**

**Product mission: Test less when it is safe. Test better everywhere. Know exactly why.**

Architecture recommendation: Start with the fully automatic setup, semantic dependency graph, safe test selector, configurable test generator, and Jest/Vitest integration. These form the technical foundation that every other feature—including AI, the Studio, and the commercial Cloud—will depend on.

The SmartTest name and npm package availability still need verification before publication; the specification uses SmartTest as the working product name.
