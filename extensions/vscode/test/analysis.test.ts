import { describe, expect, it } from "vitest";
import { analyzeFile, buildFileIndex, fileWarnings } from "../src/core/analysis.js";
import type { GraphDump, ScanResult, SourceExplain } from "../src/core/contracts.js";
import { SmartTestExtensionError } from "../src/core/errors.js";

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

  it("explains all units in one batch call when the CLI supports --units", async () => {
    let perUnit = 0;
    let batches = 0;
    const result = await analyzeFile({
      file: "src/a.ts",
      graph,
      scan: scan(),
      maxUnits: 10,
      concurrency: 2,
      signal,
      explain: async (unit) => {
        perUnit++;
        return source(unit.id, []);
      },
      explainUnits: async (units) => {
        batches++;
        return {
          ...source("src/a.ts", ["test/a.test.ts"]),
          units: units.map((u) => ({
            unit: u.qualifiedName,
            tests:
              u.qualifiedName === "A.run" ? [{ test: "test/a.test.ts", path: ["src/a.ts"] }] : [],
          })),
        };
      },
    });
    expect([batches, perUnit]).toEqual([1, 0]);
    expect(result.protections.map((p) => [p.qualifiedName, p.state])).toEqual([
      ["run", "unprotected"],
      ["A", "unprotected"],
      ["A.run", "protected"],
    ]);
  });

  it("falls back to one explain per unit when the CLI rejects --units", async () => {
    let perUnit = 0;
    const result = await analyzeFile({
      file: "src/a.ts",
      graph,
      scan: scan(),
      maxUnits: 10,
      concurrency: 2,
      signal,
      explain: async (unit) => {
        perUnit++;
        return source(unit.id, ["test/a.test.ts"]);
      },
      explainUnits: async () => {
        throw new SmartTestExtensionError("Unknown option '--units'", {
          code: "ST_USAGE",
          category: "usage",
          cliCode: "ST_USAGE",
        });
      },
    });
    expect(perUnit).toBe(3);
    expect(result.explainFailures).toBe(0);
    expect(result.protections.every((p) => p.state === "protected")).toBe(true);
  });

  it("marks every unit unknown when the batch call fails for another reason", async () => {
    let perUnit = 0;
    const result = await analyzeFile({
      file: "src/a.ts",
      graph,
      scan: scan(),
      maxUnits: 10,
      concurrency: 2,
      signal,
      explain: async (unit) => {
        perUnit++;
        return source(unit.id, ["test/a.test.ts"]);
      },
      explainUnits: async () => {
        throw new SmartTestExtensionError("smarttest explain did not finish within 1000 ms.", {
          code: "ST_EXT_TIMEOUT",
          category: "infrastructure",
        });
      },
    });
    expect(perUnit).toBe(0);
    expect(result.explainFailures).toBe(3);
    expect(result.protections.every((p) => p.state === "unknown")).toBe(true);
    expect(result.protections[0]?.reason).toContain("did not finish");
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

describe("file index", () => {
  it("groups units and warnings per file once per snapshot", async () => {
    const index = buildFileIndex(
      graph,
      scan({
        unresolved: [
          { file: "src/a.ts", specifier: "./x" },
          { file: "src/b.ts", specifier: "./y" },
        ],
        dynamic: [{ file: "./src/a.ts", detail: "import(name)" }],
      }),
      "linux",
    );
    expect(index.units.get("src/a.ts")).toHaveLength(3);
    expect(index.warnings.get("src/a.ts")).toEqual([
      "unresolved import ./x",
      "dynamic import: import(name)",
    ]);
    expect(index.warnings.get("src/b.ts")).toEqual(["unresolved import ./y"]);

    const result = await analyzeFile({
      file: "src/a.ts",
      graph: { nodes: [], edges: [] },
      scan: scan(),
      index,
      maxUnits: 10,
      concurrency: 1,
      signal,
      explain: async (unit) => source(unit.id, ["test/a.test.ts"]),
    });
    // The supplied index is used instead of re-reading graph and scan.
    expect(result.units).toHaveLength(3);
    expect(result.warnings).toEqual(["unresolved import ./x", "dynamic import: import(name)"]);
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
