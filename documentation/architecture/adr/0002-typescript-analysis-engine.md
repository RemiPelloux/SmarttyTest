# ADR-0002: TypeScript analysis engine

- **Status:** Accepted (spike ST-012 closed in v0.1.0)
- **Related:** ST-012, ST-035, ST-036, PRD §4.3, §9

## Context

The spec calls for the TypeScript Compiler API, with tree-sitter where incremental parsing helps. Two compilers coexist: TypeScript 6.x, the last JavaScript-based compiler with the classic programmatic API, and TypeScript 7.x, the native compiler whose programmatic API is still maturing. SmartTest must resolve aliases, project references, `exports` maps and type-only imports exactly as `tsc` does, and stay fast when warm.

## Decision

- **`language-typescript` isolates the compiler** behind the `Analyzer` / `ModuleResolver` contracts. Other than `config`, which transpiles the user's config file, no package imports `typescript`.
- Analysis is **syntactic per file**, using `ts.createSourceFile` for symbols, imports, refs, signatures and token hashes. **Module resolution** uses `ts.resolveModuleName` with the nearest tsconfig/jsconfig and a shared resolution cache, plus a workspace map that sends `exports` entries pointing at `dist/` back to sources.
- **No full type-checking program** is built. This keeps cold analysis at about 1 ms per file and lets results be cached per file content hash.
- JavaScript (ESM, CJS, JSX) goes through the same parser in JS mode (`language-javascript`).
- Pinned to **TypeScript 6.x** for 1.0. Moving to TS 7's API only touches `language-typescript`.

## Measured (benchmarks/RESULTS.md)

Cold index: ~0.26 s at 50 modules, ~0.8 s at 500, ~2.1 s at 2,000 (4,000 files including tests). Warm index with nothing changed: 5–120 ms.

## Consequences

- Precision is at the level of **top-level units** (class, function, variable). A change inside a method propagates through the enclosing class. This is conservative and correct.
- Without type information, `obj.method()` calls are not resolved to a specific method. Selection stays at class granularity rather than guessing.
- Non-literal `import()`/`require()` and unresolvable relative imports are recorded as uncertainty. They widen selection in BALANCED and trigger the full suite in SAFE.
