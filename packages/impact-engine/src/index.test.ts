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
