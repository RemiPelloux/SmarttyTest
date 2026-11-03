/**
 * @smarttest/test-executor — runs execution groups through adapters with timeouts, cancellation and
 * retries. Statuses are honest: a pass after a retry is "flaky", a crash is "infrastructure-error"
 * (spec §15.5–15.6).
 */

import { fileOfTestId } from "@smarttest/plugin-sdk";
import type { TestAdapter, TestExecution, TestStatus } from "@smarttest/shared";

export interface Group {
  adapter: string;
  dir: string;
  files: string[];
}

export interface FileResult {
  file: string;
  adapter: string;
  status: TestStatus;
  durationMs: number;
  tests: TestExecution[];
  error?: string;
}

export interface ExecutionEvent {
  type: "group-start" | "group-end" | "retry";
  group: Group;
  attempt?: number;
  files?: string[];
  /** On `group-end`: the group's file results, so callers can show them before the run ends. */
  results?: FileResult[];
}

export interface ExecuteOptions {
  createAdapter: (group: Group) => TestAdapter;
  timeoutMs?: number;
  retries?: number;
  signal?: AbortSignal;
  workers?: number;
  coverage?: boolean;
  onEvent?: (event: ExecutionEvent) => void;
  /**
   * Runner groups executed at the same time (default 1). Groups whose adapter is in `exclusive`
   * (end-to-end runners that start servers) always run alone.
   */
  concurrency?: number;
  exclusive?: readonly string[];
  /** Stop starting new groups after a group with a failure; groups not started are "cancelled". */
  bail?: boolean;
}

export interface ExecutionSummary {
  files: FileResult[];
  durationMs: number;
  infrastructureErrors: string[];
}

const RANK: TestStatus[] = [
  "passed",
  "skipped",
  "pending",
  "cached-pass",
  "flaky",
  "cancelled",
  "timed-out",
  "failed",
  "cached-failure",
  "infrastructure-error",
];

/** Statuses that fail a run. */
const FAILING = new Set<TestStatus>(["failed", "timed-out", "cancelled", "infrastructure-error"]);

export function aggregateStatus(tests: readonly TestExecution[]): TestStatus {
  if (!tests.length) return "skipped";
  let worst: TestStatus = "passed";
  let allSkipped = true;
  for (const t of tests) {
    if (t.status !== "skipped" && t.status !== "pending") allSkipped = false;
    if (RANK.indexOf(t.status) > RANK.indexOf(worst)) worst = t.status;
  }
  if (allSkipped) return "skipped";
  return worst === "skipped" || worst === "pending" ? "passed" : worst;
}

