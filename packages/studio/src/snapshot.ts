/**
 * Builds the Studio's read models from one real analysis of the project's current change.
 *
 * The snapshot is the single source of truth for a refresh: overview, impact, tests and trust all
 * read the same `Analysis`, so a number on one screen always matches the rows on another. Nothing
 * is recomputed per request and nothing is invented when data is missing.
 */
import { open, realpath } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { Analysis, FlakyEntry, SmartTest } from "@smarttest/core";
import type { ProjectProfile } from "@smarttest/project-detector";
import type { RunReport, RunSummary } from "@smarttest/report-engine";
import { mapLimit, readJson, type SafetyMode } from "@smarttest/shared";
import { type SymbolRecord, unitOf } from "@smarttest/source-parser";
import type {
  StudioChange,
  StudioChangeFile,
  StudioCounts,
  StudioFileIndex,
  StudioImpact,
  StudioOverview,
  StudioProject,
  StudioRun,
  StudioRunFile,
  StudioRunVerdict,
  StudioSelectionReason,
  StudioSource,
  StudioSourceUnit,
  StudioTestRow,
  StudioTests,
  StudioTraces,
  StudioTrust,
} from "./contracts.js";
import { type LineDiff, lineDiff } from "./line-diff.js";

interface TraceViewLike {
  readonly size: number;
  isFresh(test: string): boolean;
  trace(test: string): { at: string; executed: Record<string, string[]> } | undefined;
  collectedAt(test: string): string | undefined;
}

export interface Snapshot {
  createdAt: number;
  profile: ProjectProfile;
  analysis: Analysis;
  impact: StudioImpact;
  view: TraceViewLike | undefined;
  /** Test → file → function names V8 observed in a fresh trace. */
  observed: Map<string, Set<string>>;
  diffs: Map<string, LineDiff>;
  coverage: { runAt: string; summary: RunReport["coverage"] } | null;
}

/** One `smarttest.config.ts` mode, shown wherever a decision is explained. */
export function projectOf(st: SmartTest, profile: ProjectProfile): StudioProject {
  const mode = st.config.mode as SafetyMode;
  return {
    name: profile.name || "project",
    root: profile.root,
    vcs: profile.vcs.provider,
    packageManager: profile.packageManager.name,
    node: profile.runtime.node ?? process.versions.node,
    mode,
    runners: profile.runners.map((r) => ({
      adapter: r.adapter,
      dir: r.dir,
      configFile: r.configFile ?? null,
    })),
    workspaces: profile.workspaces.map((w) => w.dir || "."),
  };
}

function filesOfChange(a: Analysis): StudioChangeFile[] {
  const out: StudioChangeFile[] = [];
  for (const change of a.input.changeSet.changes) {
    const diff = a.diffs.get(change.path);
    const units = diff?.units.length
      ? diff.units
      : (a.index.get(change.path)?.symbols ?? [])
          .map(unitOf)
          .filter((u, i, all) => all.indexOf(u) === i);
    out.push({
      path: change.path,
      type: change.type,
      previousPath: change.previousPath ?? null,
      kinds: diff ? [...new Set(diff.changes.map((c) => c.kind))] : [change.type],
      units: units.length ? units : ["*"],
      trivialOnly: diff?.trivialOnly ?? false,
      confidence: diff?.confidence ?? "low",
      addedLines: null,
    });
  }
  out.sort((x, y) => x.path.localeCompare(y.path));
  return out;
}

function reasonDto(r: {
  kind: string;
  message: string;
  path?: string[];
  confidence?: string;
  ruleName?: string;
}): StudioSelectionReason {
  return {
    kind: r.kind,
    message: r.message,
    path: r.path ?? null,
    confidence: r.confidence ?? null,
    ruleName: r.ruleName ?? null,
  };
}

function depthOf(reasons: StudioSelectionReason[]): number {
  let depth = 0;
  for (const r of reasons) if (r.path && r.path.length > depth) depth = r.path.length;
  return depth;
}

