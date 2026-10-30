import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseRunJson } from "../src/core/contracts.js";
import {
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
