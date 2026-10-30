import { describe, expect, it } from "vitest";
import {
  overallStatus,
  type RunReport,
  summarize,
  TOOL,
  toHtml,
  toJUnit,
  toMarkdown,
  validateReportIntegrity,
} from "./index.js";

function report(): RunReport {
  const decision = {
    selectedTests: [
      {
        testId: "a.test.ts",
        filePath: "a.test.ts",
        reasons: [
          { kind: "direct-dependency" as const, message: "Directly depends on <src/a.ts>" },
        ],
      },
    ],
    skippedTests: [
      { testId: "b.test.ts", filePath: "b.test.ts", reasons: ["No static dependency path"] },
    ],
    affectedFiles: ["src/a.ts"],
    affectedSymbols: [],
    analysisStatus: "complete" as const,
    safetyMode: "balanced" as const,
    reasons: [],
    warnings: [],
    fallbackApplied: false,
  };
  const executions = [
    {
      file: "a.test.ts",
      adapter: "vitest",
      status: "failed" as const,
      durationMs: 5,
      tests: [
        {
          testId: "a.test.ts::works <script>alert(1)</script>",
          status: "passed" as const,
          durationMs: 2,
          attempts: 1,
        },
        {
          testId: "a.test.ts::breaks",
          status: "failed" as const,
          durationMs: 3,
          attempts: 1,
          error: { message: "expected <b>" },
        },
      ],
    },
  ];
  return {
    schemaVersion: 1,
    tool: TOOL,
    runId: "run_1",
    command: "run --affected",
    startedAt: "t0",
    finishedAt: "t1",
    project: "demo",
    mode: "balanced",
    change: {
      description: "git",
      changeSet: {
        provider: "git",
        changes: [{ type: "modified", path: "src/a.ts" }],
        completeness: "complete",
        warnings: [],
      },
    },
    decision,
    executions,
    summary: summarize(decision, executions, 5),
    timings: { analysis: 3 },
    warnings: [],
  };
}

describe("report engine", () => {
  it("never counts skipped-by-selection tests as passed", () => {
    const r = report();
    expect(r.summary.passed).toBe(1);
    expect(r.summary.skippedBySelection).toBe(1);
    expect(validateReportIntegrity(r)).toEqual([]);
  });

  it("counts a file whose runner never started, which has no test records", () => {
    const r = report();
    r.executions.push({
      file: "b.test.ts",
      adapter: "vitest",
      status: "infrastructure-error",
      durationMs: 0,
      tests: [],
      error: "Vitest is not installed",
    });
    r.summary = summarize(r.decision, r.executions, 5);
    expect(r.summary.infrastructureErrors).toBe(1);
    expect(overallStatus(r)).toBe("error");
  });

  it("detects integrity violations", () => {
    const r = report();
    r.executions.push({
      file: "b.test.ts",
      adapter: "vitest",
      status: "passed",
      durationMs: 1,
      tests: [],
    });
    r.summary.passed = 5;
    const issues = validateReportIntegrity(r);
    expect(issues.some((i) => i.includes("skipped by selection but has an execution"))).toBe(true);
    expect(issues.some((i) => i.includes("summary.passed"))).toBe(true);
  });

  it("escapes untrusted content in HTML", () => {
    const html = toHtml(report());
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("prefers-reduced-motion");
    expect(html).toContain("not run");
  });

  it("writes valid-looking JUnit with skipped tests marked as not run", () => {
    const xml = toJUnit(report(), true);
    expect(xml).toContain('<failure message="failed">expected &lt;b&gt;</failure>');
    expect(xml).toContain("not run");
    expect(xml.match(/<testsuite /g)).toHaveLength(2);
  });

  it("writes a compact markdown summary", () => {
    const md = toMarkdown(report());
    expect(md).toContain("1 skipped (not run)");
    expect(md.length).toBeLessThan(65_000);
  });
});
