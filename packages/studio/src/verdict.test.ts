import type { RunSummary } from "@smarttest/report-engine";
import { describe, expect, it } from "vitest";
import { runVerdictOf } from "./snapshot.js";

function summary(patch: Partial<RunSummary> = {}): RunSummary {
  return {
    totalTests: 4,
    selected: 2,
    executed: 2,
    skippedBySelection: 2,
    passed: 4,
    failed: 0,
    flaky: 0,
    timedOut: 0,
    cancelled: 0,
    infrastructureErrors: 0,
    skippedByTests: 0,
    cached: 0,
    durationMs: 10,
    ...patch,
  };
}

describe("run verdict", () => {
  it("calls a complete, failure-free run passed", () => {
    expect(runVerdictOf(summary(), 2)).toBe("passed");
  });

  it("never calls a run with integrity issues passed", () => {
    expect(runVerdictOf(summary(), 2, ["summary.passed does not match executions"])).toBe(
      "incomplete",
    );
  });

  it("never calls a cancelled run passed", () => {
    expect(runVerdictOf(summary({ cancelled: 1 }), 2)).toBe("incomplete");
  });

  it("does not call a bail-shortened run passed", () => {
    // `--bail` stops after the first failing group: fewer executions than selected files.
    expect(runVerdictOf(summary({ failed: 1 }), 1)).toBe("failed");
    expect(runVerdictOf(summary({ passed: 1 }), 1)).toBe("incomplete");
  });

  it("separates infrastructure errors from test failures", () => {
    expect(runVerdictOf(summary({ infrastructureErrors: 1 }), 2)).toBe("error");
    expect(runVerdictOf(summary({ failed: 1 }), 2)).toBe("failed");
    expect(runVerdictOf(summary({ timedOut: 1 }), 2)).toBe("failed");
  });

  it("treats a report with no selected files and no failures as passed, not cached", () => {
    expect(
      runVerdictOf(summary({ selected: 0, executed: 0, passed: 0, skippedBySelection: 4 }), 0),
    ).toBe("passed");
  });

  it("never calls a run in which every test came from cache passed (ADR-0009)", () => {
    expect(runVerdictOf(summary({ passed: 0, cached: 4 }), 2)).toBe("cached-pass");
    expect(runVerdictOf(summary({ passed: 1, cached: 3 }), 2)).toBe("passed");
    expect(runVerdictOf(summary({ passed: 0, cached: 4, failed: 1 }), 2)).toBe("failed");
  });
});
