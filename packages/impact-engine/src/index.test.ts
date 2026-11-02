import { DependencyGraph } from "@smarttest/dependency-graph";
import { analyzeSource } from "@smarttest/language-typescript";
import { RulesEngine } from "@smarttest/rules-engine";
import type { FileSemanticDiff } from "@smarttest/semantic-diff";
import type { ChangeSet } from "@smarttest/shared";
import type { FileAnalysis } from "@smarttest/source-parser";
import { describe, expect, it } from "vitest";
import { decideImpact, explainTest, type TraceEvidence } from "./index.js";

const sources: Record<string, string> = {
  "src/a.ts": "export const a = () => 1;\n",
  "src/b.ts": 'import { a } from "./a";\nexport const b = () => a() + 1;\n',
  "src/plugins.ts": "export const load = (n: string) => import(n);\n",
  "src/auth/guard.ts": "export const guard = () => true;\n",
  "test/a.test.ts": 'import { a } from "../src/a";\na();\n',
  "test/b.test.ts": 'import { b } from "../src/b";\nb();\n',
  "test/plugins.test.ts": 'import { load } from "../src/plugins";\nload("x");\n',
  "test/guard.test.ts": 'import { guard } from "../src/auth/guard";\nguard();\n',
  "packages/web/src/x.ts": "export const x = 1;\n",
  "packages/web/test/x.test.ts": 'import { x } from "../src/x";\nx;\n',
};
const resolutions: Record<string, string> = {
  "src/b.ts:./a": "src/a.ts",
  "test/a.test.ts:../src/a": "src/a.ts",
  "test/b.test.ts:../src/b": "src/b.ts",
  "test/plugins.test.ts:../src/plugins": "src/plugins.ts",
  "test/guard.test.ts:../src/auth/guard": "src/auth/guard.ts",
  "packages/web/test/x.test.ts:../src/x": "packages/web/src/x.ts",
};

function setup() {
  const files = new Map<string, FileAnalysis>();
  for (const [p, c] of Object.entries(sources)) {
    const an = analyzeSource(p, c);
    for (const imp of an.imports) {
      const r = resolutions[`${p}:${imp.specifier}`];
      if (r) imp.resolved = r;
      else imp.external = true;
    }
    files.set(p, an);
  }
  const isTest = (p: string) => p.includes(".test.");
  return {
    files,
    graph: new DependencyGraph(files, isTest),
    isTest,
    tests: [...files.keys()].filter(isTest),
  };
}

const changed = (
  paths: string[],
  completeness: ChangeSet["completeness"] = "complete",
): ChangeSet => ({
  provider: "git",
  completeness,
  warnings: [],
  changes: paths.map((path) => ({ type: "modified" as const, path })),
});
const unit = (path: string, units: string[], trivialOnly = false): [string, FileSemanticDiff] => [
  path,
  {
    path,
    units,
    trivialOnly,
    confidence: "high",
    changes: [
      { filePath: path, kind: trivialOnly ? "comment-only" : "implementation", confidence: "high" },
    ],
  },
];

function decide(
  cs: ChangeSet,
  diffs: [string, FileSemanticDiff][],
  mode: "fast" | "balanced" | "safe",
  rules = new RulesEngine([]),
  traces?: TraceEvidence,
) {
  const { files, graph, isTest, tests } = setup();
  return decideImpact({
    ...(traces ? { traces } : {}),
    changeSet: cs,
    diffs: new Map(diffs),
    graph,
    files,
    testFiles: tests,
    isTest,
    mode,
    triggers: ["**/tsconfig*.json", "**/package.json"],
    rules,
  });
}
const sel = (d: ReturnType<typeof decide>) => d.selectedTests.map((t) => t.filePath).sort();

