import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  type ImpactResult,
  parseImpactJson,
  parseRunJson,
  type RunReport,
} from "../src/core/contracts.js";
import {
  changeDescription,
  fileRunDetail,
  fileScope,
  groupFiles,
  groupHasFailure,
  resultState,
  statusBarRunText,
  statusLabel,
  verdict,
} from "../src/core/results.js";

function report() {
  return parseRunJson(readFileSync(new URL("./fixtures/run.json", import.meta.url), "utf8")).report;
}

describe("run results", () => {
  it("keeps cached passes distinct from passes", () => {
    expect(resultState("cached-pass")).toBe("cached-pass");
    expect(statusLabel("cached-pass")).toBe("cached pass (not re-run)");
    expect(statusLabel("passed")).toBe("passed");
  });

  it("groups files and sorts tests", () => {
    const groups = groupFiles(report());
    expect(groups).toHaveLength(2);
    const ids = groups.flatMap((group) => group.tests.map((test) => test.testId));
    expect(ids).toEqual([...ids].sort());
  });

  it("reports a complete run with only fresh passes as passed", () => {
    const value = report();
    // The captured fixture is partial because it was taken in a temporary copy.
    Object.assign(value.decision, { analysisStatus: "complete" });
    const result = verdict(value);
    expect(result.state).toBe("passed");
    expect(result.headline).toContain("3 test(s) passed");
  });

  it("does not call a cached run passed", () => {
    const value = report();
    Object.assign(value.summary, { cached: 1 });
    const result = verdict(value);
    expect(result.state).toBe("incomplete");
    expect(result.details.join(" ")).toContain("cache");
    expect(statusBarRunText(value)).toContain("incomplete");
  });

  it("does not count skipped or timed-out tests as passed", () => {
    const skipped = report();
    Object.assign(skipped.summary, { skippedByTests: 2 });
    expect(verdict(skipped).state).toBe("incomplete");

    const timedOut = report();
    Object.assign(timedOut.summary, { timedOut: 1 });
    expect(verdict(timedOut).state).toBe("incomplete");

    const failed = report();
    Object.assign(failed.summary, { failed: 1 });
    expect(verdict(failed).state).toBe("failed");

    const cancelled = report();
    Object.assign(cancelled.summary, { cancelled: 1 });
    expect(verdict(cancelled).state).toBe("cancelled");
  });

  it("keeps partial analysis visible even when every test passed", () => {
    const value = report();
    Object.assign(value.decision, { analysisStatus: "partial" });
    const result = verdict(value);
    expect(result.state).toBe("incomplete");
    expect(result.details.join(" ")).toContain("partial");
  });

  it("reports a fallback selection as incomplete", () => {
    const value = report();
    Object.assign(value.decision, { fallbackApplied: true });
    expect(verdict(value).state).toBe("incomplete");
  });

  it("does not call a run whose runner never started passed", () => {
    // Vitest missing: each file is an infrastructure error with no tests, and the
    // summary counts nothing but `executed`.
    const value = report();
    Object.assign(value.decision, { analysisStatus: "complete" });
    const broken: RunReport = {
      ...value,
      executions: value.executions.map((file) => ({
        ...file,
        status: "infrastructure-error" as const,
        tests: [],
        error: "Vitest is not installed in /repo",
      })),
      summary: {
        ...value.summary,
        executed: 2,
        passed: 0,
        failed: 0,
        flaky: 0,
        infrastructureErrors: 0,
        cached: 0,
      },
      warnings: ["test/a.test.ts: Vitest is not installed"],
    };
    const result = verdict(broken);
    expect(result.state).toBe("incomplete");
    expect(result.headline).toBe("No test ran: 2 infrastructure error(s)");
    expect(result.details.join(" ")).toContain("Vitest is not installed in /repo");
    expect(statusBarRunText(broken)).not.toContain("passed");
  });

  it("does not call a run with executed tests and no pass passed", () => {
    const value = report();
    Object.assign(value.decision, { analysisStatus: "complete" });
    const empty: RunReport = {
      ...value,
      executions: [],
      summary: { ...value.summary, executed: 1, passed: 0 },
    };
    expect(verdict(empty).state).toBe("incomplete");
    expect(statusBarRunText(empty)).toBe("$(warning) no test result · run incomplete");
  });

  it("reads cached passes and failures from executions when the summary misses them", () => {
    const value = report();
    Object.assign(value.decision, { analysisStatus: "complete" });
    const [first, second] = value.executions;
    if (!first || !second) throw new Error("fixture has two files");
    const cached: RunReport = {
      ...value,
      executions: [
        first,
        {
          ...second,
          status: "cached-pass",
          tests: second.tests.map((test) => ({ ...test, status: "cached-pass" as const })),
        },
      ],
    };
    expect(verdict(cached).state).toBe("incomplete");
    expect(statusBarRunText(cached)).toContain("cached");

    // A file that failed after its tests passed (a hook, a crash) is a failure.
    const hook: RunReport = { ...value, executions: [first, { ...second, status: "failed" }] };
    expect(verdict(hook).state).toBe("failed");
    expect(statusBarRunText(hook)).toBe("$(error) 1 failed");
  });

  it("shows flaky passes explicitly", () => {
    const value = report();
    Object.assign(value.decision, { analysisStatus: "complete" });
    Object.assign(value.summary, { flaky: 1 });
    const result = verdict(value);
    expect(result.state).toBe("passed");
    expect(result.headline).toBe("3 test(s) passed · 1 flaky");
    expect(statusBarRunText(value)).toBe("$(pass) 3 passed · 1 flaky");
  });

  it("never calls a run passed when the CLI reported integrity issues or an abnormal exit", () => {
    const value = report();
    Object.assign(value.decision, { analysisStatus: "complete" });
    expect(verdict(value).state).toBe("passed");
    const integrity = verdict(value, {
      integrityIssues: ["summary.passed mismatch"],
      exitCode: 70,
    });
    expect(integrity.state).toBe("incomplete");
    expect(integrity.details.join(" ")).toContain("summary.passed mismatch");
    expect(verdict(value, { exitCode: 4 }).state).toBe("incomplete");
    expect(statusBarRunText(value, { exitCode: 4 })).toContain("incomplete");
  });
});

