# ADR-0009: Validated result cache, reported as cached

- **Status:** Accepted (0.8.0)
- **Related:** roadmap 0.8.0, [Running less, faster](../../concepts/speed.md), risk R7, PRD §32.2

## Context

Re-running a test whose inputs did not change cannot reveal anything new, unless something the test depends on was not part of its inputs. A cache that returns a stale pass would hide a failure, which is the one thing SmartTest must never do.

## Decision

- The key of a test file hashes its static closure, the files its last fresh trace loaded, its runner config, manifests and lockfiles, `tsconfig*`, `.env*`, Babel/SWC config, setup files, `__mocks__/` files, its snapshot file, the Node major version, the runner and its installed version, and the SmartTest version.
- Not cacheable: tests with uncertain dependencies, tests whose closure reads files through `fs`, Playwright and Cypress specs, tests with a flaky history. Only clean passes (no retry) are stored.
- A reused result has its own status, `cached-pass`. It is never counted as passed in the current run: terminal, HTML, Markdown and JUnit label it "cached, not run", and the report integrity check verifies the counts.
- `--all`, `--coverage` and `--no-cache` never use the cache. `benchmark` compares every cached pass with the same commit's full run and fails on a mismatch.

## Consequences

- Repeated runs of an unchanged state are near-instant (LeadsIt: 1.2 s instead of 4.1 s).
- Replaying history gains nothing, since every commit changes the inputs of the tests it selects.
- Inputs outside the key (a database, the network, the clock) can still make a cached pass wrong; tests depending on them should be flagged flaky or run with `--no-cache` in CI.

## Alternatives considered

- File-level timestamps: cheaper but wrong after checkouts and rebases.
- Caching failures too: re-running a failure is cheap compared with hiding a fix; only passes are cached.