/** Fake traces: test → file → executed units. */
const fakeTraces = (ran: Record<string, Record<string, string[]>>): TraceEvidence => ({
  isFresh: (t) => t in ran,
  executed: (t, f, u) => !!ran[t]?.[f] && (u === "*" || (ran[t]?.[f] ?? []).includes(u)),
  collectedAt: () => "2000-01-01T00:00:00.000Z",
});

describe("decideImpact", () => {
  it("observed evidence: fresh traces rule out, add, and resolve uncertainty (not in SAFE)", () => {
    const traces = fakeTraces({
      "test/b.test.ts": { "src/b.ts": ["b"] }, // never loaded src/a.ts
      "test/plugins.test.ts": { "src/plugins.ts": ["load"] }, // dynamic import never loaded a.ts
      "test/guard.test.ts": { "src/auth/guard.ts": ["guard"], "src/a.ts": ["a"] }, // ran a() at runtime
    });
    const d = decide(
      changed(["src/a.ts"]),
      [unit("src/a.ts", ["a"])],
      "balanced",
      undefined,
      traces,
    );
    expect(sel(d)).toEqual(["test/a.test.ts", "test/guard.test.ts"]);
    expect(d.selectedTests.find((t) => t.filePath === "test/guard.test.ts")?.reasons[0]?.kind).toBe(
      "observed-execution",
    );
    expect(d.details.observedSkips?.map((s) => s.test)).toEqual(["test/b.test.ts"]);
    const safe = decide(
      changed(["src/a.ts"]),
      [unit("src/a.ts", ["a"])],
      "safe",
      undefined,
      traces,
    );
    expect(sel(safe)).toEqual([
      "test/a.test.ts",
      "test/b.test.ts",
      "test/guard.test.ts",
      "test/plugins.test.ts",
    ]);
  });

  it("reports changed units no test reaches", () => {
    const d = decide(
      changed(["src/auth/guard.ts", "packages/web/src/x.ts"]),
      [unit("src/auth/guard.ts", ["unused"])],
      "balanced",
    );
    expect(d.details.unprotected).toEqual(["src/auth/guard.ts#unused"]);
  });

  it("type-checked tests: any change to a file they reach selects them, not formatting", () => {
    const { files, graph, isTest, tests } = setup();
    const run = (trivialOnly: boolean, typeChecked: string[]) =>
      decideImpact({
        changeSet: changed(["src/auth/guard.ts"]),
        diffs: new Map([unit("src/auth/guard.ts", ["unused"], trivialOnly)]),
        graph,
        files,
        testFiles: tests,
        isTest,
        mode: "balanced",
        triggers: [],
        rules: new RulesEngine([]),
        typeCheckedTests: new Set(typeChecked),
      })
        .selectedTests.map((t) => t.filePath)
        // Selected for its dynamic import (uncertainty), whatever changed.
        .filter((t) => t !== "test/plugins.test.ts");
    // A new, unused export: no test runs it, but `ng test` compiles (and type-checks) it.
    expect(run(false, [])).toEqual([]);
    expect(run(false, ["test/guard.test.ts"])).toEqual(["test/guard.test.ts"]);
    expect(run(true, ["test/guard.test.ts"])).toEqual([]);
  });

  it("selects direct and transitive tests; unresolvable tests can't be ruled out in BALANCED", () => {
    const d = decide(changed(["src/a.ts"]), [unit("src/a.ts", ["a"])], "balanced");
    expect(sel(d)).toEqual(["test/a.test.ts", "test/b.test.ts", "test/plugins.test.ts"]);
    expect(
      d.selectedTests.find((t) => t.filePath === "test/plugins.test.ts")?.reasons[0]?.kind,
    ).toBe("uncertainty");
    expect(d.analysisStatus).toBe("partial");
  });

  it("FAST only warns about uncertainty", () => {
    const d = decide(changed(["src/a.ts"]), [unit("src/a.ts", ["a"])], "fast");
    expect(sel(d)).toEqual(["test/a.test.ts", "test/b.test.ts"]);
    expect(d.warnings.some((w) => w.includes("FAST mode"))).toBe(true);
  });

  it("SAFE selects uncertain tests individually instead of the whole suite", () => {
    const d = decide(changed(["src/a.ts"]), [unit("src/a.ts", ["a"])], "safe");
    expect(d.fallbackApplied).toBe(false);
    expect(sel(d)).toEqual(["test/a.test.ts", "test/b.test.ts", "test/plugins.test.ts"]);
  });

  it("SAFE falls back to the full suite when the change analysis is incomplete", () => {
    const d = decide(changed(["src/a.ts"], "partial"), [unit("src/a.ts", ["a"])], "safe");
    expect(d.fallbackApplied).toBe(true);
    expect(d.selectedTests).toHaveLength(5);
  });

  it("falls back to the full suite without a baseline", () => {
    const d = decide(
      { provider: "native", completeness: "unknown", warnings: ["No snapshot yet"], changes: [] },
      [],
      "fast",
    );
    expect(d.analysisStatus).toBe("fallback");
    expect(d.selectedTests).toHaveLength(5);
    expect(d.skippedTests).toHaveLength(0);
  });

  it("scopes mandatory triggers to their directory", () => {
    const d = decide(changed(["packages/web/package.json"]), [], "fast");
    expect(sel(d)).toEqual(["packages/web/test/x.test.ts"]);
    const root = decide(changed(["tsconfig.json"]), [], "balanced");
    expect(root.fallbackApplied).toBe(true);
  });

  it("skips comment-only changes only in FAST", () => {
    expect(sel(decide(changed(["src/a.ts"]), [unit("src/a.ts", [], true)], "fast"))).toEqual([]);
    expect(
      sel(decide(changed(["src/a.ts"]), [unit("src/a.ts", [], true)], "balanced")).length,
    ).toBeGreaterThan(0);
  });

  it("applies rule mode upgrades and always-run scopes", () => {
    const rules = new RulesEngine([
      {
        name: "auth",
        match: { path: "src/auth/**" },
        risk: "critical",
        execution: { alwaysRunOnAffected: true },
      },
    ]);
    const d = decide(
      changed(["src/auth/guard.ts"]),
      [unit("src/auth/guard.ts", ["guard"])],
      "balanced",
      rules,
    );
    expect(d.safetyMode).toBe("safe");
    expect(d.requestedMode).toBe("balanced");
    expect(
      d.selectedTests
        .find((t) => t.filePath === "test/guard.test.ts")
        ?.reasons.some((r) => r.ruleName === "auth"),
    ).toBe(true);
  });

  it("never reports a test as both selected and skipped, and explains both", () => {
    const d = decide(changed(["src/b.ts"]), [unit("src/b.ts", ["b"])], "balanced");
    const s = new Set(d.selectedTests.map((t) => t.filePath));
    expect(d.skippedTests.every((t) => !s.has(t.filePath))).toBe(true);
    expect(explainTest(d, "test/b.test.ts").status).toBe("selected");
    expect(explainTest(d, "test/a.test.ts").status).toBe("skipped");
  });

  it("selects changed test files directly", () => {
    const d = decide(changed(["test/a.test.ts"]), [], "balanced");
    expect(d.selectedTests[0]?.reasons[0]?.kind).toBe("test-file-changed");
  });
});

