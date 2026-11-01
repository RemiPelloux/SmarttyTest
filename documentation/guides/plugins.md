# Plugins

The Plugin SDK is SmartTest's public extension API. Version 1 is frozen at SmartTest 1.0.0 and covers four contracts:

| Contract                | Interface               | What it does                                             | Loadable from a plugin in 1.0 |
| ----------------------- | ----------------------- | -------------------------------------------------------- | ----------------------------- |
| Edge provider           | `EdgeProvider`          | Adds dependency edges that static analysis cannot see    | yes                           |
| Runner adapter          | `TestAdapter`           | Discovers and runs tests (Vitest, Jest, `node --test`…)  | not yet                       |
| Version-control adapter | `VersionControlAdapter` | Reports what changed (Git, Subversion, Mercurial)        | not yet                       |
| Language analyzer       | `LanguageAnalyzer`      | Turns a source file into imports, symbols and references | not yet                       |

SmartTest's built-in adapters implement the last three and pass the [conformance kit](#conformance-kit). In 1.0 a plugin can contribute edge providers; registering runners, version control and analyzers from a plugin will come in a minor release, as new optional fields of `SmartTestPlugin`. The interfaces themselves will not change.

Everything is imported from the `smarttest` package:

```ts
import { definePlugin, type EdgeProvider, PLUGIN_API_VERSION } from "smarttest/plugin-sdk";
import { assertConformance, checkEdgeProvider } from "smarttest/plugin-sdk/conformance";
```

Every adapter, provider and plugin declares `apiVersion: 1`. SmartTest refuses a plugin built for another version (`ST_PLUGIN_API_VERSION`, exit 3).

## Edge providers

TypeScript and JavaScript imports, references and many conventions (environment keys, Prisma models, translation keys, routes) are understood out of the box. An edge provider covers what is left: a file read through a name built at run time, code generated from a schema, a service in another language. It returns edges between project files; `from` depends on `to`, so a change to `to` affects `from` and every test that reaches `from`.

```js
// tools/sql-edges.mjs
const CALL = /\bquery\(\s*(?:"([\w-]+)"|([^)]*))\)/g;

/** @type {import("smarttest/plugin-sdk").EdgeProvider} */
const sqlEdges = {
  apiVersion: 1,
  id: "sql-queries",
  getCapabilities: () => ({ fileEdges: true, unresolved: true, nonSourceFiles: true }),
  async provideEdges(ctx) {
    const all = new Set(await ctx.listFiles());
    const edges = [];
    const unresolved = [];
    for (const file of ctx.files) {
      if (ctx.isTest(file) || !file.startsWith("src/")) continue;
      for (const m of ((await ctx.readFile(file)) ?? "").matchAll(CALL)) {
        const to = m[1] ? `sql/${m[1]}.sql` : undefined;
        if (to && all.has(to))
          edges.push({ from: file, to, kind: "REFERENCES", confidence: "high" });
        else unresolved.push({ file, reason: `query(${m[1] ?? m[2]}) reads no known file` });
      }
    }
    return { edges, unresolved };
  },
};

/** @type {import("smarttest/plugin-sdk").SmartTestPlugin} */
export default { apiVersion: 1, name: "sql-edges", edgeProviders: [sqlEdges] };
```

Register it in the configuration, as a path relative to the project root or as an installed package name:

```ts
import { defineConfig } from "smarttest";

export default defineConfig({
  plugins: ["./tools/sql-edges.mjs"],
});
```

With this plugin, editing `sql/find-user.sql` selects only the tests that reach a file calling `query("find-user")`. Without it, SmartTest has no way to connect the SQL file to any test. The [`plugin-edges-vitest`](../../fixtures/projects/plugin-edges-vitest) fixture is this example, run by the regression harness.

### What SmartTest guarantees around a provider

