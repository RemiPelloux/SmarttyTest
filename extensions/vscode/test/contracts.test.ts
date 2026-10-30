import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  parseCliError,
  parseExplainJson,
  parseGraphDump,
  parseImpactJson,
  parseJsonEnvelope,
  parseRunJson,
  parseScanJson,
} from "../src/core/contracts.js";
import { SmartTestExtensionError } from "../src/core/errors.js";

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8");
}

describe("real CLI fixtures", () => {
  it("parses impact with selected tests and reasons", () => {
    const impact = parseImpactJson(fixture("impact"));
    expect(impact.changeSet.changes).toEqual([{ type: "modified", path: "src/core/Labeler.ts" }]);
    expect(impact.decision.selectedTests.length).toBeGreaterThan(0);
    expect(impact.decision.selectedTests[0]?.reasons[0]?.path).toContain("src/core/Labeler.ts");
    expect(["complete", "partial", "fallback"]).toContain(impact.decision.analysisStatus);
  });

  it("parses a source explanation and a symbol explanation", () => {
    const file = parseExplainJson(fixture("explain-file"));
    expect(file.kind).toBe("source");
    if (file.kind === "source") {
      expect(file.tests.map((hit) => hit.test)).toContain("test/labeler.test.ts");
      expect(file.risk).toBeTruthy();
    }
    const symbol = parseExplainJson(fixture("explain-symbol"));
    expect(symbol.kind).toBe("source");
    if (symbol.kind === "source") expect(symbol.target).toBe("src/core/Labeler.ts#Labeler.label");
  });

  it("parses scan and graph --format json", () => {
    const scan = parseScanJson(fixture("scan"));
    expect(scan.profile.root).toBeTruthy();
    expect(scan.tests.total).toBeGreaterThan(0);
    const graph = parseGraphDump(fixture("graph"));
    expect(graph.nodes.some((node) => node.kind === "method")).toBe(true);
    expect(graph.edges.length).toBeGreaterThan(0);
  });

  it("parses a run report without reclassifying cached or skipped results", () => {
    const result = parseRunJson(fixture("run"));
    expect(result.report.summary.executed).toBe(2);
    expect(result.report.summary.passed).toBe(3);
    expect(result.report.executions.every((execution) => execution.status === "passed")).toBe(true);
    expect(result.integrityIssues).toEqual([]);
  });
});

describe("contract failures are errors, not zeros", () => {
  it("rejects non-JSON and unsupported schema versions", () => {
    expect(() => parseJsonEnvelope("hello")).toThrow(SmartTestExtensionError);
    expect(() =>
      parseJsonEnvelope(JSON.stringify({ schemaVersion: 2, command: "impact" })),
    ).toThrow(/schema version 2/);
  });

  it("rejects a command mismatch", () => {
    expect(() =>
      parseJsonEnvelope(JSON.stringify({ schemaVersion: 1, command: "scan" }), "impact"),
    ).toThrow(/should be "impact"/);
  });

  it("rejects a missing selectedTests array instead of treating it as empty", () => {
    const broken = JSON.parse(fixture("impact")) as {
      decision: { selectedTests?: unknown };
    };
    delete broken.decision.selectedTests;
    expect(() => parseImpactJson(JSON.stringify(broken))).toThrow(/\$.decision\.selectedTests/);
  });

  it("rejects an unknown test status", () => {
    const report = JSON.parse(fixture("run")) as {
      report: { executions: { tests: { status: string }[] }[] };
    };
    const first = report.report.executions[0]?.tests[0];
    if (!first) throw new Error("fixture has no tests");
    first.status = "passed-maybe";
    expect(() => parseRunJson(JSON.stringify(report))).toThrow(/status/);
  });

  it("reads the CLI error envelope", () => {
    expect(
      parseCliError(
        JSON.stringify({
          schemaVersion: 1,
          error: { code: "ST_UNKNOWN_TARGET", category: "usage", message: "no", hint: "check" },
        }),
      ),
    ).toEqual({
      code: "ST_UNKNOWN_TARGET",
      category: "usage",
      message: "no",
      hint: "check",
    });
    expect(parseCliError("not json")).toBeUndefined();
  });
});