function tracesOf(a: Analysis, view: TraceViewLike | undefined): StudioTraces {
  if (!view || view.size === 0)
    return {
      available: false,
      tests: a.testFiles.length,
      fresh: 0,
      stale: 0,
      missing: a.testFiles.length,
      files: 0,
      collectedAt: null,
    };
  let fresh = 0;
  let stale = 0;
  let missing = 0;
  let collectedAt = 0;
  const files = new Set<string>();
  for (const test of a.testFiles) {
    const trace = view.trace(test);
    if (!trace) {
      missing++;
      continue;
    }
    if (!view.isFresh(test)) {
      stale++;
      continue;
    }
    fresh++;
    const at = view.collectedAt(test);
    if (at) collectedAt = Math.max(collectedAt, Date.parse(at));
    for (const file of Object.keys(trace.executed)) files.add(file);
  }
  return {
    available: true,
    tests: a.testFiles.length,
    fresh,
    stale,
    missing,
    files: files.size,
    collectedAt: collectedAt ? new Date(collectedAt).toISOString() : null,
  };
}

function observedIndex(a: Analysis, view: TraceViewLike | undefined): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  if (!view) return map;
  for (const test of a.testFiles) {
    if (!view.isFresh(test)) continue;
    const executed = view.trace(test)?.executed ?? {};
    for (const [file, names] of Object.entries(executed)) {
      const set = map.get(file) ?? new Set<string>();
      for (const name of names) set.add(`${test}\u0000${name}`);
      map.set(file, set);
    }
  }
  return map;
}

export interface ProjectFileRead {
  text: string;
  /** True when the file is larger than `maxBytes` and only its head was read. */
  truncated: boolean;
}

/**
 * Reads a project file that resolves (through symlinks) inside the project, at most `maxBytes`
 * of it. `realRoot` lets a caller reading many files resolve the root once.
 */
