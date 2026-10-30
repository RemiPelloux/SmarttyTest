/**
 * @smarttest/studio — wire contracts between the local server and the browser app.
 *
 * Every figure here is produced by the SmartTest engine (`@smarttest/core`) or read from the
 * project's own `.smarttest/` state. Nothing in these shapes is invented: a count that the app
 * shows is computed from the rows beside it, and a result the engine could not observe is null.
 */
import type { RunSummary } from "@smarttest/report-engine";
import type { ChangeSet, SafetyMode } from "@smarttest/shared";

export const STUDIO_SCHEMA_VERSION = 1;

export interface StudioProject {
  name: string;
  root: string;
  vcs: string;
  packageManager: string;
  node: string;
  mode: SafetyMode;
  runners: { adapter: string; dir: string; configFile: string | null }[];
  workspaces: string[];
}

export interface StudioChangeFile {
  path: string;
  type: "added" | "modified" | "deleted" | "renamed";
  previousPath: string | null;
  kinds: string[];
  units: string[];
  trivialOnly: boolean;
  confidence: string;
  /** Lines the diff marks in the current file; null when the file is gone or was not read. */
  addedLines: number[] | null;
}

export interface StudioChange {
  description: string;
  provider: string;
  completeness: string;
  warnings: string[];
  files: StudioChangeFile[];
}

export interface StudioAnalysisInfo {
  analysedAt: string;
  status: "complete" | "partial" | "fallback";
  mode: SafetyMode;
  requestedMode: SafetyMode | null;
  fallbackApplied: boolean;
  analysisMs: number;
  warnings: string[];
  timings: Record<string, number>;
}

export interface StudioSelectionReason {
  kind: string;
  message: string;
  path: string[] | null;
  confidence: string | null;
  ruleName: string | null;
}

export interface StudioSelectedTest {
  filePath: string;
  testId: string;
  reasons: StudioSelectionReason[];
  /** Shortest path through the graph, in nodes. */
  depth: number;
}

export interface StudioSkippedTest {
  filePath: string;
  reasons: string[];
  confidence: string | null;
}

export interface StudioTraces {
  available: boolean;
  tests: number;
  fresh: number;
  /** Traces that exist but no longer match the current files or environment. */
  stale: number;
  /** Tests that have never been traced; these are not stale evidence. */
  missing: number;
  files: number;
  collectedAt: string | null;
}

export interface StudioCounts {
  files: number;
  units: number;
  selected: number;
  skipped: number;
  total: number;
  unprotected: number;
  uncertain: number;
}

export interface StudioImpact {
  schemaVersion: number;
  project: StudioProject;
  change: StudioChange;
  analysis: StudioAnalysisInfo;
  counts: StudioCounts;
  selected: StudioSelectedTest[];
  skipped: StudioSkippedTest[];
  affectedFiles: string[];
  affectedSymbols: string[];
  unprotected: { file: string; unit: string; tests: string[] }[];
  graphDiff: { file: string; added: string[]; removed: string[] }[];
  uncertainty: { file: string; reasons: string[] }[];
  observedSkips: { test: string; tracedAt: string }[];
  triggers: { file: string; pattern: string }[];
  traces: StudioTraces;
  /** Skipped tests grouped by the first sentence of their reason, largest group first. */
  skippedGroups: { reason: string; count: number }[];
}

export interface StudioOverview {
  schemaVersion: number;
  project: StudioProject;
  updatedAt: string;
  change: StudioChange;
  analysis: StudioAnalysisInfo;
  counts: StudioCounts;
  traces: StudioTraces;
  unprotected: { file: string; unit: string }[];
  observedSkips: number;
  uncertainty: number;
  /** First few selected tests with the reason that reached them — the one finding, named. */
  topSelected: { filePath: string; reason: string; confidence: string | null }[];
  lastRun: StudioRun | null;
  cache: {
    files: number;
    results: number;
    lastCached: number;
    integrityIssues: string[];
  };
  flaky: { count: number; worst: { testId: string; rate: number; recent: string } | null };
}

export type StudioTestResult = {
  status: string;
  durationMs: number;
  at: string;
  tests: number;
  passed: number;
  failed: number;
  cached: number;
  errors: { test: string; message: string }[];
};

export interface StudioTestRow {
  filePath: string;
  adapter: string | null;
  selection: "selected" | "skipped" | null;
  reasons: string[];
  confidence: string | null;
  depth: number | null;
  result: StudioTestResult | null;
  flaky: { rate: number; recent: string; runs: number } | null;
}

