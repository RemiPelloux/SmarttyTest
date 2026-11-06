import type { ImpactDecision } from "@smarttest/shared";
import { describe, expect, it } from "vitest";
import {
  type AnnotationInput,
  ciAnnotations,
  GITHUB_ANNOTATIONS_PER_LEVEL,
  selectionMarkdown,
  timeSavedText,
} from "./annotations.js";
import type { FileExecution } from "./index.js";

function decision(selected: number, skipped: number): ImpactDecision {
  return {
    selectedTests: Array.from({ length: selected }, (_, i) => ({
      testId: `src/s${i}.test.ts`,
      filePath: `src/s${i}.test.ts`,
      reasons: [{ kind: "direct-dependency", message: `imports src/a${i}.ts, which changed` }],
    })),
    skippedTests: Array.from({ length: skipped }, (_, i) => ({
      testId: `src/k${i}.test.ts`,
      filePath: `src/k${i}.test.ts`,
      reasons: [i % 3 ? "no dependency on the changed code" : "the changed code is never imported"],
    })),
    affectedFiles: [],
    affectedSymbols: [],
    analysisStatus: "complete",
    safetyMode: "balanced",
    reasons: [],
    warnings: [],
    fallbackApplied: false,
  };
}

const input = (d: ImpactDecision, extra: Partial<AnnotationInput> = {}): AnnotationInput => ({
  command: "impact",
  decision: d,
  description: "changes since origin/main",
  ...extra,
});

const level = (log: string[], l: string) => log.filter((x) => x.startsWith(`::${l}`)).length;

describe("GitHub annotations", () => {
  it("annotates each selected file with its reason and summarises the files not run", () => {
    const a = ciAnnotations("github", input(decision(2, 5), { pathPrefix: "apps/web/" }));
    expect(a.log).toContain(
      "::notice file=apps/web/src/s0.test.ts,title=SmartTest%3A selected (selection only%2C not run here)::imports src/a0.ts, which changed",
    );
    const skipped = a.log.find((l) => l.includes("not run (skipped by selection)"));
    expect(skipped).toMatch(/5 test files not run: 3 no dependency on the changed code; 2 the/);
    expect(skipped).toMatch(/time saved not measured yet/);
    expect(a.counts).toMatchObject({ notices: 3, errors: 0, warnings: 0 });
  });

  it("never exceeds GitHub's per-level limit: the last notice summarises the rest", () => {
    const a = ciAnnotations("github", input(decision(40, 100)));
    expect(level(a.log, "notice")).toBe(GITHUB_ANNOTATIONS_PER_LEVEL);
    // 8 files, 1 "more", 1 not run.
    expect(a.log.filter((l) => l.includes("title=SmartTest%3A selected"))).toHaveLength(8);
    expect(a.log.some((l) => l.includes("32 more selected test files"))).toBe(true);
    expect(selectionMarkdown(input(decision(40, 100)))).toContain("`src/s39.test.ts`");
  });

  it("reports failing files as errors, bounded too, and the run's verdict", () => {
    const executions: FileExecution[] = Array.from({ length: 14 }, (_, i) => ({
      file: `src/s${i}.test.ts`,
      adapter: "vitest",
      status: "failed",
      durationMs: 1,
      tests: [
        {
          testId: `src/s${i}.test.ts::adds`,
          status: "failed",
          durationMs: 1,
          attempts: 1,
          error: { message: "expected 2\nreceived 3" },
        } as FileExecution["tests"][number],
      ],
    }));
    const a = ciAnnotations("github", input(decision(14, 0), { command: "run", executions }));
    expect(level(a.log, "error")).toBe(GITHUB_ANNOTATIONS_PER_LEVEL);
    expect(a.log[0]).toBe(
      "::error file=src/s0.test.ts,title=SmartTest%3A failed::failed: adds%0Aexpected 2%0Areceived 3",
    );
    expect(a.summary).toContain("❌ 14 failing test files");
  });

  it("escapes workflow-command data so a reason cannot start a command", () => {
    const d = decision(1, 0);
    (d.selectedTests[0] as { reasons: { kind: "rule-match"; message: string }[] }).reasons = [
      { kind: "rule-match", message: "50%\n::error::injected" },
    ];
    const a = ciAnnotations("github", input(d));
    expect(a.log[0]).toMatch(/::50%25%0A::error::injected$/);
    expect(a.log.every((l) => !l.includes("\n"))).toBe(true);
  });

  it("turns warnings and a fallback into warning annotations", () => {
    const d = decision(1, 0);
    d.fallbackApplied = true;
    d.reasons = [{ kind: "fallback", message: "pnpm-lock.yaml settings changed" }];
    d.warnings = ["2 files could not be parsed"];
    const a = ciAnnotations("github", input(d));
    expect(a.log.filter((l) => l.startsWith("::warning"))).toEqual([
      "::warning title=SmartTest::Fallback applied: pnpm-lock.yaml settings changed",
      "::warning title=SmartTest::2 files could not be parsed",
    ]);
  });
});

describe("time saved", () => {
  it("is an estimate from recorded durations, or says it is not measured", () => {
    const d = decision(1, 3);
    expect(timeSavedText(d)).toMatch(/not measured yet/);
    expect(
      timeSavedText(d, { skippedTestTimeMs: 125_000, knownSkipped: 2, totalSkipped: 3 }),
    ).toMatch(/^≈ 2m 5s of test time not run \(estimate from previous runs of 2\/3/);
    expect(timeSavedText(decision(2, 0))).toMatch(/every test file was selected/);
  });
});

describe("GitLab and Bitbucket", () => {
  it("writes a Code Quality report and a collapsible log section", () => {
    const a = ciAnnotations("gitlab", input(decision(3, 2)));
    const report = JSON.parse(a.files["gl-code-quality.json"] as string) as {
      severity: string;
      location: { path: string };
      fingerprint: string;
    }[];
    expect(report).toHaveLength(3);
    expect(report[0]).toMatchObject({ severity: "info", location: { path: "src/s0.test.ts" } });
    expect(new Set(report.map((r) => r.fingerprint)).size).toBe(3);
    expect(a.log[0]).toMatch(/section_start:\d+:smarttest_selection\[collapsed=true\]/);
    expect(a.log.at(-1)).toMatch(/section_end:\d+:smarttest_selection/);
    expect(ciAnnotations("gitlab", input(decision(300, 0))).counts.reportEntries).toBe(100);
  });

  it("writes a Code Insights report; a selection that did not run has no result", () => {
    const a = ciAnnotations(
      "bitbucket",
      input(decision(2, 4), {
        estimate: { skippedTestTimeMs: 60_000, knownSkipped: 4, totalSkipped: 4 },
      }),
    );
    const { report, annotations } = JSON.parse(a.files["bitbucket-insights.json"] as string);
    expect(report.report_type).toBe("TEST");
    expect(report.result).toBeUndefined();
    expect(report.data).toContainEqual({
      title: "Test time not run (estimate)",
      type: "DURATION",
      value: 60_000,
    });
    expect(annotations).toHaveLength(2);
    const ran = JSON.parse(
      ciAnnotations("bitbucket", input(decision(1, 0), { command: "run", executions: [] })).files[
        "bitbucket-insights.json"
      ] as string,
    );
    expect(ran.report.result).toBe("PASSED");
  });
});