- **Edges only add tests.** A provider can never make SmartTest skip a test that static analysis selects.
- **Unresolved is uncertainty.** Report what you saw but could not resolve in `unresolved`. In BALANCED and SAFE mode the tests that reach those files are selected; FAST mode skips them and says so in a warning (the same as dynamic imports).
- **A broken provider stops the run.** If `provideEdges` throws, or returns an edge with an absolute or `..` path, an unknown `kind` or `confidence`, the analysis fails with `ST_PLUGIN_FAILED` (exit 4). SmartTest never treats a failure as "no edges".
- **Plugin changes widen.** A change to a plugin file inside the project selects the full suite, because the edges it computes may have changed.
- **Provenance is kept.** Provided edges appear in `smarttest graph --format json` with `"provenance": "plugin"`.

### Contract

| Member                | Contract                                                                                                                                                                                                                     |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apiVersion`          | `1`                                                                                                                                                                                                                          |
| `id`                  | Stable, unique among providers; shown in warnings and uncertainty reasons                                                                                                                                                    |
| `getCapabilities()`   | `fileEdges`, `unresolved`, `nonSourceFiles`: each `true`, `false` or `"partial"`. Anything not declared `true` is unsupported                                                                                                |
| `provideEdges(ctx)`   | Called once per analysis. Deterministic for the same files. Local only: no network (ADR-0004)                                                                                                                                |
| `ctx.root`            | Absolute project root                                                                                                                                                                                                        |
| `ctx.files`           | Project-relative POSIX paths of the analysed source files, tests included                                                                                                                                                    |
| `ctx.listFiles()`     | Every project file that is not excluded, non-code files included                                                                                                                                                             |
| `ctx.readFile(path)`  | File content, or `undefined` when it is missing or outside the project                                                                                                                                                       |
| `ctx.isTest(path)`    | Whether SmartTest treats the file as a test                                                                                                                                                                                  |
| result `edges[]`      | `{ from, to, kind, confidence, reason? }`; `from`/`to` project-relative POSIX paths; `kind` a graph edge kind such as `REFERENCES`, `IMPORTS`, `DEPENDS_ON`, `CONFIGURES`; `confidence` `high`, `medium`, `low` or `unknown` |
| result `unresolved[]` | `{ file, reason }`                                                                                                                                                                                                           |

Capabilities, as SmartTest uses them (ADR-0005):

- `fileEdges` not declared: the provider is never called.
- `unresolved` not `true`: SmartTest warns that what the provider misses is invisible to it. Its edges still only add tests.
- `nonSourceFiles`: declare it when `to` can be a file outside `ctx.files` (SQL, GraphQL, YAML, another language). The conformance kit checks the declaration.

Edges are file to file in version 1: `to` changing affects all of `from`. A symbol-level edge (`file#Symbol`) can come later as an optional, declared capability.

## Runner adapters

```ts
interface TestAdapter {
  readonly apiVersion: 1;
  id: string;
  discover(): Promise<TestCase[]>;
  execute(selection: TestSelection, options: ExecutionOptions): Promise<TestRunResult>;
  collectCoverage?(): Promise<CoverageArtifact>;
  getCapabilities(): TestAdapterCapabilities;
}
```

- Declare all nine capabilities (`discovery`, `fileSelection`, `testCaseSelection`, `coverage`, `tracing`, `parallel`, `cancellation`, `retry`, `sourceMaps`). SmartTest adapts to what is declared, for example by selecting whole files when `testCaseSelection` is not `true`. Never emulate a missing capability.
- `TestCase.filePath` and test ids use project-relative POSIX paths. A test id is `<file>::<full test name>`.
- Report what the runner did: `passed`, `failed`, `skipped`, `pending`, `cancelled`, `timed-out`, `flaky` or `infrastructure-error`. A skipped test is never `passed`, and an adapter never reports `cached-pass` or `cached-failure`: those belong to SmartTest's validated cache (ADR-0009).
- A file that cannot run at all (syntax error, crash) is a failed execution, not an empty result.

## Version-control adapters

