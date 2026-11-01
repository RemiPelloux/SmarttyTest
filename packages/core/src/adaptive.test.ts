import type { TestStatus } from "@smarttest/shared";
import { describe, expect, it } from "vitest";
import {
  ADAPTIVE_FULL_RUN_TTL_MS,
  ADAPTIVE_REFRESH_RUNS,
  type AdaptiveTimings,
  adaptiveApplies,
  fullSuiteMeasured,
  nextAdaptiveTimings,
} from "./adaptive.js";

const file = (status: TestStatus, tests: TestStatus[] = [status]) => ({
  status,
  tests: tests.map((s) => ({ status: s })),
});
const summary = (files: ReturnType<typeof file>[], infrastructureErrors: string[] = []) => ({
  files,
  infrastructureErrors,
});
const clean = { bail: false, aborted: false };

describe("adaptive policy", () => {
  it("does not take a run whose tests could not start as the full-suite time", () => {
    // Audit: 1,200 tests failing to start (runner not installed) recorded fullRunMs: 3.
    expect(fullSuiteMeasured(summary([file("infrastructure-error")]), clean)).toBe(false);
    expect(fullSuiteMeasured(summary([file("passed")], ["vitest not found"]), clean)).toBe(false);
    expect(fullSuiteMeasured(summary([file("passed"), file("cancelled")]), clean)).toBe(false);
    expect(fullSuiteMeasured(summary([file("timed-out")]), clean)).toBe(false);
    expect(fullSuiteMeasured(summary([file("passed")]), { bail: false, aborted: true })).toBe(
      false,
    );
    // `bail` after a failure may have stopped the suite early.
    expect(fullSuiteMeasured(summary([file("failed")]), { bail: true, aborted: false })).toBe(
      false,
    );
    // Nothing executed (every test skipped) measures nothing.
    expect(fullSuiteMeasured(summary([file("skipped")]), clean)).toBe(false);
    expect(fullSuiteMeasured(summary([]), clean)).toBe(false);
    expect(fullSuiteMeasured(summary([file("passed"), file("failed")]), clean)).toBe(true);
    expect(fullSuiteMeasured(summary([file("passed")]), { bail: true, aborted: false })).toBe(true);
  });

  it("recovers from a full-suite time that made every run adaptive", () => {
    const now = Date.parse("2026-11-01T12:00:00Z");
    let t: AdaptiveTimings = {
      analysisMs: [400, 410, 420],
      fullRunMs: 3,
      fullRunAt: new Date(now).toISOString(),
    };
    // Every adaptive run whose suite fails to start leaves the bad time as it was, but counts.
    let adaptiveRuns = 0;
    while (adaptiveApplies(t, now)) {
      adaptiveRuns++;
      t = nextAdaptiveTimings(t, {
        adaptive: true,
        analysisMs: 1,
        fullRun: false,
        fullRunMs: 3,
        at: new Date(now),
      });
      expect(t.analysisMs).toEqual([400, 410, 420]);
    }
    // After a bounded number of adaptive runs, a real analysis runs and is recorded.
    expect(adaptiveRuns).toBe(ADAPTIVE_REFRESH_RUNS);
    t = nextAdaptiveTimings(t, {
      adaptive: false,
      analysisMs: 380,
      fullRun: false,
      fullRunMs: 0,
      at: new Date(now),
    });
    expect(t.analysisMs).toEqual([400, 410, 420, 380]);
    expect(t.adaptiveRuns).toBeUndefined();
    // A record from before `fullRunAt` existed, or an old one, has expired.
    expect(adaptiveApplies({ analysisMs: [400], fullRunMs: 3 }, now)).toBe(false);
    expect(
      adaptiveApplies(
        {
          analysisMs: [400],
          fullRunMs: 3,
          fullRunAt: new Date(now - ADAPTIVE_FULL_RUN_TTL_MS - 1).toISOString(),
        },
        now,
      ),
    ).toBe(false);
  });

  it("records a measured full run with its time, and keeps it otherwise", () => {
    const at = new Date("2026-11-01T12:00:00Z");
    const measured = nextAdaptiveTimings(
      { analysisMs: [300] },
      { adaptive: false, analysisMs: 320.4, fullRun: true, fullRunMs: 150.6, at },
    );
    expect(measured).toEqual({
      analysisMs: [300, 320],
      fullRunMs: 151,
      fullRunAt: at.toISOString(),
    });
    expect(adaptiveApplies(measured, at.getTime())).toBe(true);
    const kept = nextAdaptiveTimings(measured, {
      adaptive: true,
      analysisMs: 2,
      fullRun: false,
      fullRunMs: 0,
      at: new Date(at.getTime() + 1000),
    });
    expect(kept).toEqual({ ...measured, adaptiveRuns: 1 });
  });
});
