# ADR-0003: Local intelligence store

- **Status:** Accepted, with an amended decision (spike ST-013 closed in v0.1.0). SQLite was deferred
- **Related:** ST-013, ST-045, ST-047, PRD §4.3, §8.3

## Context

The symbol index, graph inputs, snapshots and run history must persist between runs. Installation must not require a compiler toolchain on any OS, and `node:sqlite` is not stable across every supported Node release (22.12+).

## Decision

- 1.0 uses a **JSON file store** in `.smarttest/` (write-once, atomic temp+rename):
  - `state/index.json` holds per-file analyses keyed by content hash, file stats (mtime/size) and a resolution-context key. It is written compactly and **only when something changed**.
  - `state/snapshots/*.json` and `state/blobs/` hold snapshot manifests and optional gzip content, deduplicated.
  - `runs/` holds reports, the last decision, coverage and flaky history. `logs/` holds redacted, rotated JSON logs.
- The **graph is derived**. It is rebuilt in memory from cached analyses on each run instead of being stored.
- Corrupt or incompatible stores are **rebuilt with a warning**. They're a cache of derivable data, never a source of truth.

## Why not SQLite (yet)

Measured on synthetic repos: rebuilding the graph from cached analyses takes about 1 ms at 50 modules, about 10 ms at 500 and about 70–120 ms at 2,000. A warm index load takes 5–120 ms. SQLite would add a native dependency or an experimental API with no measurable benefit at these sizes. We'll revisit when benchmarks on larger repositories show the JSON store becoming the bottleneck. The storage interface keeps that change local.

## Consequences

- Zero native dependencies. Works on every supported Node version.
- Memory grows with repository size (about 320 MB RSS at 4,000 files). This is acceptable for 1.0 and tracked in the benchmarks.