describe("decideImpact: tests that are imported, type tests", () => {
  const local = (src: Record<string, string>, res: Record<string, string>) => {
    const files = new Map<string, FileAnalysis>();
    for (const [p, c] of Object.entries(src)) {
      const an = analyzeSource(p, c);
      for (const imp of an.imports) {
        const r = res[`${p}:${imp.specifier}`];
        if (r) imp.resolved = r;
        else imp.external = true;
      }
      files.set(p, an);
    }
    const isTest = (p: string) => /\.test(-d)?\./.test(p);
    return { files, graph: new DependencyGraph(files, isTest), isTest };
  };
  const run = (
    ctx: ReturnType<typeof local>,
    cs: ChangeSet,
    diffs: [string, FileSemanticDiff][],
    traces?: TraceEvidence,
  ) =>
    decideImpact({
      ...(traces ? { traces } : {}),
      changeSet: cs,
      diffs: new Map(diffs),
      graph: ctx.graph,
      files: ctx.files,
      testFiles: [...ctx.files.keys()].filter(ctx.isTest),
      isTest: ctx.isTest,
      mode: "balanced",
      triggers: [],
      rules: new RulesEngine([]),
    });

  it("a changed test that other tests import also selects them", () => {
    const ctx = local(
      {
        "test/shared.test.ts":
          'export const check = (v: number) => v > 0;\nit("self", () => check(1));\n',
        "test/uses.test.ts": 'import { check } from "./shared.test";\nit("x", () => check(2));\n',
        "test/alone.test.ts": 'it("y", () => 1);\n',
      },
      { "test/uses.test.ts:./shared.test": "test/shared.test.ts" },
    );
    const d = run(ctx, changed(["test/shared.test.ts"]), [unit("test/shared.test.ts", ["check"])]);
    expect(d.selectedTests.map((t) => t.filePath).sort()).toEqual([
      "test/shared.test.ts",
      "test/uses.test.ts",
    ]);
    // A test nobody imports selects itself only.
    const alone = run(ctx, changed(["test/alone.test.ts"]), []);
    expect(alone.selectedTests.map((t) => t.filePath)).toEqual(["test/alone.test.ts"]);
  });

  it("a type change is not ruled out by traces: types never run", () => {
    const ctx = local(
      {
        "src/types.ts":
          "export type Id = string;\nexport interface User { name: string }\nexport const mk = () => 1;\n",
        "test/types.test-d.ts":
          'import { mk, type Id } from "../src/types";\ntest("t", () => expectTypeOf<Id>().toEqualTypeOf<string>());\ntest("m", () => mk());\n',
      },
      { "test/types.test-d.ts:../src/types": "src/types.ts" },
    );
    // Fresh, and it never ran anything in src/types.ts.
    const traces = fakeTraces({ "test/types.test-d.ts": { "src/other.ts": ["x"] } });
    const typeDiff: [string, FileSemanticDiff] = [
      "src/types.ts",
      {
        path: "src/types.ts",
        units: ["Id"],
        trivialOnly: false,
        confidence: "high",
        changes: [{ filePath: "src/types.ts", kind: "interface", confidence: "high" }],
      },
    ];
    const d = run(ctx, changed(["src/types.ts"]), [typeDiff], traces);
    expect(d.selectedTests.map((t) => t.filePath)).toEqual(["test/types.test-d.ts"]);
    expect(d.details.observedSkips).toBeUndefined();
    // A runtime unit the fresh trace never ran is still ruled out.
    const code = run(ctx, changed(["src/types.ts"]), [unit("src/types.ts", ["mk"])], traces);
    expect(code.selectedTests).toEqual([]);
    expect(code.details.observedSkips?.map((s) => s.test)).toEqual(["test/types.test-d.ts"]);
  });
});

