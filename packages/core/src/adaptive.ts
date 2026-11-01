/**
 * Adaptive policy (`adaptive`): when the whole suite ran faster last time than an analysis
 * usually takes, running everything is both cheaper and complete. Recorded in
 * `.smarttest/state/timings.json`.
 */
import type { TestStatus } from "@smarttest/shared";

export interface AdaptiveTimings {
  /** Recent analysis times (ms), newest last; at most 7. */
  analysisMs?: number[];
  /** Wall time of the last full run that really ran the suite. */
  fullRunMs?: number;
  /** When `fullRunMs` was measured (ISO). Without it, the record has expired. */
  fullRunAt?: string;
  /** Adaptive runs since the last real analysis. */
  adaptiveRuns?: number;
}

/** A full-suite time is trusted this long. */
export const ADAPTIVE_FULL_RUN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * After this many adaptive runs, one real analysis runs again: adaptive runs skip the analysis,
 * so they cannot tell whether it became cheaper than the suite.
 */
export const ADAPTIVE_REFRESH_RUNS = 10;

export function typicalAnalysisMs(t: AdaptiveTimings): number | undefined {
  const a = t.analysisMs;
  return a?.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : undefined;
}

/** Whether the recorded timings say: run everything without analysing. */
export function adaptiveApplies(t: AdaptiveTimings, now = Date.now()): boolean {
  const typical = typicalAnalysisMs(t);
  const age = t.fullRunAt ? now - Date.parse(t.fullRunAt) : Number.NaN;
  return (
    t.fullRunMs !== undefined &&
    typical !== undefined &&
    age >= 0 &&
    age < ADAPTIVE_FULL_RUN_TTL_MS &&
    (t.adaptiveRuns ?? 0) < ADAPTIVE_REFRESH_RUNS &&
    t.fullRunMs < typical
  );
}

const RAN = new Set<TestStatus>(["passed", "failed", "flaky"]);

/**
 * Whether an execution measured the suite: no infrastructure error, nothing cancelled or timed
 * out, not stopped early by `bail` or an abort, and at least one test really executed. A run whose
 * tests could not start takes a few milliseconds and would make every later run adaptive.
 */
export function fullSuiteMeasured(
  summary: {
    files: readonly { status: TestStatus; tests: readonly { status: TestStatus }[] }[];
    infrastructureErrors: readonly string[];
  },
  run: { bail: boolean; aborted: boolean },
): boolean {
  if (run.aborted || summary.infrastructureErrors.length) return false;
  if (
    summary.files.some(
      (f) =>
        f.status === "infrastructure-error" || f.status === "cancelled" || f.status === "timed-out",
    )
  )
    return false;
  // `bail` stops starting groups after a failure: the suite may not have run whole.
  if (run.bail && summary.files.some((f) => f.status === "failed")) return false;
  return summary.files.some((f) => f.tests.some((t) => RAN.has(t.status)));
}

/** The timings to record after a run. */
export function nextAdaptiveTimings(
  recorded: AdaptiveTimings,
  run: { adaptive: boolean; analysisMs: number; fullRun: boolean; fullRunMs: number; at: Date },
): AdaptiveTimings {
  return {
    // An adaptive run did not analyse: its time says nothing about an analysis.
    analysisMs: run.adaptive
      ? (recorded.analysisMs ?? [])
      : [...(recorded.analysisMs ?? []), Math.round(run.analysisMs)].slice(-7),
    ...(run.fullRun
      ? { fullRunMs: Math.round(run.fullRunMs), fullRunAt: run.at.toISOString() }
      : recorded.fullRunMs !== undefined
        ? {
            fullRunMs: recorded.fullRunMs,
            ...(recorded.fullRunAt ? { fullRunAt: recorded.fullRunAt } : {}),
          }
        : {}),
    ...(run.adaptive ? { adaptiveRuns: (recorded.adaptiveRuns ?? 0) + 1 } : {}),
  };
}
