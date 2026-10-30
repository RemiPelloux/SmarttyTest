import { describe, expect, it } from "vitest";
import { analyzeFile, fileWarnings } from "../src/core/analysis.js";
import type { GraphDump, ScanResult, SourceExplain } from "../src/core/contracts.js";

const graph: GraphDump = {
  nodes: [
    { id: "src/a.ts#run", kind: "function", label: "run", filePath: "src/a.ts" },
    { id: "src/a.ts#A", kind: "class", label: "A", filePath: "src/a.ts" },
    { id: "src/a.ts#A.run", kind: "method", label: "run", filePath: "src/a.ts" },
  ],
  edges: [],
};

function scan(overrides: Partial<ScanResult> = {}): ScanResult {
  return {
    profile: { root: "/repo", name: "fixture", runners: [], tests: { testFiles: 1 } },
    vcs: "git",
    index: { files: 1, symbols: 3, imports: 0 },
    graph: { edges: 2, uncertainFiles: 0 },
    tests: { total: 1 },
    unresolved: [],
    dynamic: [],
    ...overrides,
  };
}

function source(target: string, tests: string[]): SourceExplain {
  return {
    kind: "source",
    target,
    description: "",
    tests: tests.map((test) => ({ test, path: ["src/a.ts", test] })),
    uncertainty: [],
    rules: [],
    risk: "low",
  };
}

const signal = new AbortController().signal;

describe("file analysis", () => {
  it("explains every graph unit with bounded concurrency", async () => {
    const result = await analyzeFile({
      file: "src/a.ts",
      graph,
      scan: scan(),
      maxUnits: 10,
      concurrency: 2,
      signal,
      explain: async (unit) =>
        source(unit.id, unit.qualifiedName === "A.run" ? ["test/a.test.ts"] : []),
    });
    expect(result.truncated).toBe(false);
    expect(result.protections.map((p) => [p.qualifiedName, p.state])).toEqual([
      ["run", "unprotected"],
      ["A", "unprotected"],
      ["A.run", "protected"],
    ]);
  });

  it("a single failed explain makes only that symbol unknown", async () => {
    const result = await analyzeFile({
      file: "src/a.ts",
      graph,
      scan: scan(),
      maxUnits: 10,
      concurrency: 2,
      signal,
      explain: async (unit) => {
        if (unit.qualifiedName === "A") throw new Error("explain timed out");
        return source(unit.id, ["test/a.test.ts"]);
      },
    });
    expect(result.explainFailures).toBe(1);
    expect(result.protections.find((p) => p.qualifiedName === "A")?.state).toBe("unknown");
    expect(result.protections.find((p) => p.qualifiedName === "run")?.state).toBe("protected");
  });

  it("returns no partial verdict above maxUnitsPerFile", async () => {
    const result = await analyzeFile({
      file: "src/a.ts",
      graph,
      scan: scan(),
      maxUnits: 2,
      concurrency: 2,
      signal,
      explain: async (unit) => source(unit.id, ["test/a.test.ts"]),
    });
    expect(result.truncated).toBe(true);
    expect(result.protections).toEqual([]);
    expect(result.units).toHaveLength(3);
  });

  it("marks a file with unresolved imports as uncertain through fileWarnings", async () => {
    const result = await analyzeFile({
      file: "src/a.ts",
      graph,
      scan: scan({ unresolved: [{ file: "src/a.ts", specifier: "./generated" }] }),
      maxUnits: 10,
      concurrency: 1,
      signal,
      explain: async (unit) => source(unit.id, ["test/a.test.ts"]),
    });
    expect(result.warnings).toEqual(["unresolved import ./generated"]);
    expect(result.protections.every((p) => p.state === "unknown")).toBe(true);
  });
});

describe("file warnings", () => {
  it("only reports warnings for the requested file", () => {
    expect(
      fileWarnings(
        scan({
          unresolved: [
            { file: "src/a.ts", specifier: "./x" },
            { file: "src/b.ts", specifier: "./y" },
          ],
          dynamic: [{ file: "src/a.ts", detail: "import(name)" }],
        }),
        "src/a.ts",
      ),
    ).toEqual(["unresolved import ./x", "dynamic import: import(name)"]);
  });
});