export async function executeGroups(
  groups: readonly Group[],
  options: ExecuteOptions,
): Promise<ExecutionSummary> {
  const started = performance.now();
  const results = new Map<string, FileResult>();
  const infra: string[] = [];

  let failedGroup = false;
  const runGroup = async (group: Group): Promise<void> => {
    if (options.signal?.aborted || (options.bail && failedGroup)) {
      for (const f of group.files)
        results.set(f, {
          file: f,
          adapter: group.adapter,
          status: "cancelled",
          durationMs: 0,
          tests: [],
        });
      return;
    }
    options.onEvent?.({ type: "group-start", group });
    const adapter = options.createAdapter(group);
    const groupStart = performance.now();
    const byId = new Map<string, TestExecution>();
    let pending = [...group.files];
    const maxAttempts = 1 + Math.max(0, options.retries ?? 0);
    for (let attempt = 1; attempt <= maxAttempts && pending.length; attempt++) {
      if (attempt > 1) options.onEvent?.({ type: "retry", group, attempt, files: pending });
      let run: Awaited<ReturnType<TestAdapter["execute"]>> & {
        meta?: {
          exitCode?: number | null;
          timedOut?: boolean;
          cancelled?: boolean;
          stderr?: string;
          /** Errors the runner reported outside every test (Playwright `errors`, Jest `runExecError`). */
          runErrors?: string[];
          /** The tail of the runner's console output, quoted when the run failed outside any test. */
          output?: string;
        };
      };
      try {
        run = await adapter.execute(
          { files: pending },
          {
            ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
            ...(options.signal ? { signal: options.signal } : {}),
            ...(options.workers ? { workers: options.workers } : {}),
            coverage: !!options.coverage && attempt === 1,
          },
        );
      } catch (error) {
        const message = (error as Error).message;
        infra.push(`${group.adapter} (${group.dir || "."}): ${message}`);
        for (const f of pending)
          if (!results.has(f))
            results.set(f, {
              file: f,
              adapter: group.adapter,
              status: "infrastructure-error",
              durationMs: 0,
              tests: [],
              error: message,
            });
        pending = [];
        break;
      }
      const meta = run.meta ?? {};
      const seenFiles = new Set<string>();
      // Duplicate test names are legal (Vitest, Jest, Cypress; `it.each` rows whose title has no
      // placeholder): two results with the same id inside ONE attempt are two tests, never a
      // retry. Each keeps its own identity: the second is `<id> (2)`, the third `<id> (3)`, so
      // reports, the result cache and flaky history count every row. A retry reports them in the
      // same order, so a row keeps its number across attempts.
      const thisAttempt = new Map<string, TestExecution>();
      const occurrences = new Map<string, number>();
      // Failures in files the runner ran beyond the selection (a Playwright setup project, a file
      // its config adds): they are not this selection's tests, but the run failed, so they block it.
      const outside: TestExecution[] = [];
      const pendingSet = new Set(pending);
      for (const exec of run.executions) {
        const file = fileOfTestId(exec.testId);
        if (!pendingSet.has(file)) {
          if (FAILING.has(exec.status) && exec.status !== "cancelled") outside.push(exec);
          continue; // a passing result of a file beyond the selection is not reported
        }
        seenFiles.add(file);
        const n = (occurrences.get(exec.testId) ?? 0) + 1;
        occurrences.set(exec.testId, n);
        let id = n === 1 ? exec.testId : `${exec.testId} (${n})`;
        // A test really named `x (2)` beside two `x`: never merge two results into one id.
        while (n > 1 && thisAttempt.has(id)) id = `${id}'`;
        thisAttempt.set(id, id === exec.testId ? exec : { ...exec, testId: id });
      }
      for (const exec of thisAttempt.values()) {
        // Only a pass in a LATER attempt of the same test turns a failure into flaky.
        const previous = byId.get(exec.testId);
        const previousFailed =
          previous && (previous.status === "failed" || previous.status === "timed-out");
        if (previousFailed && (exec.status === "passed" || exec.status === "flaky")) {
          byId.set(exec.testId, {
            ...exec,
            status: "flaky",
            attempts: attempt,
            ...(previous.error ? { error: previous.error } : {}),
          });
        } else if (previousFailed && RANK.indexOf(exec.status) < RANK.indexOf(previous.status)) {
          // A retry that skips the test or does not run it (a hook failed, the test skipped
          // itself) proves nothing: the failure stands.
          byId.set(exec.testId, { ...previous, attempts: attempt });
        } else {
          byId.set(exec.testId, { ...exec, attempts: attempt });
        }
      }
      for (const f of pending) {
        if (seenFiles.has(f)) continue;
        const status: TestStatus = meta.cancelled
          ? "cancelled"
          : meta.timedOut
            ? "timed-out"
            : "infrastructure-error";
        const message = meta.timedOut
          ? `Timed out after ${options.timeoutMs} ms`
          : meta.cancelled
            ? "Cancelled"
            : (meta.stderr || "Runner produced no result for this file").trim().slice(0, 2000);
        byId.set(`${f}::(suite)`, {
          testId: `${f}::(suite)`,
          status,
          durationMs: 0,
          attempts: attempt,
          error: { message },
        });
        if (status === "infrastructure-error" && attempt === 1)
          infra.push(`${group.adapter}: no result for ${f}`);
      }
      // A run that failed outside every test (an unhandled error, a failing global teardown or
      // setup project, a non-zero exit with nothing failed) fails each file of this attempt: none
      // of them can be reported as passed (§32.2).
      const runFailures = outside.map((e) => {
        const at = e.testId.indexOf("::");
        const where = at === -1 ? e.testId : `${e.testId.slice(0, at)} › ${e.testId.slice(at + 2)}`;
        const detail = e.error?.message ? `:\n${e.error.message}` : "";
        return `${where} failed in this run (not selected, but the runner ran it: a setup project, a dependency or a file its config adds)${detail}`;
      });
      const failedInAttempt =
        outside.length > 0 ||
        pending.some((f) => !seenFiles.has(f)) ||
        [...thisAttempt.values()].some((e) => FAILING.has(e.status));
      if (!meta.timedOut && !meta.cancelled && !failedInAttempt) {
        const errors = (meta.runErrors ?? []).map((e) => e.trim()).filter(Boolean);
        if (errors.length)
          runFailures.push(
            `${group.adapter} reported an error outside any test:\n${errors.join("\n")}`,
          );
        else if (typeof meta.exitCode === "number" && meta.exitCode !== 0)
          runFailures.push(
            `${group.adapter} exited with code ${meta.exitCode} although no test failed: an error outside any test (an unhandled error, a failing hook, global setup or teardown)`,
          );
      }
      const output = meta.output?.trim();
      for (const f of pending) {
        if (!seenFiles.has(f)) continue;
        const id = `${f}::(run)`;
        const previous = byId.get(id);
        if (runFailures.length) {
          const message = `${runFailures.join("\n\n")}${output ? `\n\nRunner output:\n${output}` : ""}`;
          byId.set(id, {
            testId: id,
            status: "failed",
            durationMs: 0,
            attempts: attempt,
            error: { message: message.slice(0, 4000) },
          });
        } else if (previous?.status === "failed") {
          // The run-level failure did not come back on the retry.
          byId.set(id, { ...previous, status: "flaky", attempts: attempt });
        }
      }
      if (meta.cancelled || meta.timedOut) break;
      pending = [
        ...new Set(
          [...byId.values()]
            .filter((e) => e.status === "failed")
            .map((e) => fileOfTestId(e.testId)),
        ),
      ];
    }
    const groupDuration = performance.now() - groupStart;
    // Each file's executions, in the order they were recorded (one pass, not one per file).
    const byFile = new Map<string, TestExecution[]>();
    for (const e of byId.values()) {
      const file = fileOfTestId(e.testId);
      const list = byFile.get(file);
      if (list) list.push(e);
      else byFile.set(file, [e]);
    }
    for (const f of group.files) {
      const tests = byFile.get(f) ?? [];
      if (!results.has(f)) {
        const status = aggregateStatus(tests);
        const failing = tests.find((t) => t.error);
        results.set(f, {
          file: f,
          adapter: group.adapter,
          status,
          durationMs:
            tests.reduce((a, t) => a + t.durationMs, 0) || groupDuration / group.files.length,
          tests,
          ...(failing?.error ? { error: failing.error.message } : {}),
        });
      }
    }
    const inGroup = new Set(group.files);
    if (
      [...results.values()].some(
        (r) => inGroup.has(r.file) && (r.status === "failed" || r.status === "timed-out"),
      )
    )
      failedGroup = true;
    options.onEvent?.({
      type: "group-end",
      group,
      results: group.files.flatMap((f) => results.get(f) ?? []),
    });
  };
  const exclusive = new Set(options.exclusive ?? []);
  const shared = groups.filter((g) => !exclusive.has(g.adapter));
  const alone = groups.filter((g) => exclusive.has(g.adapter));
  const limit = Math.max(1, options.concurrency ?? 1);
  const queue = [...shared];
  await Promise.all(
    Array.from({ length: Math.min(limit, queue.length) }, async () => {
      for (let g = queue.shift(); g; g = queue.shift()) await runGroup(g);
    }),
  );
  for (const g of alone) await runGroup(g);
  return {
    files: [...results.values()].sort((a, b) => a.file.localeCompare(b.file)),
    durationMs: performance.now() - started,
    infrastructureErrors: infra,
  };
}
