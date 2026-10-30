/**
 * Read-only summaries of a `smarttest run --affected --json` report. Nothing
 * here reclassifies a test: `cached-pass` stays `cached-pass`, a skipped test is
 * never counted as passed, and `analysisStatus: partial` stays visible.
 */
import type { FileExecution, RunReport, TestExecution, TestStatus } from "./contracts.js";

export type ResultState =
  | "passed"
  | "failed"
  | "flaky"
  | "timed-out"
  | "cancelled"
  | "skipped"
  | "cached-pass"
  | "cached-failure"
  | "infrastructure-error"
  | "pending";

export function resultState(status: TestStatus): ResultState {
  if (status === "passed") return "passed";
  if (status === "failed") return "failed";
  if (status === "flaky") return "flaky";
  if (status === "timed-out") return "timed-out";
  if (status === "cancelled") return "cancelled";
  if (status === "skipped") return "skipped";
  if (status === "cached-pass") return "cached-pass";
  if (status === "cached-failure") return "cached-failure";
  if (status === "infrastructure-error") return "infrastructure-error";
  return "pending";
}

export function statusLabel(status: TestStatus): string {
  const state = resultState(status);
  switch (state) {
    case "cached-pass":
      return "cached pass (not re-run)";
    case "infrastructure-error":
      return "infrastructure error";
    default:
      return state;
  }
}

export function statusIcon(status: TestStatus): string {
  switch (resultState(status)) {
    case "passed":
      return "pass";
    case "failed":
      return "error";
    case "flaky":
      return "warning";
    case "timed-out":
      return "clock";
    case "cancelled":
      return "circle-slash";
    case "skipped":
      return "debug-step-over";
    case "cached-pass":
      return "history";
    case "cached-failure":
      return "error";
    case "infrastructure-error":
      return "alert";
    case "pending":
      return "circle-outline";
  }
}

export interface FileResultGroup {
  readonly file: FileExecution;
  readonly state: ResultState;
  readonly tests: readonly TestExecution[];
}

export function groupFiles(report: RunReport): FileResultGroup[] {
  return report.executions.map((file) => ({
    file,
    state: resultState(file.status),
    tests: [...file.tests].sort((a, b) => a.testId.localeCompare(b.testId)),
  }));
}

/** A file starts expanded in the results view only when something in it went wrong. */
export function groupHasFailure(group: FileResultGroup): boolean {
  const failing = (state: ResultState): boolean =>
    state === "failed" ||
    state === "cached-failure" ||
    state === "timed-out" ||
    state === "infrastructure-error";
  return failing(group.state) || group.tests.some((test) => failing(resultState(test.status)));
}

export interface RunVerdict {
  readonly state: "passed" | "failed" | "incomplete" | "cancelled";
  readonly headline: string;
  readonly details: readonly string[];
}

/**
 * A run is only called passed when every selected test has a fresh `passed`
 * result. Cached passes, skips, timeouts and infrastructure errors make it
 * incomplete, not green.
 */
export function verdict(report: RunReport): RunVerdict {
  const summary = report.summary;
  const details: string[] = [];
  if (report.decision.analysisStatus !== "complete")
    details.push(`Analysis is ${report.decision.analysisStatus}; this is not a full result.`);
  if (report.decision.fallbackApplied)
    details.push("A fallback selection was applied; more tests were run than the graph proved.");
  if (report.warnings.length > 0) details.push(...report.warnings);
  if (summary.cancelled > 0) details.push(`${summary.cancelled} test(s) were cancelled.`);
  if (summary.timedOut > 0) details.push(`${summary.timedOut} test(s) timed out.`);
  if (summary.infrastructureErrors > 0)
    details.push(`${summary.infrastructureErrors} infrastructure error(s).`);
  if (summary.skippedByTests > 0)
    details.push(`${summary.skippedByTests} test(s) skipped themselves; they did not pass.`);
  if (summary.cached > 0) details.push(`${summary.cached} test result(s) came from the cache.`);
  if (summary.skippedBySelection > 0)
    details.push(`${summary.skippedBySelection} test(s) were not selected.`);

  if (summary.cancelled > 0) return { state: "cancelled", headline: "Run cancelled", details };
  if (summary.failed > 0)
    return {
      state: "failed",
      headline: `${summary.failed} of ${summary.executed} executed test(s) failed`,
      details,
    };
  if (
    report.decision.analysisStatus !== "complete" ||
    report.decision.fallbackApplied ||
    summary.timedOut > 0 ||
    summary.infrastructureErrors > 0 ||
    summary.skippedByTests > 0 ||
    summary.cached > 0
  )
    return {
      state: "incomplete",
      headline: `No failure, but ${summary.executed} executed test(s) are not a complete pass`,
      details,
    };
  return {
    state: "passed",
    headline: `${summary.passed} test(s) passed`,
    details,
  };
}

export function statusBarRunText(report: RunReport): string {
  const outcome = verdict(report);
  switch (outcome.state) {
    case "passed":
      return `$(pass) ${report.summary.passed} passed`;
    case "failed":
      return `$(error) ${report.summary.failed} failed`;
    case "cancelled":
      return "$(circle-slash) run cancelled";
    case "incomplete":
      return `$(warning) ${report.summary.passed} passed · result incomplete`;
  }
}
