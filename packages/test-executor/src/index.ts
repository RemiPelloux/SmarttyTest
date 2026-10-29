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
}

export interface ExecuteOptions {
  createAdapter: (group: Group) => TestAdapter;
  timeoutMs?: number;
  retries?: number;
  signal?: AbortSignal;
  workers?: number;
  coverage?: boolean;
  onEvent?: (event: ExecutionEvent) => void;
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

  for (const group of groups) {
    if (options.signal?.aborted) {
      for (const f of group.files)
        results.set(f, {
          file: f,
          adapter: group.adapter,
          status: "cancelled",
          durationMs: 0,
          tests: [],
        });
      continue;
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
      for (const exec of run.executions) {
        const file = fileOfTestId(exec.testId);
        if (!pending.includes(file)) continue; // ignore files the runner matched beyond the selection
        seenFiles.add(file);
        const previous = byId.get(exec.testId);
        if (
          previous &&
          (previous.status === "failed" || previous.status === "timed-out") &&
          exec.status === "passed"
        ) {
          byId.set(exec.testId, {
            ...exec,
            status: "flaky",
            attempts: attempt,
            ...(previous.error ? { error: previous.error } : {}),
          });
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
    for (const f of group.files) {
      const tests = [...byId.values()].filter((e) => fileOfTestId(e.testId) === f);
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
    options.onEvent?.({ type: "group-end", group });
  }
  return {
    files: [...results.values()].sort((a, b) => a.file.localeCompare(b.file)),
    durationMs: performance.now() - started,
    infrastructureErrors: infra,
  };
}