/** A small project: sources, and the resolution of each `file:specifier` (others are unresolved). */
function project(srcs: Record<string, string>, resolved: Record<string, string>) {
  const files = new Map<string, FileAnalysis>();
  for (const [p, c] of Object.entries(srcs)) {
    const an = analyzeSource(p, c);
    for (const imp of an.imports) {
      const r = resolved[`${p}:${imp.specifier}`];
      if (r) imp.resolved = r;
      else if (imp.specifier.startsWith(".")) imp.unresolved = "does not resolve";
      else imp.external = true;
    }
    files.set(p, an);
  }
  const isTest = (p: string) => p.includes(".test.");
  const graph = new DependencyGraph(files, isTest);
  return (
    cs: ChangeSet,
    mode: "fast" | "balanced" | "safe",
    extra: Partial<Parameters<typeof decideImpact>[0]> = {},
  ) =>
    decideImpact({
      changeSet: cs,
      diffs: new Map(),
      graph,
      files,
      testFiles: [...files.keys()].filter(isTest),
      isTest,
      mode,
      triggers: [],
      rules: new RulesEngine([]),
      ...extra,
    });
}

describe("changes the graph no longer sees", () => {
  const decideIn = project(
    {
      "src/conf.ts": 'import conf from "./conf.json";\nexport const v = () => conf.v;\n',
      "src/load.ts":
        'import { readFileSync } from "node:fs";\nexport const load = () => readFileSync(new URL("./data.txt", import.meta.url), "utf8");\n',
      "src/m.ts": 'import { x } from "../../shared/x";\nexport const m = () => x;\n',
      "src/w.ts": 'import { y } from "@acme/shared";\nexport const w = () => y;\n',
      "src/sub.ts": 'import { s } from "../lib/s";\nexport const sub = () => s;\n',
      "test/conf.test.ts": 'import { v } from "../src/conf";\nv();\n',
      "test/load.test.ts": 'import { load } from "../src/load";\nload();\n',
      "test/m.test.ts": 'import { m } from "../src/m";\nm();\n',
      "test/w.test.ts": 'import { w } from "../src/w";\nw();\n',
      "test/sub.test.ts": 'import { sub } from "../src/sub";\nsub();\n',
    },
    {
      "test/conf.test.ts:../src/conf": "src/conf.ts",
      "test/load.test.ts:../src/load": "src/load.ts",
      "test/m.test.ts:../src/m": "src/m.ts",
      "test/w.test.ts:../src/w": "src/w.ts",
      "test/sub.test.ts:../src/sub": "src/sub.ts",
      "src/sub.ts:../lib/s": "lib/s.ts",
    },
  );
  const cs = (changes: ChangeSet["changes"], outside?: ChangeSet["changes"]): ChangeSet => ({
    provider: "vcs",
    completeness: "complete",
    warnings: [],
    changes,
    ...(outside ? { outside } : {}),
  });
  const picked = (d: ReturnType<typeof decideIn>) => d.selectedTests.map((t) => t.filePath).sort();

  it("a deleted or renamed non-code file selects the code importing or reading it, in every mode", () => {
    for (const mode of ["fast", "safe"] as const) {
      const del = decideIn(cs([{ type: "deleted", path: "src/conf.json" }]), mode);
      expect(picked(del)).toContain("test/conf.test.ts");
      expect(del.details.ignored).toEqual([]);
      const read = decideIn(
        cs([{ type: "renamed", path: "src/data2.txt", previousPath: "src/data.txt" }]),
        mode,
      );
      expect(picked(read)).toContain("test/load.test.ts");
      expect(read.details.ignored).not.toContain(
        "src/data.txt (renamed; not referenced by analysed code)",
      );
    }
  });

  it("a change outside the project selects the tests of the files importing it", () => {
    const d = decideIn(cs([], [{ type: "modified", path: "../shared/x.ts" }]), "fast");
    expect(picked(d)).toEqual(["test/m.test.ts"]);
    expect(d.selectedTests[0]?.reasons[0]?.message).toMatch(/Uses \.\.\/shared\/x\.ts, outside/);
    // Through a package linked to a folder outside the project (a workspace sibling).
    const linked = decideIn(cs([], [{ type: "modified", path: "../shared/y.ts" }]), "fast", {
      outsideLinks: new Map([["src/w.ts", ["../shared"]]]),
    });
    expect(picked(linked)).toEqual(["test/w.test.ts"]);
    const other = decideIn(cs([], [{ type: "modified", path: "../other/z.ts" }]), "fast");
    expect(picked(other)).toEqual([]);
  });

  it("a submodule bump that could not be expanded selects every test using it", () => {
    const d = decideIn(cs([{ type: "modified", path: "lib", submodule: true }]), "fast");
    expect(picked(d)).toEqual(["test/sub.test.ts"]);
    expect(d.selectedTests[0]?.reasons[0]?.message).toMatch(/Submodule lib changed/);
  });

  it("an env file key no analysed code reads selects the tests under the file's folder", () => {
    const d = decideIn(cs([{ type: "modified", path: ".env.e2e" }]), "balanced", {
      resources: new Map([
        [".env.e2e", { file: ".env.e2e", kind: "env", keys: ["DATABASE_URL"], global: false }],
      ]),
    });
    expect(picked(d)).toHaveLength(5);
    expect(d.details.ignored).toEqual([]);
    expect(d.reasons[0]?.message).toMatch(/DATABASE_URL not read by analysed code/);
  });
});

