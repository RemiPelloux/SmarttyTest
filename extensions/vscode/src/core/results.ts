/**
 * Read-only summaries of a `smarttest run --affected --json` report. Nothing
 * here reclassifies a test: `cached-pass` stays `cached-pass`, a skipped test is
 * never counted as passed, and `analysisStatus: partial` stays visible.
 */
import type {
  ChangeScope,
  FileExecution,
  ImpactResult,
  RunReport,
  TestExecution,
  TestStatus,
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

/** The change description without the ` · only <paths>` suffix `--only` adds. */
export function changeDescription(description: string): string {
  return description.replace(/ · only .*$/, "");
}

/** An older CLI without `--only`: the file command never widens to the whole change set. */
export const ONLY_UNSUPPORTED =
  "SmartTest: this smarttest CLI cannot scope the change set to one file (`--only` needs SmartTest 1.0.0 or later). Nothing was run. Upgrade it, or use Run Affected Tests for the whole change set.";

/**
 * What `impact --only <file>` means for "run the tests for this file": run them, or say why
 * nothing runs. A file with no change is reported as such, never as a pass.
 */
export type FileScope =
  | { readonly kind: "run"; readonly scope: ChangeScope }
  | { readonly kind: "unchanged" | "nothing-selected" | "unsupported"; readonly message: string };

export function fileScope(
  impact: ImpactResult,
  projectPath: string,
  platform: NodeJS.Platform = process.platform,
): FileScope {
  const scope = impact.only;
  if (!scope) return { kind: "unsupported", message: ONLY_UNSUPPORTED };
  if (impact.decision.selectedTests.length > 0) return { kind: "run", scope };
  const key = projectPathKey(projectPath, platform);
  const description = changeDescription(impact.description);
  if (scope.unchanged.some((path) => projectPathKey(path, platform) === key))
    return {
      kind: "unchanged",
      message: `SmartTest: ${projectPath} has no change in ${description}, so no test was selected. Nothing was run; this is not a pass.`,
    };
  return {
    kind: "nothing-selected",
    message: `SmartTest selected no tests for the changes in ${projectPath} (${description}). Nothing was run; this is not a pass.`,
  };
}

/** The "for this file" sentence of a scoped run's notification. */
export function fileRunDetail(report: RunReport, projectPath: string): string {
  const selected = report.decision.selectedTests.length;
  const scope = report.change.only;
  if (!scope) return `${selected} test(s) selected.`;
  const others = scope.excluded.length;
  return `${selected} test(s) selected for the changes in ${projectPath}.${
    others > 0
      ? ` ${others} other changed file(s) were not considered; Run Affected Tests covers the whole change set.`
      : ""
  }`;
}
