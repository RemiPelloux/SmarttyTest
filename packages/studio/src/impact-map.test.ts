import { describe, expect, it } from "vitest";
import type { StudioImpact, StudioSelectedTest } from "./contracts.js";
import { impactMapOf, MAX_MAP_PATHS } from "./impact-map.js";
import type { Snapshot } from "./snapshot.js";

function snapshotOf(
  selected: StudioSelectedTest[],
  edges: { from: string; to: string; kind: string; confidence: string }[] = [],
  files = [{ path: "src/a.ts", units: ["A.run"] }],
): Snapshot {
  const impact = {
    change: {
      description: "uncommitted changes",
      files: files.map((f) => ({ ...f, type: "modified", kinds: [], previousPath: null })),
    },
    selected,
    unprotected: [{ file: "src/b.ts", unit: "B" }],
  } as unknown as StudioImpact;
  return {
    createdAt: 0,
    impact,
    analysis: { graph: { toGraph: () => ({ nodes: [], edges }) } },
  } as unknown as Snapshot;
}

const test = (filePath: string, reasons: StudioSelectedTest["reasons"]): StudioSelectedTest => ({
  filePath,
  testId: filePath,
  reasons,
  depth: 0,
});

const reason = (
  kind: string,
  extra: Partial<StudioSelectedTest["reasons"][number]> = {},
): StudioSelectedTest["reasons"][number] => ({
  kind,
  message: kind,
  path: null,
  confidence: null,
  ruleName: null,
  ...extra,
});

describe("impact map", () => {
  it("names each hop by the graph edge behind it, or says it has none", () => {
    const map = impactMapOf(
      snapshotOf(
        [
          test("test/a.test.ts", [
            reason("transitive-dependency", {
              path: ["src/a.ts#A.run", "src/a.ts#A", "src/c.ts#C.go", "src/d.ts", "test/a.test.ts"],
              confidence: "medium",
            }),
          ]),
        ],
        [
          // Graph keys: dependent → dependency, whole-file units as `#*`.
          { from: "src/c.ts#C.go", to: "src/a.ts#A", kind: "CALLS", confidence: "medium" },
          { from: "test/a.test.ts", to: "src/d.ts#*", kind: "TESTS", confidence: "high" },
        ],
      ),
    );
    expect(map.paths).toHaveLength(1);
    expect(map.paths[0]?.edgeKinds).toEqual(["CONTAINS", "CALLS", "UNCLASSIFIED", "TESTS"]);
    expect(map.edges.find((e) => e.kind === "CALLS")?.confidence).toBe("medium");
    expect(map.nodes.find((n) => n.id === "test/a.test.ts")?.role).toBe("test");
    expect(map.nodes.find((n) => n.id === "src/c.ts#C.go")?.role).toBe("affected");
    expect(map.nodes.find((n) => n.id === "src/a.ts#A.run")?.role).toBe("changed");
    expect(map.unreached).toEqual([]);
  });

  it("gives reasons without a graph path an edge from their evidence", () => {
    const map = impactMapOf(
      snapshotOf(
        [
          test("test/rule.test.ts", [reason("rule-match", { ruleName: "auth" })]),
          test("test/traced.test.ts", [
            reason("observed-execution", { message: "Ran src/a.ts when traced (2026-10-30)" }),
          ]),
          test("test/all.test.ts", [reason("fallback", { confidence: "low" })]),
        ],
        [],
        [
          { path: "src/a.ts", units: ["A.run"] },
          { path: "src/b.ts", units: ["B"] },
        ],
      ),
    );
    const byTest = new Map(map.paths.map((p) => [p.test, p]));
    expect(byTest.get("test/rule.test.ts")?.nodes).toEqual([
      "@rule-match:auth",
      "test/rule.test.ts",
    ]);
    expect(byTest.get("test/rule.test.ts")?.edgeKinds).toEqual(["RULE"]);
    expect(map.nodes.find((n) => n.id === "@rule-match:auth")).toMatchObject({
      role: "evidence",
      label: "rule: auth",
    });
    // The trace names the changed file it ran.
    expect(byTest.get("test/traced.test.ts")?.nodes).toEqual(["src/a.ts", "test/traced.test.ts"]);
    expect(byTest.get("test/traced.test.ts")?.edgeKinds).toEqual(["OBSERVED_EXECUTION"]);
    expect(byTest.get("test/all.test.ts")?.confidence).toBe("low");
    expect(map.edgeKinds).toEqual(["FALLBACK", "OBSERVED_EXECUTION", "RULE"]);
    // No path starts at a changed unit, so both are listed as unreached; B has no protecting test.
    expect(map.unreached).toEqual([
      { id: "src/a.ts#A.run", file: "src/a.ts", unit: "A.run", unprotected: false },
      { id: "src/b.ts#B", file: "src/b.ts", unit: "B", unprotected: true },
    ]);
  });

  it("counts every reason but sends a bounded number of paths", () => {
    const many = Array.from({ length: MAX_MAP_PATHS + 5 }, (_, i) =>
      test(`test/t${i}.test.ts`, [
        reason("direct-dependency", { path: ["src/a.ts#A.run", `test/t${i}.test.ts`] }),
      ]),
    );
    const map = impactMapOf(snapshotOf(many));
    expect(map.totalPaths).toBe(MAX_MAP_PATHS + 5);
    expect(map.paths).toHaveLength(MAX_MAP_PATHS);
    expect(map.truncated).toBe(true);
  });
});