describe("decideImpact · files a runner loads", () => {
  const { files, graph, isTest, tests } = setup();
  const run = (paths: string[], runnerInputs: Parameters<typeof decideImpact>[0]["runnerInputs"]) =>
    decideImpact({
      changeSet: changed(paths),
      diffs: new Map(),
      graph,
      files,
      testFiles: tests,
      isTest,
      mode: "fast", // FAST: the dynamic-import test is not selected for uncertainty
      triggers: ["**/vitest.config.*", "**/package.json"],
      rules: new RulesEngine([]),
      ...(runnerInputs ? { runnerInputs } : {}),
    });

  it("a setup file (and what it imports) selects the tests of its runner, with the reason", () => {
    const message = "test/setup.ts changed — setup file of vitest (setupFiles in vitest.config.ts)";
    const d = run(
      ["test/setup.ts"],
      [{ file: "test/setup.ts", tests: ["test/a.test.ts", "test/b.test.ts"], message }],
    );
    expect(sel(d)).toEqual(["test/a.test.ts", "test/b.test.ts"]);
    expect(explainTest(d, "test/a.test.ts").reasons).toEqual([message]);
    expect(d.details.ignored).toEqual([]);
    expect(d.details.runnerInputs).toEqual([{ file: "test/setup.ts", message, tests: 2 }]);
    // Without it, nothing selects them.
    expect(sel(run(["test/setup.ts"], undefined))).toEqual([]);
  });

  it("a changed module a setup file imports is not reported unprotected", () => {
    const hit = {
      file: "src/auth/guard.ts",
      tests: ["test/a.test.ts"],
      message: "src/auth/guard.ts changed — imported by test/setup.ts, setup file of vitest",
      path: ["src/auth/guard.ts", "test/setup.ts"],
    };
    const d = decideImpact({
      changeSet: changed(["src/auth/guard.ts"]),
      diffs: new Map([unit("src/auth/guard.ts", ["unused"])]),
      graph,
      files,
      testFiles: tests,
      isTest,
      mode: "fast", // FAST: the dynamic-import test is not selected for uncertainty
      triggers: [],
      rules: new RulesEngine([]),
      runnerInputs: [hit],
    });
    expect(sel(d)).toEqual(["test/a.test.ts"]);
    expect(explainTest(d, "test/a.test.ts").path).toEqual(hit.path);
    expect(d.details.unprotected).toBeUndefined();
  });

  it("a runner's own configuration selects that runner's tests, not every test", () => {
    const own = run(
      ["vitest.config.ts"],
      [
        {
          file: "vitest.config.ts",
          tests: ["test/a.test.ts"],
          message: "vitest.config.ts changed — configuration of vitest",
          narrow: true,
        },
      ],
    );
    expect(sel(own)).toEqual(["test/a.test.ts"]);
    expect(own.fallbackApplied).toBe(false);
    // Read by no runner: the directory-wide trigger applies.
    expect(sel(run(["vitest.config.ts"], undefined))).toEqual([...tests].sort());
  });
});
