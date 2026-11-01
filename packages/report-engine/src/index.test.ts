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
  it("reports tests left to CI by a hook scope as selected and not run, never passed", () => {
    const r = report();
    r.decision.selectedTests.push({
      testId: "e2e/a.spec.ts",
      filePath: "e2e/a.spec.ts",
      reasons: [{ kind: "direct-dependency" as const, message: "unresolved import" }],
    });
    r.leftToCi = [{ file: "e2e/a.spec.ts", adapter: "playwright", rule: "hook.runners [vitest]" }];
    r.summary = summarize(r.decision, r.executions, 5, 1);
    expect(r.summary.leftToCi).toBe(1);
    expect(r.summary.selected).toBe(2);
    expect(r.summary.passed).toBe(1);
    expect(validateReportIntegrity(r)).toEqual([]);
    expect(toMarkdown(r)).toContain("1 left to CI (not run)");
    expect(toMarkdown(r)).toContain("`e2e/a.spec.ts` — playwright · hook.runners \\[vitest\\]");
    // A file name with a backtick stays inside one code span in the left-to-CI list too.
    const evil = r.leftToCi[0] as NonNullable<RunReport["leftToCi"]>[number];
    evil.file = "e2e/a`](https://evil.example)|b.spec.ts";
    expect(toMarkdown(r)).toContain("- `` e2e/a`](https://evil.example)\\|b.spec.ts `` —");
    evil.file = "e2e/a.spec.ts";
    // Coverage labelled full while a selected file did not run is an integrity violation.
    r.coverage = { scope: "full", lines: 1, statements: 1, functions: 1, branches: 1, files: 1 };
    r.decision.skippedTests = [];
    r.summary = summarize(r.decision, r.executions, 5, 1);
    expect(validateReportIntegrity(r)).toContain(
      "coverage labelled 'full' but 1 selected test file(s) did not run",
    );
    r.leftToCi = [];
    r.summary = summarize(r.decision, r.executions, 5, 0);
    expect(validateReportIntegrity(r)).toEqual([]);
    r.executions.push({
      file: "e2e/a.spec.ts",
      adapter: "x",
      status: "cancelled",
      durationMs: 0,
      tests: [],
    });
    r.summary = summarize(r.decision, r.executions, 5, 0);
    expect(validateReportIntegrity(r)).toContain(
      "coverage labelled 'full' but 1 selected test file(s) did not run",
    );
    r.executions.pop();
    r.decision.skippedTests = report().decision.skippedTests;
    delete r.coverage;
    r.leftToCi = [{ file: "e2e/a.spec.ts", adapter: "playwright", rule: "hook.runners [vitest]" }];
    r.summary = summarize(r.decision, r.executions, 5, 1);
    expect(toHtml(r)).toContain("Selected, not run in the hook (left to CI)");
    // A left-to-CI file with a result, or a count that disagrees, is an integrity violation.
    r.executions.push({
      file: "e2e/a.spec.ts",
      adapter: "playwright",
      status: "passed",
      durationMs: 1,
      tests: [],
    });
    expect(validateReportIntegrity(r)).toContain(
      "e2e/a.spec.ts is left to CI but has an execution record",
    );
    r.executions.pop();
    r.summary.leftToCi = 0;
    expect(validateReportIntegrity(r)).toContain(
      "summary.leftToCi does not match the files left to CI",
    );
  });

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

  it("keeps repository names from injecting markdown into the CI summary (SR-11)", () => {
    const r = report();
    const evil = "a`](https://evil.example)![x](https://t.example/p.png)|b.test.ts";
    r.executions[0] = { ...(r.executions[0] as (typeof r.executions)[number]), file: evil };
    const selected = r.decision.selectedTests[0] as (typeof r.decision.selectedTests)[number];
    selected.filePath = evil;
    selected.reasons = [{ kind: "direct-dependency", message: "[click](https://evil.example)" }];
    const md = toMarkdown(r);
    // The file name stays inside one code span (a longer fence) and cannot split the table row.
    expect(md).toContain(
      "| `` a`](https://evil.example)![x](https://t.example/p.png)\\|b.test.ts `` | failed |",
    );
    expect(md).toContain("\\[click\\]\\(https://evil.example\\)");
    expect(md).not.toMatch(/(^|[^\\])\[click\]\(/m);
  });
});
