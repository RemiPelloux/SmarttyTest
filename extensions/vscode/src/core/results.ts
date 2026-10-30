/**
 * Read-only summaries of a `smarttest run --affected --json` report. Nothing
 * here reclassifies a test: `cached-pass` stays `cached-pass`, a skipped test is
 * never counted as passed, and `analysisStatus: partial` stays visible.
 */
import type {
  ExplainResult,
  FileExecution,
  RunReport,
  TestExecution,
  TestStatus,
  Uncertainty,
} from "./contracts.js";
import { projectPathKey } from "./symbols.js";

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

/** Counts read from `executions`, so a summary that missed a file cannot hide it. */
interface ExecutionTally {
  /** Test results whose status is `passed` or `flaky`. */
  readonly freshPasses: number;
  readonly failed: number;
  readonly cachedPasses: number;
  readonly cancelled: number;
  /** Files or tests at a status that is neither a pass nor a failure (infrastructure error, timeout, skip, pending). */
  readonly notRun: number;
  readonly infrastructureFiles: readonly FileExecution[];
}

function tally(report: RunReport): ExecutionTally {
  let freshPasses = 0;
  let failed = 0;
  let cachedPasses = 0;
  let cancelled = 0;
  let notRun = 0;
  const infrastructureFiles: FileExecution[] = [];
  const isFailure = (state: ResultState): boolean =>
    state === "failed" || state === "cached-failure";
  const count = (state: ResultState): void => {
    if (state === "passed" || state === "flaky") freshPasses += 1;
    else if (isFailure(state)) failed += 1;
    else if (state === "cached-pass") cachedPasses += 1;
    else if (state === "cancelled") cancelled += 1;
    else notRun += 1;
  };
  for (const file of report.executions) {
    const state = resultState(file.status);
    if (state === "infrastructure-error") infrastructureFiles.push(file);
    for (const test of file.tests) count(resultState(test.status));
    if (file.tests.length === 0) {
      // A file with no test results proves no pass, whatever its status says.
      if (state !== "passed" && state !== "flaky") count(state);
      continue;
    }
    // The tests describe the file, unless the file reports something they do not
    // (an error after the tests, a failing hook, a cancellation).
    if (isFailure(state)) {
      if (!file.tests.some((test) => isFailure(resultState(test.status)))) failed += 1;
    } else if (state === "cancelled") cancelled += 1;
    else if (state !== "passed" && state !== "flaky" && state !== "cached-pass") notRun += 1;
  }
  return { freshPasses, failed, cachedPasses, cancelled, notRun, infrastructureFiles };
}

interface RunCounts {
  readonly tally: ExecutionTally;
  readonly failed: number;
  readonly cancelled: number;
  readonly cached: number;
  readonly infrastructureErrors: number;
}

function runCounts(report: RunReport): RunCounts {
  const summary = report.summary;
  const counted = tally(report);
  return {
    tally: counted,
    failed: Math.max(summary.failed, counted.failed),
    cancelled: Math.max(summary.cancelled, counted.cancelled),
    cached: Math.max(summary.cached, counted.cachedPasses),
    infrastructureErrors: Math.max(
      summary.infrastructureErrors,
      counted.infrastructureFiles.length,
    ),
  };
}

/** What the CLI said about the run besides the report itself. */
export interface RunContext {
  /** `integrityIssues` from the run envelope; the CLI exits 70 when there are any. */
  readonly integrityIssues?: readonly string[];
  readonly exitCode?: number;
}

/**
 * A run is only called passed when every selected test has a fresh `passed`
 * (or `flaky`) result. The verdict reads `executions` as well as `summary`: a
 * file whose runner never started has no tests and may be missing from the
 * summary counts, and it must not turn "0 passed" into a green run. Cached
 * passes, skips, timeouts and infrastructure errors make it incomplete.
 */