export interface StudioTests {
  schemaVersion: number;
  generatedAt: string;
  rows: StudioTestRow[];
  counts: {
    selected: number;
    failed: number;
    cached: number;
    skipped: number;
    flaky: number;
  };
}

export interface StudioRunFile {
  file: string;
  adapter: string;
  status: string;
  durationMs: number;
  tests: number;
  passed: number;
  failed: number;
  cached: number;
  skipped: number;
  error: string | null;
  failures: { test: string; message: string }[];
}

export type StudioRunState = "queued" | "analysing" | "running" | "done" | "failed" | "cancelled";

/** Never call a run passed when a report failed integrity, was cancelled, or did not finish. */
export type StudioRunVerdict = "passed" | "failed" | "error" | "incomplete";

export interface StudioRun {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  state: StudioRunState;
  scope: "affected" | "all" | "file";
  scopeFile: string | null;
  command: string;
  mode: SafetyMode;
  source: string;
  selected: number;
  skippedBySelection: number;
  summary: RunSummary | null;
  coverage: {
    scope: "full" | "selected";
    lines: number;
    branches: number;
    functions: number;
    statements: number;
    files: number;
  } | null;
  executions: StudioRunFile[];
  warnings: string[];
  integrityIssues: string[];
  error: { code: string; message: string; hint: string | null } | null;
}

export type StudioRunEvent =
  | { type: "phase"; at: string; phase: StudioRunState; message: string }
  | {
      type: "selection";
      at: string;
      selected: number;
      skipped: number;
      analysisMs: number;
      analysisStatus: string;
      files: string[];
    }
  | {
      type: "group";
      at: string;
      adapter: string;
      dir: string;
      files: string[];
      phase: "start" | "end";
    }
  | { type: "retry"; at: string; adapter: string; files: string[]; attempt: number }
  | { type: "result"; at: string; execution: StudioRunFile }
  | { type: "summary"; at: string; summary: RunSummary; status: StudioRunVerdict }
  | { type: "done"; at: string; run: StudioRun }
  | { type: "error"; at: string; error: { code: string; message: string; hint: string | null } };

export interface StudioRunStart {
  runId: string;
  run: StudioRun;
}

export interface StudioTrustShadow {
  runs: number;
  missed: number;
  runsWithMisses: number;
  selected: number;
  total: number;
  savedPct: number;
  records: {
    at: string;
    head: string | null;
    mode: string;
    changed: number;
    selected: number;
    total: number;
    missed: number;
    fullMs: number;
    selectedMs: number;
  }[];
}

export interface StudioTrust {
  schemaVersion: number;
  updatedAt: string;
  shadow: StudioTrustShadow | null;
  benchmark: {
    commits: number;
    mode: string;
    fullMs: number;
    smarttestMs: number;
    savedPct: number;
    missed: number;
    cacheViolations: number;
    selectedTests: number;
    totalTests: number;
    at: string;
  } | null;
  flaky: {
    testId: string;
    file: string;
    runs: number;
    flakeRate: number;
    failureRate: number;
    recent: string;
  }[];
  hooks: {
    runs: number;
    medianMs: number;
    slowestMs: number;
    failures: number;
    bypasses: { at: string; stage: string; reason: string }[];
    withoutHook: { checked: number; without: { sha: string; subject: string }[] };
    installedLocally: boolean;
  } | null;
  traces: StudioTraces;
  cache: {
    files: number;
    results: number;
    lastRunCached: number;
    integrityIssues: string[];
  };
  coverage: {
    scope: "full" | "selected";
    lines: number;
    branches: number;
    functions: number;
    statements: number;
    files: number;
    at: string;
  } | null;
}

export interface StudioSourceUnit {
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
  changed: boolean;
  unprotected: boolean;
  observedBy: string[];
}

export interface StudioSource {
  schemaVersion: number;
  path: string;
  language: string;
  exists: boolean;
  lines: { n: number; text: string }[];
  /** Lines added or changed by the current change, in the current file. */
  changedLines: number[];
  units: StudioSourceUnit[];
  traces: { fresh: number; stale: number; missing: number; collectedAt: string | null } | null;
  note: string | null;
}

export interface StudioFileIndex {
  schemaVersion: number;
  files: { path: string; test: boolean; changed: boolean }[];
}

export interface StudioChangeSourceRequest {
  kind: "base" | "staged" | "push" | "uncommitted" | "snapshot";
  ref?: string;
  target?: string;
  direct?: boolean;
}

export interface StudioSessionInfo {
  schemaVersion: number;
  version: string;
  project: string;
  root: string;
  port: number;
}

export interface StudioApiError {
  error: { code: string; message: string; hint: string | null };
}

export type ChangeSetShape = ChangeSet;