describe("results view grouping", () => {
  it("only expands files that contain a failure", () => {
    const [base] = groupFiles(report());
    if (!base) throw new Error("fixture has no file groups");
    expect(groupHasFailure({ ...base, state: "passed", tests: [] })).toBe(false);
    expect(groupHasFailure({ ...base, state: "cached-pass", tests: [] })).toBe(false);
    expect(groupHasFailure({ ...base, state: "failed", tests: [] })).toBe(true);
    expect(
      groupHasFailure({
        ...base,
        state: "flaky",
        tests: [{ testId: "t", status: "timed-out", durationMs: 1, attempts: 1 }],
      }),
    ).toBe(true);
  });
});

describe("run for one file (--only)", () => {
  const impact = (only?: ImpactResult["only"], selected = true): ImpactResult => {
    const value = parseImpactJson(
      readFileSync(new URL("./fixtures/impact.json", import.meta.url), "utf8"),
    );
    return {
      ...value,
      description: `${value.description}${only ? ` · only ${only.paths.join(", ")}` : ""}`,
      decision: { ...value.decision, selectedTests: selected ? value.decision.selectedTests : [] },
      ...(only ? { only } : {}),
    };
  };
  const scope = (over: Partial<NonNullable<ImpactResult["only"]>> = {}) => ({
    paths: ["src/a.ts"],
    matched: ["src/a.ts"],
    unchanged: [],
    excluded: [],
    ...over,
  });

  it("runs when the file's changes select tests", () => {
    expect(fileScope(impact(scope()), "src/a.ts")).toEqual({ kind: "run", scope: scope() });
  });

  it("says the file has no change instead of reporting anything as passed", () => {
    const result = fileScope(
      impact(scope({ matched: [], unchanged: ["src/a.ts"] }), false),
      "src/a.ts",
    );
    expect(result.kind).toBe("unchanged");
    expect(result).toMatchObject({
      message:
        "SmartTest: src/a.ts has no change in git · HEAD…working tree, so no test was selected. Nothing was run; this is not a pass.",
    });
    // Windows paths compare case-insensitively.
    expect(
      fileScope(impact(scope({ matched: [], unchanged: ["SRC/A.ts"] }), false), "src/a.ts", "win32")
        .kind,
    ).toBe("unchanged");
  });

  it("distinguishes a changed file whose change selects nothing", () => {
    const result = fileScope(impact(scope(), false), "src/a.ts");
    expect(result.kind).toBe("nothing-selected");
    expect(result).toMatchObject({ message: expect.stringContaining("this is not a pass") });
  });

  it("refuses to widen to the whole change set when the CLI has no --only", () => {
    const result = fileScope(impact(undefined), "src/a.ts");
    expect(result.kind).toBe("unsupported");
    expect(result).toMatchObject({ message: expect.stringContaining("Nothing was run") });
  });

  it("names the file and the changes it left out", () => {
    const value = report();
    const scoped: RunReport = {
      ...value,
      change: { ...value.change, only: scope({ excluded: ["src/b.ts", "src/c.ts"] }) },
    };
    expect(fileRunDetail(scoped, "src/a.ts")).toBe(
      "2 test(s) selected for the changes in src/a.ts. 2 other changed file(s) were not considered; Run Affected Tests covers the whole change set.",
    );
    expect(fileRunDetail(value, "src/a.ts")).toBe("2 test(s) selected.");
    expect(changeDescription("git · HEAD…working tree · only src/a.ts")).toBe(
      "git · HEAD…working tree",
    );
  });
});