export function verdict(report: RunReport, context: RunContext = {}): RunVerdict {
  const summary = report.summary;
  const integrityIssues = context.integrityIssues ?? [];
  // 1 is "tests failed"; any other non-zero exit means the CLI itself reported a problem.
  const abnormalExit =
    context.exitCode !== undefined && context.exitCode !== 0 && context.exitCode !== 1;
  const { tally: counted, failed, cancelled, cached, infrastructureErrors } = runCounts(report);
  const details: string[] = [];
  if (integrityIssues.length > 0)
    details.push(`The report failed SmartTest's integrity check: ${integrityIssues.join("; ")}.`);
  if (abnormalExit) details.push(`smarttest exited with code ${context.exitCode}.`);
  if (report.decision.analysisStatus !== "complete")
    details.push(`Analysis is ${report.decision.analysisStatus}; this is not a full result.`);
  if (report.decision.fallbackApplied)
    details.push("A fallback selection was applied; more tests were run than the graph proved.");
  if (report.warnings.length > 0) details.push(...report.warnings);
  if (cancelled > 0) details.push(`${cancelled} test(s) were cancelled.`);
  if (summary.timedOut > 0) details.push(`${summary.timedOut} test(s) timed out.`);
  if (infrastructureErrors > 0) {
    const first = counted.infrastructureFiles.find((file) => file.error)?.error;
    details.push(
      `${infrastructureErrors} infrastructure error(s); the affected test file(s) did not complete.${
        first ? ` ${first}` : ""
      }`,
    );
  }
  if (summary.skippedByTests > 0)
    details.push(`${summary.skippedByTests} test(s) skipped themselves; they did not pass.`);
  if (cached > 0)
    details.push(`${cached} test result(s) came from the cache; they were not re-run.`);
  if (summary.flaky > 0)
    details.push(`${summary.flaky} test(s) were flaky: they passed only after a retry.`);
  if (summary.skippedBySelection > 0)
    details.push(`${summary.skippedBySelection} test(s) were not selected.`);

  if (cancelled > 0) return { state: "cancelled", headline: "Run cancelled", details };
  if (failed > 0)
    return {
      state: "failed",
      headline: `${failed} of ${summary.executed} executed test(s) failed`,
      details,
    };
  const fresh = summary.passed + summary.flaky;
  const nothingPassed = fresh === 0 && counted.freshPasses === 0;
  if (nothingPassed && cached === 0) {
    if (infrastructureErrors === 0 && counted.notRun === 0)
      details.push("No test reported a result.");
    return {
      state: "incomplete",
      headline:
        infrastructureErrors > 0
          ? `No test ran: ${infrastructureErrors} infrastructure error(s)`
          : "No test passed; the run produced no result",
      details,
    };
  }
  if (
    integrityIssues.length > 0 ||
    abnormalExit ||
    report.decision.analysisStatus !== "complete" ||
    report.decision.fallbackApplied ||
    summary.timedOut > 0 ||
    infrastructureErrors > 0 ||
    summary.skippedByTests > 0 ||
    cached > 0 ||
    counted.notRun > 0
  )
    return {
      state: "incomplete",
      headline: `No failure, but ${summary.executed} executed test(s) are not a complete pass`,
      details,
    };
  return {
    state: "passed",
    headline: `${summary.passed} test(s) passed${summary.flaky > 0 ? ` · ${summary.flaky} flaky` : ""}`,
    details,
  };
}

export function statusBarRunText(report: RunReport, context: RunContext = {}): string {
  const outcome = verdict(report, context);
  const summary = report.summary;
  const { failed, cached } = runCounts(report);
  const flaky = summary.flaky > 0 ? ` · ${summary.flaky} flaky` : "";
  switch (outcome.state) {
    case "passed":
      return `$(pass) ${summary.passed} passed${flaky}`;
    case "failed":
      return `$(error) ${failed} failed`;
    case "cancelled":
      return "$(circle-slash) run cancelled";
    case "incomplete": {
      if (summary.passed + summary.flaky === 0 && cached === 0)
        return "$(warning) no test result · run incomplete";
      return `$(warning) ${summary.passed} passed${flaky}${
        cached > 0 ? ` · ${cached} cached` : ""
      } · result incomplete`;
    }
  }
}

/**
 * Which tests reach one file, from `explain <file>`. `known: false` means
 * SmartTest could not answer; it is never read as "no test reaches the file".
 */
export type FileReach =
  | {
      readonly known: true;
      readonly tests: readonly string[];
      readonly uncertainty: readonly Uncertainty[];
    }
  | { readonly known: false; readonly reason: string };

export function fileReach(result: ExplainResult): FileReach {
  if (result.kind !== "source")
    return { known: false, reason: "smarttest explain answered for a test, not for this file" };
  return {
    known: true,
    tests: [...new Set(result.tests.map((hit) => hit.test))].sort(),
    uncertainty: result.uncertainty,
  };
}

/** The "for this file" sentence: the intersection of the tests reaching the file with the run's selection. */
export function fileRunDetail(
  reach: FileReach,
  report: RunReport,
  platform: NodeJS.Platform = process.platform,
): string {
  const selected = report.decision.selectedTests;
  const ran = `${selected.length} test(s) were selected by the change set and run`;
  if (!reach.known)
    return `SmartTest could not determine which tests reach this file (${reach.reason}); ${ran}.`;
  const reaching = new Set(reach.tests.map((test) => projectPathKey(test, platform)));
  const both = selected.filter(
    (test) =>
      reaching.has(projectPathKey(test.testId, platform)) ||
      reaching.has(projectPathKey(test.filePath, platform)),
  );
  const unresolved = [...new Set(reach.uncertainty.map((item) => item.file))].sort();
  const caveat =
    unresolved.length > 0
      ? ` Code SmartTest could not resolve (${unresolved.slice(0, 3).join(", ")}${
          unresolved.length > 3 ? ", …" : ""
        }) may connect other tests to this file.`
      : "";
  if (both.length > 0) {
    const names = both.slice(0, 5).map((test) => test.testId);
    return `${both.length} of the ${selected.length} selected test(s) reach this file: ${names.join(", ")}${
      both.length > names.length ? ", …" : ""
    }.${caveat}`;
  }
  if (unresolved.length > 0)
    return `SmartTest could not determine whether any selected test reaches this file; ${ran}.${caveat}`;
  if (reach.tests.length > 0)
    return `${reach.tests.length} test file(s) reach this file, but none was selected by this change set; ${ran}.`;
  return `No selected test has a static path to this file; ${ran}.`;
}
