# ADR-0003: Local intelligence store

- **Status:** Accepted, with an amended decision (spike ST-013 closed in v0.1.0). SQLite was deferred
- **Related:** ST-013, ST-045, ST-047, PRD §4.3, §8.3

## Context

The symbol index, graph inputs, snapshots and run history must persist between runs. Installation must not require a compiler toolchain on any OS, and `node:sqlite` is not stable across every supported Node release (22.12+).

## Decision

- 1.0 uses a **JSON file store** in `.smarttest/` (write-once, atomic temp+rename):
  - `state/index.json` holds per-file analyses keyed by content hash, file stats (mtime/size) and a resolution-context key. It is written compactly and **only when something changed**. A run that re-parses a few files writes them to `state/index-delta.json`, which names the full write it applies to (amended in 1.0.0).
  - `state/snapshots/*.json` and `state/blobs/` hold snapshot manifests and optional gzip content, deduplicated.
  - `runs/` holds reports, the last decision, coverage and flaky history. `logs/` holds redacted, rotated JSON logs.
- The **graph is derived**. Since 1.0.0 it is also persisted as a cache (`state/graph.json`, see the amendment below); it is never a source of truth.
- Corrupt or incompatible stores are **rebuilt with a warning**. They're a cache of derivable data, never a source of truth.

## Why not SQLite (yet)

Measured on synthetic repos: rebuilding the graph from cached analyses takes about 1 ms at 50 modules, about 10 ms at 500 and about 70–120 ms at 2,000. A warm index load takes 5–120 ms. SQLite would add a native dependency or an experimental API with no measurable benefit at these sizes. We'll revisit when benchmarks on larger repositories show the JSON store becoming the bottleneck. The storage interface keeps that change local.

## Consequences

- Zero native dependencies. Works on every supported Node version.
- Memory grows with repository size (about 320 MB RSS at 4,000 files). This is acceptable for 1.0 and tracked in the benchmarks.

## Amendment (1.0.0): persisted graph and index deltas

At 10,000 modules, rebuilding the graph took 100–150 ms and rewriting the 34 MB index after a one-file edit took about 80 ms, on every warm run. Both are now incremental, and both stay caches that are rebuilt on any doubt:

- `state/graph.json` is a header line and the serialized graph. The header records the SmartTest version, the graph and store formats, hashes of the configuration and of the graph options (routes, end-to-end specs), a hash of every file's module resolution, each file's content hash with its analyzer version and a hash of its surface (imports, exports, declarations), and the SHA-256 of the graph line. The graph is used only when all of these match the current analyses. Files whose content changed while their surface did not are patched into it, as watch mode patches its in-memory graph; any other difference, a damaged file or a checksum mismatch rebuilds it. A patched graph is written back once more than 32 files differ from the stored one.
- `state/index-delta.json` holds the analyses and stats changed since `index.json` was written, with the id of that full write. A delta for another full write is ignored; the index's per-file stat and content-hash checks then re-parse what changed. The full index is rewritten when the delta exceeds 64 paths (or 2% of the files) or when resolution context changes.
