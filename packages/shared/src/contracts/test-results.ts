/** Result statuses (spec §15.5). Cached results must never appear as fresh executions. */
export type TestStatus =
  | "passed"
  | "failed"
  | "skipped"
  | "pending"
  | "cancelled"
  | "timed-out"
  | "cached-pass"
  | "cached-failure"
  | "flaky"
  | "infrastructure-error";

export interface TestCase {
  id: string;
  filePath: string;
  suitePath: string[];
  name: string;
  tags: string[];
}

export interface TestSelection {
  files: string[];
  /** Only honoured when the adapter declares testCaseSelection support. */
  testIds?: string[];
}

export interface ExecutionOptions {
  workers?: number;
  timeoutMs?: number;
  retries?: number;
  coverage?: boolean;
  signal?: AbortSignal;
  /** Extra environment variables for the runner process. */
  env?: Record<string, string>;
  /** Run so that per-process V8 coverage can be written (Vitest: worker threads instead of forks). */
  trace?: boolean;
}

export interface TestExecution {
  testId: string;
  status: TestStatus;
  durationMs: number;
  attempts: number;
  error?: { message: string; stack?: string };
  /** Files the runner produced for this test (Playwright traces, screenshots, videos). */
  artifacts?: { name: string; path: string }[];
}

export interface TestRunResult {
  adapter: string;
  executions: TestExecution[];
  startedAt: string;
  finishedAt: string;
}