```ts
interface VersionControlAdapter {
  readonly apiVersion: 1;
  readonly id: string;
  detect(root: string): Promise<boolean>;
  getWorkingState(): Promise<WorkingState>;
  getChanges(base: RevisionRef, target?: RevisionRef): Promise<ChangeSet>;
  getFileContent(path: string, revision: RevisionRef): Promise<Uint8Array | null>;
  getCapabilities(): VersionControlCapabilities;
}
```

- `RevisionRef.ref` is provider-specific: a Git SHA, an SVN revision and a snapshot id are not interchangeable.
- Without `target`, `getChanges` compares `base` with the working copy, untracked files included when `untrackedFiles` is declared.
- `ChangeSet.completeness` must be honest: `partial` or `unknown` when part of the change could not be read. SmartTest runs the full suite when it is `unknown`, and SAFE mode does so for `partial` too.
- Without `renameDetection`, report a rename as a deletion plus an addition.
- `getFileContent` returns `null` for a file absent at that revision.

## Language analyzers

```ts
interface LanguageAnalyzer {
  readonly apiVersion: 1;
  readonly id: string;
  readonly version: string;
  supports(path: string): boolean;
  analyze(path: string, content: string): FileAnalysis;
}
```

`FileAnalysis` lists a file's imports, symbols (ids are `<path>#<qualifiedName>`), exports and references. Optional fields are enrichments: leaving one out makes selection coarser, never wrong. Report every import you cannot resolve statically in `dynamicUnresolved`; SmartTest turns it into uncertainty. Change `version` whenever the output can change, so cached analyses are recomputed. For a language SmartTest does not analyse, an edge provider is usually the simpler start.

## Conformance kit

`smarttest/plugin-sdk/conformance` checks an implementation against the contract with a fixture you provide. It does not depend on a test framework: each function returns a report, and `assertConformance` throws with every failed check listed.

| Function                                   | Fixture                                                                                            |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `checkRunnerAdapter(adapter, fixture?)`    | `expectedFiles`; `run: { files, expect: { [file]: "passed" \| "failed" } }`                        |
| `checkVcsAdapter(adapter, fixture)`        | a working copy `root` with uncommitted changes, `outside`, `base`, `expectedChanges`, `fileAtBase` |
| `checkLanguageAnalyzer(analyzer, fixture)` | `files: { [path]: source }`, `expect: { imports, symbols, uncertain }`                             |
| `checkEdgeProvider(provider, fixture)`     | `root`, `files`, `allFiles`, `expectedEdges`, `expectedUnresolved`                                 |
| `checkPlugin(plugin, fixtures?)`           | the default export, and an edge-provider fixture per provider id                                   |

```ts
import { test } from "node:test";
import { assertConformance, checkPlugin } from "smarttest/plugin-sdk/conformance";
import plugin from "../tools/sql-edges.mjs";

test("sql-edges conforms to the plugin API", async () => {
  const report = await checkPlugin(plugin, {
    edgeProviders: {
      "sql-queries": {
        root: process.cwd(),
        files: ["src/users.ts"],
        allFiles: ["src/users.ts", "sql/find-user.sql"],
        expectedEdges: [{ from: "src/users.ts", to: "sql/find-user.sql" }],
      },
    },
  });
  assertConformance(report);
});
```

The kit checks identity and `apiVersion`, that every capability is declared, the shape of every result (relative POSIX paths, known kinds and statuses), determinism, the expectations of your fixture, and declarations against behaviour: a runner that discovers tests without declaring `discovery` fails, so does a provider that points outside the analysed sources without declaring `nonSourceFiles`.

## The semver promise

Plugin API version 1 does not change within SmartTest 1.x. Minor releases may add optional members to the interfaces you implement (SmartTest handles their absence), members to the objects SmartTest passes you, capability keys (undeclared counts as unsupported), edge kinds, and conformance checks for behaviour the contract already required. Removing or renaming anything, or adding a required member, waits for a major version together with a new `apiVersion`. See [Public contracts](../reference/contracts.md).