export async function readProjectFileHead(
  root: string,
  path: string,
  options: { realRoot?: string; maxBytes?: number } = {},
): Promise<ProjectFileRead | null> {
  const abs = safeProjectPath(root, path);
  if (!abs) return null;
  try {
    const [realRoot, realFile] = await Promise.all([
      options.realRoot ?? realpath(root),
      realpath(abs),
    ]);
    if (!realFile.startsWith(`${realRoot}${sep}`)) return null;
    const handle = await open(realFile, "r");
    try {
      const info = await handle.stat();
      if (!info.isFile()) return null;
      const maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY;
      if (info.size <= maxBytes) return { text: await handle.readFile("utf8"), truncated: false };
      const buffer = Buffer.alloc(maxBytes);
      const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
      // A cut through a multi-byte character decodes to U+FFFD; drop it rather than show it.
      const text = buffer
        .subarray(0, bytesRead)
        .toString("utf8")
        .replace(/\uFFFD+$/, "");
      return { text, truncated: true };
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

export async function readProjectFile(
  root: string,
  path: string,
  realRoot?: string,
): Promise<string | null> {
  return (await readProjectFileHead(root, path, realRoot ? { realRoot } : {}))?.text ?? null;
}

export async function buildSnapshot(
  st: SmartTest,
  view: TraceViewLike | undefined,
  coverage: Snapshot["coverage"],
  analysed?: Analysis,
): Promise<Snapshot> {
  const started = performance.now();
  const profile = await st.profile();
  const analysis = analysed ?? (await st.analyze());
  const decision = analysis.decision;
  const changeFiles = filesOfChange(analysis);
  const diffs = new Map<string, LineDiff>();
  const realRoot = await realpath(analysis.root).catch(() => undefined);
  await mapLimit(changeFiles, 8, async (file) => {
    const [after, before] = await Promise.all([
      realRoot === undefined ? null : readProjectFile(analysis.root, file.path, realRoot),
      // An added file has no base; a renamed one is read from where it used to be.
      file.type === "added" ? undefined : analysis.input.readBefore(file.previousPath ?? file.path),
    ]);
    const diff = lineDiff(before, after ?? "");
    diffs.set(file.path, diff);
    file.addedLines = diff.added;
  });
  const units = changeFiles.reduce((n, f) => n + f.units.length, 0);
  const traces = tracesOf(analysis, view);
  const counts: StudioCounts = {
    files: changeFiles.length,
    units,
    selected: decision.selectedTests.length,
    skipped: decision.skippedTests.length,
    total: analysis.testFiles.length,
    unprotected: decision.details.unprotected?.length ?? 0,
    uncertain: decision.details.uncertainty.length,
  };
  const skippedGroups = new Map<string, number>();
  for (const t of decision.skippedTests) {
    for (const reason of t.reasons.length ? t.reasons : ["no reason recorded"]) {
      const key = reason.split(/(?<=\.)\s/)[0] ?? reason;
      skippedGroups.set(key, (skippedGroups.get(key) ?? 0) + 1);
    }
  }
  const change: StudioChange = {
    description: analysis.input.description,
    provider: analysis.input.changeSet.provider,
    completeness: analysis.input.changeSet.completeness,
    warnings: analysis.input.changeSet.warnings,
    files: changeFiles,
  };
  const impact: StudioImpact = {
    schemaVersion: 1,
    project: projectOf(st, profile),
    change,
    analysis: {
      analysedAt: new Date().toISOString(),
      status: decision.analysisStatus,
      mode: decision.safetyMode,
      requestedMode: decision.requestedMode ?? null,
      fallbackApplied: decision.fallbackApplied,
      analysisMs: Math.round(analysis.timings.total ?? performance.now() - started),
      warnings: decision.warnings,
      timings: analysis.timings,
    },
    counts,
    selected: decision.selectedTests
      .map((t) => ({
        filePath: t.filePath,
        testId: t.testId,
        reasons: t.reasons.map(reasonDto),
        depth: depthOf(t.reasons.map(reasonDto)),
      }))
      .sort((x, y) => x.filePath.localeCompare(y.filePath)),
    skipped: decision.skippedTests
      .map((t) => ({
        filePath: t.filePath,
        reasons: t.reasons,
        confidence: t.confidence ?? null,
      }))
      .sort((x, y) => x.filePath.localeCompare(y.filePath)),
    affectedFiles: [...decision.affectedFiles].sort(),
    affectedSymbols: [...decision.affectedSymbols].sort(),
    unprotected: (decision.details.unprotected ?? []).map((id) => {
      const hash = id.indexOf("#");
      return {
        file: hash === -1 ? id : id.slice(0, hash),
        unit: hash === -1 ? "*" : id.slice(hash + 1),
        tests: [],
      };
    }),
    graphDiff: decision.details.graphDiff ?? [],
    uncertainty: decision.details.uncertainty,
    observedSkips: (decision.details.observedSkips ?? []).map((o) => ({
      test: o.test,
      tracedAt: o.tracedAt,
    })),
    triggers: decision.details.triggers.map((t) => ({ file: t.file, pattern: t.pattern })),
    traces,
    skippedGroups: [...skippedGroups.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((x, y) => y.count - x.count || x.reason.localeCompare(y.reason)),
  };
  return {
    createdAt: Date.now(),
    profile,
    analysis,
    impact,
    view,
    observed: observedIndex(analysis, view),
    diffs,
    coverage,
  };
}

/** The last run report on disk, read once and shared by {@link loadLastRun} and {@link loadCoverage}. */
export async function readLastRunReport(storeDir: string): Promise<RunReport | null> {
  return (
    (await readJson<RunReport>(join(storeDir, "reports", "last-run.json"))) ??
    // Core writes runs/latest.json and reports/report.json; the stable "last-run" name is a
    // Studio convenience, not something every writer creates.
    (await readJson<RunReport>(join(storeDir, "runs", "latest.json"))) ??
    null
  );
}

/** Last run report, with the numbers the shell needs (cached ≠ fresh, skipped ≠ passed). */
export async function loadLastRun(
  storeDir: string,
  preread?: RunReport | null,
): Promise<StudioRun | null> {
  const { validateReportIntegrity } = await import("@smarttest/report-engine");
  const report = preread !== undefined ? preread : await readLastRunReport(storeDir);
  if (!report || report.schemaVersion === undefined) return null;
  return runFromReport(report, "affected", null, validateReportIntegrity(report));
}

export async function loadCoverage(
  storeDir: string,
  preread?: RunReport | null,
): Promise<{ runAt: string; summary: RunReport["coverage"] } | null> {
  const report = preread !== undefined ? preread : await readLastRunReport(storeDir);
  if (!report?.coverage || !report.finishedAt) return null;
  return { runAt: report.finishedAt, summary: report.coverage };
}

const RUN_FILES = new Set(["failed", "timed-out", "error"]);

/**
 * The one place that decides whether a finished run may be called passed. Integrity violations,
 * cancellation, infrastructure errors and a short execution list (bail, crash) all block it.
 */
export function runVerdictOf(
  summary: RunSummary,
  executionCount: number,
  integrityIssues: readonly string[] = [],
): StudioRunVerdict {
  if (integrityIssues.length) return "incomplete";
  if (summary.infrastructureErrors > 0) return "error";
  if (summary.cancelled > 0) return "incomplete";
  if (summary.failed > 0 || summary.timedOut > 0) return "failed";
  if (executionCount < summary.selected) return "incomplete";
  // A cached result is never a pass (ADR-0009): a run in which no test executed is cached-pass.
  if (summary.cached > 0 && summary.passed === 0) return "cached-pass";
  return "passed";
}

export function runFileOf(execution: RunReport["executions"][number]): StudioRunFile {
  return {
    file: execution.file,
    adapter: execution.adapter,
    status: execution.status,
    durationMs: execution.durationMs,
    tests: execution.tests.length,
    passed: execution.tests.filter((t) => t.status === "passed").length,
    failed: execution.tests.filter((t) => RUN_FILES.has(t.status)).length,
    cached: execution.tests.filter((t) => t.status === "cached-pass").length,
    skipped: execution.tests.filter((t) => t.status === "skipped").length,
    error: execution.error ?? null,
    failures: execution.tests
      .filter((t) => RUN_FILES.has(t.status))
      .slice(0, 20)
      .map((t) => ({ test: t.testId, message: t.error?.message ?? t.status })),
  };
}

export function runFromReport(
  report: RunReport,
  scope: StudioRun["scope"],
  file: string | null,
  integrityIssues: string[] = [],
): StudioRun {
  return {
    id: report.runId,
    startedAt: report.startedAt,
    finishedAt: report.finishedAt,
    state: "done",
    scope,
    scopeFile: file,
    command: report.command,
    mode: report.mode,
    source: report.change.description,
    selected: report.summary.selected,
    skippedBySelection: report.summary.skippedBySelection,
    summary: report.summary,
    coverage: report.coverage
      ? {
          scope: report.coverage.scope,
          lines: report.coverage.lines,
          branches: report.coverage.branches,
          functions: report.coverage.functions,
          statements: report.coverage.statements,
          files: report.coverage.files,
        }
      : null,
    executions: report.executions.map(runFileOf),
    warnings: report.warnings,
    integrityIssues,
    error: null,
  };
}

/** Cached totals read straight from the cache the runner validates. */
export async function cacheInfo(
  storeDir: string,
): Promise<{ files: number; results: number; lastCached: number; integrityIssues: string[] }> {
  const cache = await readJson<{ version: number; files: Record<string, unknown[]> }>(
    join(storeDir, "cache", "results.json"),
  );
  const files = cache?.version === 1 ? Object.keys(cache.files) : [];
  return {
    files: files.length,
    results: files.reduce((n, f) => n + (cache?.files[f]?.length ?? 0), 0),
    lastCached: 0,
    integrityIssues: [],
  };
}

export interface LastRunFacts {
  run: StudioRun | null;
  cache: { files: number; results: number; lastCached: number; integrityIssues: string[] };
  flaky: FlakyEntry[];
}

export function overviewOf(snapshot: Snapshot, last: LastRunFacts): StudioOverview {
  const impact = snapshot.impact;
  return {
    schemaVersion: 1,
    project: impact.project,
    updatedAt: new Date(snapshot.createdAt).toISOString(),
    change: impact.change,
    analysis: impact.analysis,
    counts: impact.counts,
    traces: impact.traces,
    unprotected: impact.unprotected.map((u) => ({ file: u.file, unit: u.unit })),
    observedSkips: impact.observedSkips.length,
    uncertainty: impact.uncertainty.length,
    topSelected: impact.selected.slice(0, 6).map((test) => ({
      filePath: test.filePath,
      reason: test.reasons[0]?.message ?? "selected",
      confidence:
        test.reasons.reduce<string | null>(
          (low, reason) =>
            reason.confidence && (!low || reason.confidence === "low") ? reason.confidence : low,
          null,
        ) ?? null,
    })),
    lastRun: last.run,
    cache: {
      files: last.cache.files,
      results: last.cache.results,
      lastCached: last.cache.lastCached,
      integrityIssues: last.cache.integrityIssues,
    },
    flaky: {
      count: last.flaky.length,
      worst: last.flaky[0]
        ? {
            testId: last.flaky[0].testId,
            rate: last.flaky[0].flakeRate,
            recent: last.flaky[0].recent,
          }
        : null,
    },
  };
}

const testsMemo = new WeakMap<Snapshot, { last: LastRunFacts; tests: StudioTests }>();

/** Memoised per snapshot and last-run facts: both are replaced, never mutated, on refresh. */
export function testsOf(snapshot: Snapshot, last: LastRunFacts): StudioTests {
  const memo = testsMemo.get(snapshot);
  if (memo?.last === last) return memo.tests;
  const tests = buildTests(snapshot, last);
  testsMemo.set(snapshot, { last, tests });
  return tests;
}

function buildTests(snapshot: Snapshot, last: LastRunFacts): StudioTests {
  const rows = new Map<string, StudioTestRow>();
  const executionByFile = new Map<string, StudioRunFile>();
  for (const execution of last.run?.executions ?? [])
    executionByFile.set(execution.file, execution);
  const adapterFor = (file: string): string | null =>
    snapshot.analysis.assignment.get(file)?.adapter ?? executionByFile.get(file)?.adapter ?? null;
  for (const test of snapshot.analysis.testFiles) {
    const execution = executionByFile.get(test);
    rows.set(test, {
      filePath: test,
      adapter: adapterFor(test),
      selection: null,
      reasons: [],
      confidence: null,
      depth: null,
      result: execution
        ? {
            status: execution.status,
            durationMs: execution.durationMs,
            at: last.run?.finishedAt ?? last.run?.startedAt ?? "",
            tests: execution.tests,
            passed: execution.passed,
            failed: execution.failed,
            cached: execution.cached,
            errors: execution.failures,
          }
        : null,
      flaky: null,
    });
  }
  const row = (file: string): StudioTestRow => {
    const existing = rows.get(file);
    if (existing) return existing;
    const created: StudioTestRow = {
      filePath: file,
      adapter: adapterFor(file),
      selection: null,
      reasons: [],
      confidence: null,
      depth: null,
      result: null,
      flaky: null,
    };
    rows.set(file, created);
    return created;
  };
  for (const test of snapshot.impact.selected) {
    const r = row(test.filePath);
    r.selection = "selected";
    r.reasons = test.reasons.map((reason) => reason.message);
    r.confidence = test.reasons.reduce<string | null>(
      (low, reason) =>
        reason.confidence && (!low || reason.confidence === "low") ? reason.confidence : low,
      null,
    );
    r.depth = test.depth;
  }
  for (const test of snapshot.impact.skipped) {
    const r = row(test.filePath);
    r.selection = "skipped";
    r.reasons = test.reasons;
    r.confidence = test.confidence;
  }
  for (const entry of last.flaky) {
    const r = row(entry.file);
    r.flaky = { rate: entry.flakeRate, recent: entry.recent, runs: entry.runs };
  }
  const all = [...rows.values()].sort(
    (x, y) =>
      (x.result?.failed ? 1 : 0) - (y.result?.failed ? 1 : 0) ||
      x.filePath.localeCompare(y.filePath),
  );
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    rows: all,
    counts: {
      selected: all.filter((r) => r.selection === "selected").length,
      failed: all.filter((r) => (r.result?.failed ?? 0) > 0).length,
      cached: all.filter((r) => (r.result?.cached ?? 0) > 0).length,
      skipped: all.filter((r) => r.selection === "skipped").length,
      flaky: all.filter((r) => r.flaky).length,
    },
  };
}

/** Core HistoryBenchmark stores measurements under totals; incomplete evidence stays unavailable. */
export function benchmarkOf(value: unknown): StudioTrust["benchmark"] {
  if (!value || typeof value !== "object") return null;
  const report = value as Record<string, unknown>;
  if (!["safe", "balanced", "fast"].includes(String(report.mode))) return null;
  if (!report.totals || typeof report.totals !== "object") return null;
  const totals = report.totals as Record<string, unknown>;
  const keys = [
    "commits",
    "fullMs",
    "smarttestMs",
    "savedVsFullPct",
    "missed",
    "cacheViolations",
    "selectedTests",
    "totalTests",
  ];
  if (keys.some((key) => typeof totals[key] !== "number" || !Number.isFinite(totals[key])))
    return null;
  return {
    commits: totals.commits as number,
    mode: String(report.mode),
    fullMs: totals.fullMs as number,
    smarttestMs: totals.smarttestMs as number,
    savedPct: totals.savedVsFullPct as number,
    missed: totals.missed as number,
    cacheViolations: totals.cacheViolations as number,
    selectedTests: totals.selectedTests as number,
    totalTests: totals.totalTests as number,
    // HistoryBenchmark does not persist a timestamp.
    at: "",
  };
}

export async function trustOf(
  st: SmartTest,
  snapshot: Snapshot,
  last: LastRunFacts,
): Promise<StudioTrust> {
  const [shadow, hooks, benchmarkReport] = await Promise.all([
    st.shadowReport().catch(() => undefined),
    st.hookHistory().catch(() => undefined),
    readJson<unknown>(join(st.storeDir, "reports", "benchmark.json")),
  ]);
  const benchmark = benchmarkOf(benchmarkReport);
  return {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    shadow: shadow
      ? {
          runs: shadow.runs,
          missed: shadow.missed,
          runsWithMisses: shadow.runsWithMisses,
          selected: shadow.selected,
          total: shadow.total,
          savedPct: shadow.savedPct,
          records: shadow.records.slice(-12).map((r) => ({
            at: r.at,
            head: r.head ?? null,
            mode: r.mode,
            changed: r.changed,
            selected: r.selected,
            total: r.total,
            missed: r.failuresMissed.length,
            fullMs: r.fullMs,
            selectedMs: r.selectedMs,
          })),
        }
      : null,
    benchmark,
    flaky: last.flaky.map((entry) => ({
      testId: entry.testId,
      file: entry.file,
      runs: entry.runs,
      flakeRate: entry.flakeRate,
      failureRate: entry.failureRate,
      recent: entry.recent,
    })),
    hooks: hooks
      ? {
          runs: hooks.runs,
          medianMs: hooks.medianMs,
          slowestMs: hooks.slowestMs,
          failures: hooks.failures,
          bypasses: hooks.bypasses.map((b) => ({ at: b.at, stage: b.stage, reason: b.reason })),
          withoutHook: hooks.withoutHook,
          installedLocally: hooks.installedLocally,
        }
      : null,
    traces: snapshot.impact.traces,
    cache: {
      files: last.cache.files,
      results: last.cache.results,
      lastRunCached: last.cache.lastCached,
      integrityIssues: last.cache.integrityIssues,
    },
    coverage: snapshot.coverage?.summary
      ? {
          scope: snapshot.coverage.summary.scope,
          lines: snapshot.coverage.summary.lines,
          branches: snapshot.coverage.summary.branches,
          functions: snapshot.coverage.summary.functions,
          statements: snapshot.coverage.summary.statements,
          files: snapshot.coverage.summary.files,
          at: snapshot.coverage.runAt,
        }
      : null,
  };
}

/** Source viewer: current text, the lines the change added, and what tests observed each unit. */
export async function sourceOf(
  st: SmartTest,
  snapshot: Snapshot,
  path: string,
  maxBytes = 512 * 1024,
): Promise<StudioSource> {
  const index = snapshot.analysis.index.get(path);
  const diff = snapshot.diffs.get(path);
  const changed = snapshot.impact.change.files.find((f) => f.path === path);
  const unprotectedUnits = new Set(
    snapshot.impact.unprotected.filter((u) => u.file === path).map((u) => u.unit),
  );
  const file = await readProjectFileHead(st.root, path, { maxBytes });
  if (file === null) {
    return {
      schemaVersion: 1,
      path,
      language: index?.language ?? "unknown",
      exists: false,
      lines: [],
      changedLines: [],
      units: [],
      traces: null,
      note:
        changed?.type === "deleted" ? "Deleted by the current change." : "File is not readable.",
    };
  }
  const truncated = file.truncated;
  const lines = file.text.split("\n").map((line, i) => ({ n: i + 1, text: line }));
  const changedLines = new Set<number>(diff?.added ?? []);
  const changedUnits = new Set(
    snapshot.impact.change.files.filter((f) => f.path === path).flatMap((f) => f.units),
  );
  const units: StudioSourceUnit[] = [];
  const observedByUnit = new Map<string, string[]>();
  for (const entry of snapshot.observed.get(path) ?? []) {
    const at = entry.indexOf("\u0000");
    if (at === -1) continue;
    const test = entry.slice(0, at);
    const name = entry.slice(at + 1);
    const list = observedByUnit.get(name) ?? [];
    list.push(test);
    observedByUnit.set(name, list);
  }
  for (const symbol of index?.symbols ?? []) {
    const unit = unitOf(symbol);
    // Symbol ranges are zero-based; source lines (and the viewer) are one-based.
    const range = { startLine: symbol.range.start.line + 1, endLine: symbol.range.end.line + 1 };
    const key = unit.includes(".") ? unit.slice(unit.indexOf(".") + 1) : unit;
    const observedBy = [
      ...new Set([...(observedByUnit.get(symbol.name) ?? []), ...(observedByUnit.get(key) ?? [])]),
    ];
    units.push({
      name: unit,
      kind: symbol.kind,
      startLine: range.startLine,
      endLine: range.endLine,
      changed: changedUnits.has(unit),
      unprotected: unprotectedUnits.has(unit),
      observedBy: observedBy.sort(),
    });
  }
  // The snapshot's trace counts cover the same tests with the same rules; reuse them.
  const traces = snapshot.impact.traces;
  return {
    schemaVersion: 1,
    path,
    language:
      index?.language ?? (path.endsWith(".ts") || path.endsWith(".tsx") ? "typescript" : "unknown"),
    exists: true,
    lines,
    changedLines: [...changedLines].sort((a, b) => a - b),
    units,
    traces: traces.available
      ? {
          fresh: traces.fresh,
          stale: traces.stale,
          missing: traces.missing,
          collectedAt: traces.collectedAt,
        }
      : null,
    note: truncated
      ? `Showing the first ${Math.round(maxBytes / 1024)} KiB of this file.`
      : diff?.approximate
        ? "Changed lines were approximated for a very large diff."
        : null,
  };
}

const fileIndexMemo = new WeakMap<Snapshot, { index: StudioFileIndex; paths: Set<string> }>();

/** Whether `path` is in the snapshot's file index, without rebuilding it per request. */
export function isIndexedFile(snapshot: Snapshot, path: string): boolean {
  fileIndexOf(snapshot);
  return fileIndexMemo.get(snapshot)?.paths.has(path) ?? false;
}

/** Memoised per snapshot: a snapshot is never mutated after it is built. */
export function fileIndexOf(snapshot: Snapshot): StudioFileIndex {
  const memo = fileIndexMemo.get(snapshot);
  if (memo) return memo.index;
  const index = buildFileIndex(snapshot);
  fileIndexMemo.set(snapshot, { index, paths: new Set(index.files.map((file) => file.path)) });
  return index;
}

function buildFileIndex(snapshot: Snapshot): StudioFileIndex {
  const changed = new Set(snapshot.impact.change.files.map((f) => f.path));
  const files = new Map<string, { path: string; test: boolean; changed: boolean }>();
  for (const path of snapshot.analysis.index.entries().keys())
    files.set(path, { path, test: false, changed: changed.has(path) });
  for (const path of snapshot.analysis.testFiles) {
    const existing = files.get(path);
    if (existing) existing.test = true;
    else files.set(path, { path, test: true, changed: changed.has(path) });
  }
  for (const path of changed)
    if (!files.has(path)) files.set(path, { path, test: false, changed: true });
  return {
    schemaVersion: 1,
    files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)),
  };
}

export function summaryLine(summary: RunSummary): string {
  const parts = [`${summary.executed} executed`];
  if (summary.passed) parts.push(`${summary.passed} passed`);
  if (summary.failed) parts.push(`${summary.failed} failed`);
  if (summary.cached) parts.push(`${summary.cached} cached`);
  if (summary.timedOut) parts.push(`${summary.timedOut} timed out`);
  if (summary.infrastructureErrors) parts.push(`${summary.infrastructureErrors} infra errors`);
  if (summary.skippedByTests) parts.push(`${summary.skippedByTests} skipped in tests`);
  if (summary.cancelled) parts.push(`${summary.cancelled} cancelled`);
  return parts.join(" · ");
}

/** Guard: only paths inside the project and known to the analysis may be read or run. */
export function safeProjectPath(root: string, path: string): string | null {
  if (!path || path.includes("\u0000") || path.startsWith("/") || /^[a-zA-Z]:/.test(path))
    return null;
  const abs = resolve(root, path);
  const normalizedRoot = resolve(root);
  if (abs !== normalizedRoot && !abs.startsWith(normalizedRoot + sep)) return null;
  return abs;
}

export function symbolsOf(snapshot: Snapshot, path: string): SymbolRecord[] {
  return snapshot.analysis.index.get(path)?.symbols ?? [];
}
