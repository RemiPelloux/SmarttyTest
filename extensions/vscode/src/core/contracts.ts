/**
 * Types and defensive parsers for the public `smarttest --json` contracts the
 * extension consumes. A missing or malformed field is an error, never a zero:
 * the extension must not report "unprotected" when it could not read the answer.
 */
import { SmartTestExtensionError } from "./errors.js";

export type SafetyMode = "fast" | "balanced" | "safe";
export type AnalysisStatus = "complete" | "partial" | "fallback";
export type RiskLevel = "low" | "medium" | "high" | "critical" | string;
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

export interface SourceTestHit {
  readonly test: string;
  readonly path: readonly string[];
}

export interface Uncertainty {
  readonly file: string;
  readonly reasons: readonly string[];
}

export interface SourceExplain {
  readonly kind: "source";
  readonly target: string;
  readonly description: string;
  readonly tests: readonly SourceTestHit[];
  /** `explain <file> --units`: the tests protecting each named unit. */
  readonly units?: readonly { readonly unit: string; readonly tests: readonly SourceTestHit[] }[];
  readonly uncertainty: readonly Uncertainty[];
  readonly rules: readonly string[];
  readonly risk: RiskLevel;
}

export interface TestExplain {
  readonly kind: "test";
  readonly target: string;
  readonly description: string;
  readonly mode: SafetyMode;
  readonly analysisStatus: AnalysisStatus;
  readonly status?: "selected" | "skipped" | "unknown";
  readonly reasons: readonly string[];
  readonly path?: readonly string[];
  readonly confidence?: string;
}

export type ExplainResult = SourceExplain | TestExplain;

export interface Change {
  readonly path: string;
  readonly type: string;
  readonly previousPath?: string;
}

export interface ChangeSet {
  readonly provider: string;
  readonly changes: readonly Change[];
  readonly completeness: string;
  readonly warnings: readonly string[];
  readonly baseRevision?: string;
  readonly targetRevision?: string;
}

export interface SelectionReason {
  readonly kind: string;
  readonly message: string;
  readonly path?: readonly string[];
  readonly ruleName?: string;
  readonly confidence?: string;
}

export interface SelectedTest {
  readonly testId: string;
  readonly filePath: string;
  readonly reasons: readonly SelectionReason[];
}

export interface SkippedTest {
  readonly testId: string;
  readonly filePath: string;
  readonly reasons: readonly string[];
  readonly confidence?: string;
}

export interface ImpactDecision {
  readonly selectedTests: readonly SelectedTest[];
  readonly skippedTests: readonly SkippedTest[];
  readonly affectedFiles: readonly string[];
  readonly affectedSymbols: readonly string[];
  readonly analysisStatus: AnalysisStatus;
  readonly safetyMode: SafetyMode;
  readonly requestedMode?: SafetyMode;
  readonly reasons: readonly SelectionReason[];
  readonly warnings: readonly string[];
  readonly fallbackApplied: boolean;
  readonly details?: {
    readonly unprotected?: readonly string[];
    readonly graphDiff?: readonly {
      readonly file: string;
      readonly added: readonly string[];
      readonly removed: readonly string[];
    }[];
    readonly observedSkips?: readonly unknown[];
  };
}

export interface ImpactResult {
  readonly description: string;
  readonly changeSet: ChangeSet;
  readonly decision: ImpactDecision;
  readonly timings?: Readonly<Record<string, number>>;
}

export interface TestExecution {
  readonly testId: string;
  readonly status: TestStatus;
  readonly durationMs: number;
  readonly attempts: number;
  readonly error?: { readonly message: string; readonly stack?: string };
  readonly artifacts?: readonly { readonly name: string; readonly path: string }[];
}

export interface FileExecution {
  readonly file: string;
  readonly adapter: string;
  readonly status: TestStatus;
  readonly durationMs: number;
  readonly tests: readonly TestExecution[];
  readonly error?: string;
}

export interface RunSummary {
  readonly totalTests: number;
  readonly selected: number;
  readonly executed: number;
  readonly skippedBySelection: number;
  readonly passed: number;
  readonly failed: number;
  readonly flaky: number;
  readonly timedOut: number;
  readonly cancelled: number;
  readonly infrastructureErrors: number;
  readonly skippedByTests: number;
  readonly cached: number;
  readonly durationMs: number;
}

export interface RunReport {
  readonly schemaVersion: number;
  readonly tool: { readonly name: string; readonly version: string };
  readonly runId: string;
  readonly command: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly project: string;
  readonly mode: SafetyMode;
  readonly change: { readonly description: string; readonly changeSet: ChangeSet };
  readonly decision: ImpactDecision;
  readonly executions: readonly FileExecution[];
  readonly summary: RunSummary;
  readonly coverage?: {
    readonly scope: "full" | "selected";
    readonly lines: number;
    readonly statements: number;
    readonly functions: number;
    readonly branches: number;
    readonly files: number;
  };
  readonly estimate?: {
    readonly skippedTestTimeMs: number;
    readonly knownSkipped: number;
    readonly totalSkipped: number;
  };
  readonly timings: Readonly<Record<string, number>>;
  readonly warnings: readonly string[];
}

export interface RunResult {
  readonly report: RunReport;
  readonly reports: Readonly<Record<string, string>>;
  readonly integrityIssues: readonly string[];
}

export interface ScanRunner {
  readonly adapter: string;
  readonly dir?: string;
  readonly configFile?: string;
}

export interface ScanResult {
  readonly profile: {
    readonly root: string;
    readonly name: string;
    readonly runners: readonly ScanRunner[];
    readonly tests: { readonly testFiles: number; readonly layout?: string };
    readonly warnings?: readonly string[];
  };
  readonly vcs: string;
  readonly index: {
    readonly files: number;
    readonly symbols: number;
    readonly imports: number;
    readonly parsed?: number;
    readonly reused?: number;
  };
  readonly graph: {
    readonly edges: number;
    readonly uncertainFiles: number;
  };
  readonly tests: { readonly total: number; readonly files?: readonly string[] };
  readonly unresolved: readonly { readonly file: string; readonly specifier: string }[];
  readonly dynamic: readonly { readonly file: string; readonly detail: string }[];
}

export interface GraphNode {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly filePath?: string;
}

export interface GraphEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: string;
  readonly provenance?: string;
  readonly confidence?: string;
}

export interface GraphDump {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
}

export interface CliEnvelope {
  readonly schemaVersion: number;
  readonly command?: string;
  readonly [key: string]: unknown;
}

// ── parsing helpers ───────────────────────────────────────────────────────────────────────

function contractError(path: string, expected: string): SmartTestExtensionError {
  return new SmartTestExtensionError(
    `The local smarttest returned JSON that the extension cannot read: ${path} should be ${expected}.`,
    {
      code: "ST_EXT_CONTRACT",
      category: "contract",
      hint: "Run `smarttest --version`; SmartTest 0.8.0+ with --json schema v1 is required. Update smarttest or this extension.",
    },
  );
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw contractError(path, "an object");
  return value as Record<string, unknown>;
}

function asArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw contractError(path, "an array");
  return value;
}

function asString(value: unknown, path: string): string {
  if (typeof value !== "string") throw contractError(path, "a string");
  return value;
}

function asNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw contractError(path, "a number");
  return value;
}

function asBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw contractError(path, "a boolean");
  return value;
}

function asSafetyMode(value: unknown, path: string): SafetyMode {
  if (value === "fast" || value === "balanced" || value === "safe") return value;
  throw contractError(path, "fast, balanced or safe");
}

function asAnalysisStatus(value: unknown, path: string): AnalysisStatus {
  if (value === "complete" || value === "partial" || value === "fallback") return value;
  throw contractError(path, "complete, partial or fallback");
}

function asTestStatus(value: unknown, path: string): TestStatus {
  switch (value) {
    case "passed":
    case "failed":
    case "skipped":
    case "pending":
    case "cancelled":
    case "timed-out":
    case "cached-pass":
    case "cached-failure":
    case "flaky":
    case "infrastructure-error":
      return value;
    default:
      throw contractError(
        path,
        "one of passed, failed, skipped, pending, cancelled, timed-out, cached-pass, cached-failure, flaky, infrastructure-error",
      );
  }
}

function asStringArray(value: unknown, path: string): string[] {
  return asArray(value, path).map((item, index) => asString(item, `${path}[${index}]`));
}

export function parseJsonEnvelope(stdout: string, expectedCommand?: string): CliEnvelope {
  const text = stdout.replace(/^\uFEFF/, "").trim();
  if (!text)
    throw new SmartTestExtensionError("The local smarttest produced no JSON output.", {
      code: "ST_EXT_EMPTY_OUTPUT",
      category: "contract",
      hint: "Run `smarttest --version` and the same command in a terminal to see what happened.",
    });
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new SmartTestExtensionError("The local smarttest did not return JSON.", {
      code: "ST_EXT_INVALID_JSON",
      category: "contract",
      hint: "Check that the configured executable is smarttest 0.8.0+ and not a wrapper that prints extra text.",
      cause: error,
    });
  }
  const envelope = asRecord(parsed, "$");
  if (envelope.schemaVersion !== 1)
    throw new SmartTestExtensionError(
      `Unsupported SmartTest JSON schema version ${String(envelope.schemaVersion)}.`,
      {
        code: "ST_EXT_SCHEMA_VERSION",
        category: "contract",
        hint: "This extension supports --json schema v1. Update smarttest.",
      },
    );
  if (expectedCommand !== undefined && envelope.command !== expectedCommand)
    throw contractError(
      "$.command",
      `"${expectedCommand}" (received ${JSON.stringify(envelope.command)})`,
    );
  return envelope as CliEnvelope;
}

function parseChangeSet(value: unknown, path: string): ChangeSet {
  const record = asRecord(value, path);
  const changes = asArray(record.changes, `${path}.changes`).map((item, index) => {
    const changePath = `${path}.changes[${index}]`;
    const change = asRecord(item, changePath);
    return {
      path: asString(change.path, `${changePath}.path`),
      type: asString(change.type, `${changePath}.type`),
      ...(change.previousPath === undefined
        ? {}
        : { previousPath: asString(change.previousPath, `${changePath}.previousPath`) }),
    };
  });
  return {
    provider: asString(record.provider, `${path}.provider`),
    changes,
    completeness: asString(record.completeness, `${path}.completeness`),
    warnings: asStringArray(record.warnings, `${path}.warnings`),
    ...(record.baseRevision === undefined
      ? {}
      : { baseRevision: asString(record.baseRevision, `${path}.baseRevision`) }),
    ...(record.targetRevision === undefined
      ? {}
      : { targetRevision: asString(record.targetRevision, `${path}.targetRevision`) }),
  };
}

function parseSelectionReasons(value: unknown, path: string): SelectionReason[] {
  return asArray(value, path).map((item, index) => {
    const reasonPath = `${path}[${index}]`;
    const reason = asRecord(item, reasonPath);
    return {
      kind: asString(reason.kind, `${reasonPath}.kind`),
      message: asString(reason.message, `${reasonPath}.message`),
      ...(reason.path === undefined
        ? {}
        : { path: asStringArray(reason.path, `${reasonPath}.path`) }),
      ...(reason.ruleName === undefined
        ? {}
        : { ruleName: asString(reason.ruleName, `${reasonPath}.ruleName`) }),
      ...(reason.confidence === undefined
        ? {}
        : { confidence: asString(reason.confidence, `${reasonPath}.confidence`) }),
    };
  });
}

function parseDecision(value: unknown, path: string): ImpactDecision {
  const record = asRecord(value, path);
  const selectedTests = asArray(record.selectedTests, `${path}.selectedTests`).map(
    (item, index) => {
      const itemPath = `${path}.selectedTests[${index}]`;
      const selected = asRecord(item, itemPath);
      return {
        testId: asString(selected.testId, `${itemPath}.testId`),
        filePath: asString(selected.filePath, `${itemPath}.filePath`),
        reasons: parseSelectionReasons(selected.reasons, `${itemPath}.reasons`),
      };
    },
  );
  const skippedTests = asArray(record.skippedTests, `${path}.skippedTests`).map((item, index) => {
    const itemPath = `${path}.skippedTests[${index}]`;
    const skipped = asRecord(item, itemPath);
    return {
      testId: asString(skipped.testId, `${itemPath}.testId`),
      filePath: asString(skipped.filePath, `${itemPath}.filePath`),
      reasons: asStringArray(skipped.reasons, `${itemPath}.reasons`),
      ...(skipped.confidence === undefined
        ? {}
        : { confidence: asString(skipped.confidence, `${itemPath}.confidence`) }),
    };
  });
  const detailsValue = record.details;
  let details: ImpactDecision["details"];
  if (detailsValue !== undefined) {
    const detailsRecord = asRecord(detailsValue, `${path}.details`);
    details = {
      ...(detailsRecord.unprotected === undefined
        ? {}
        : { unprotected: asStringArray(detailsRecord.unprotected, `${path}.details.unprotected`) }),
      ...(detailsRecord.graphDiff === undefined
        ? {}
        : {
            graphDiff: asArray(detailsRecord.graphDiff, `${path}.details.graphDiff`).map(
              (item, index) => {
                const diffPath = `${path}.details.graphDiff[${index}]`;
                const diff = asRecord(item, diffPath);
                return {
                  file: asString(diff.file, `${diffPath}.file`),
                  added: asStringArray(diff.added, `${diffPath}.added`),
                  removed: asStringArray(diff.removed, `${diffPath}.removed`),
                };
              },
            ),
          }),
      ...(detailsRecord.observedSkips === undefined
        ? {}
        : {
            observedSkips: asArray(detailsRecord.observedSkips, `${path}.details.observedSkips`),
          }),
    };
  }
  return {
    selectedTests,
    skippedTests,
    affectedFiles: asStringArray(record.affectedFiles, `${path}.affectedFiles`),
    affectedSymbols: asStringArray(record.affectedSymbols, `${path}.affectedSymbols`),
    analysisStatus: asAnalysisStatus(record.analysisStatus, `${path}.analysisStatus`),
    safetyMode: asSafetyMode(record.safetyMode, `${path}.safetyMode`),
    ...(record.requestedMode === undefined
      ? {}
      : { requestedMode: asSafetyMode(record.requestedMode, `${path}.requestedMode`) }),
    reasons: parseSelectionReasons(record.reasons, `${path}.reasons`),
    warnings: asStringArray(record.warnings, `${path}.warnings`),
    fallbackApplied: asBoolean(record.fallbackApplied, `${path}.fallbackApplied`),
    ...(details === undefined ? {} : { details }),
  };
}

export function parseImpactJson(stdout: string): ImpactResult {
  const envelope = parseJsonEnvelope(stdout, "impact");
  return {
    description: asString(envelope.description, "$.description"),
    changeSet: parseChangeSet(envelope.changeSet, "$.changeSet"),
    decision: parseDecision(envelope.decision, "$.decision"),
    ...(envelope.timings === undefined
      ? {}
      : {
          timings: Object.fromEntries(
            Object.entries(asRecord(envelope.timings, "$.timings")).map(([key, value]) => [
              key,
              asNumber(value, `$.timings.${key}`),
            ]),
          ),
        }),
  };
}

export function parseExplainJson(stdout: string): ExplainResult {
  const envelope = parseJsonEnvelope(stdout, "explain");
  const kind = envelope.kind;
  if (kind === "source") {
    const uncertainty = asArray(envelope.uncertainty, "$.uncertainty").map((item, index) => {
      const path = `$.uncertainty[${index}]`;
      const record = asRecord(item, path);
      return {
        file: asString(record.file, `${path}.file`),
        reasons: asStringArray(record.reasons, `${path}.reasons`),
      };
    });
    const hits = (value: unknown, at: string): SourceTestHit[] =>
      asArray(value, at).map((item, index) => {
        const path = `${at}[${index}]`;
        const record = asRecord(item, path);
        return {
          test: asString(record.test, `${path}.test`),
          path: asStringArray(record.path, `${path}.path`),
        };
      });
    return {
      kind: "source",
      target: asString(envelope.target, "$.target"),
      description: asString(envelope.description, "$.description"),
      tests: hits(envelope.tests, "$.tests"),
      ...(envelope.units === undefined
        ? {}
        : {
            units: asArray(envelope.units, "$.units").map((item, index) => {
              const path = `$.units[${index}]`;
              const record = asRecord(item, path);
              return {
                unit: asString(record.unit, `${path}.unit`),
                tests: hits(record.tests, `${path}.tests`),
              };
            }),
          }),
      uncertainty,
      rules: asStringArray(envelope.rules, "$.rules"),
      risk: asString(envelope.risk, "$.risk"),
    };
  }
  if (kind === "test") {
    return {
      kind: "test",
      target: asString(envelope.target, "$.target"),
      description: asString(envelope.description, "$.description"),
      mode: asSafetyMode(envelope.mode, "$.mode"),
      analysisStatus: asAnalysisStatus(envelope.analysisStatus, "$.analysisStatus"),
      ...(envelope.status === undefined
        ? {}
        : {
            status: (() => {
              const status = asString(envelope.status, "$.status");
              if (status === "selected" || status === "skipped" || status === "unknown")
                return status;
              throw contractError("$.status", "selected, skipped or unknown");
            })(),
          }),
      reasons: asStringArray(envelope.reasons, "$.reasons"),
      ...(envelope.path === undefined ? {} : { path: asStringArray(envelope.path, "$.path") }),
      ...(envelope.confidence === undefined
        ? {}
        : { confidence: asString(envelope.confidence, "$.confidence") }),
    };
  }
  throw contractError("$.kind", '"source" or "test"');
}

function parseExecution(value: unknown, path: string): TestExecution {
  const record = asRecord(value, path);
  return {
    testId: asString(record.testId, `${path}.testId`),
    status: asTestStatus(record.status, `${path}.status`),
    durationMs: asNumber(record.durationMs, `${path}.durationMs`),
    attempts: asNumber(record.attempts, `${path}.attempts`),
    ...(record.error === undefined
      ? {}
      : { error: parseExecutionError(record.error, `${path}.error`) }),
    ...(record.artifacts === undefined
      ? {}
      : {
          artifacts: asArray(record.artifacts, `${path}.artifacts`).map((item, index) => {
            const artifactPath = `${path}.artifacts[${index}]`;
            const artifact = asRecord(item, artifactPath);
            return {
              name: asString(artifact.name, `${artifactPath}.name`),
              path: asString(artifact.path, `${artifactPath}.path`),
            };
          }),
        }),
  };
}

function parseExecutionError(value: unknown, path: string): { message: string; stack?: string } {
  const record = asRecord(value, path);
  return {
    message: asString(record.message, `${path}.message`),
    ...(record.stack === undefined ? {} : { stack: asString(record.stack, `${path}.stack`) }),
  };
}

export function parseRunJson(stdout: string): RunResult {
  const envelope = parseJsonEnvelope(stdout, "run");
  const reportValue = asRecord(envelope.report, "$.report");
  const executions = asArray(reportValue.executions, "$.report.executions").map((item, index) => {
    const path = `$.report.executions[${index}]`;
    const record = asRecord(item, path);
    return {
      file: asString(record.file, `${path}.file`),
      adapter: asString(record.adapter, `${path}.adapter`),
      status: asTestStatus(record.status, `${path}.status`),
      durationMs: asNumber(record.durationMs, `${path}.durationMs`),
      tests: asArray(record.tests, `${path}.tests`).map((test, testIndex) =>
        parseExecution(test, `${path}.tests[${testIndex}]`),
      ),
      ...(record.error === undefined ? {} : { error: asString(record.error, `${path}.error`) }),
    };
  });
  const summaryValue = asRecord(reportValue.summary, "$.report.summary");
  const summary: RunSummary = {
    totalTests: asNumber(summaryValue.totalTests, "$.report.summary.totalTests"),
    selected: asNumber(summaryValue.selected, "$.report.summary.selected"),
    executed: asNumber(summaryValue.executed, "$.report.summary.executed"),
    skippedBySelection: asNumber(
      summaryValue.skippedBySelection,
      "$.report.summary.skippedBySelection",
    ),
    passed: asNumber(summaryValue.passed, "$.report.summary.passed"),
    failed: asNumber(summaryValue.failed, "$.report.summary.failed"),
    flaky: asNumber(summaryValue.flaky, "$.report.summary.flaky"),
    timedOut: asNumber(summaryValue.timedOut, "$.report.summary.timedOut"),
    cancelled: asNumber(summaryValue.cancelled, "$.report.summary.cancelled"),
    infrastructureErrors: asNumber(
      summaryValue.infrastructureErrors,
      "$.report.summary.infrastructureErrors",
    ),
    skippedByTests: asNumber(summaryValue.skippedByTests, "$.report.summary.skippedByTests"),
    cached: asNumber(summaryValue.cached, "$.report.summary.cached"),
    durationMs: asNumber(summaryValue.durationMs, "$.report.summary.durationMs"),
  };
  const toolValue = asRecord(reportValue.tool, "$.report.tool");
  const changeValue = asRecord(reportValue.change, "$.report.change");
  const report: RunReport = {
    schemaVersion: asNumber(reportValue.schemaVersion, "$.report.schemaVersion"),
    tool: {
      name: asString(toolValue.name, "$.report.tool.name"),
      version: asString(toolValue.version, "$.report.tool.version"),
    },
    runId: asString(reportValue.runId, "$.report.runId"),
    command: asString(reportValue.command, "$.report.command"),
    startedAt: asString(reportValue.startedAt, "$.report.startedAt"),
    finishedAt: asString(reportValue.finishedAt, "$.report.finishedAt"),
    project: asString(reportValue.project, "$.report.project"),
    mode: asSafetyMode(reportValue.mode, "$.report.mode"),
    change: {
      description: asString(changeValue.description, "$.report.change.description"),
      changeSet: parseChangeSet(changeValue.changeSet, "$.report.change.changeSet"),
    },
    decision: parseDecision(reportValue.decision, "$.report.decision"),
    executions,
    summary,
    timings: Object.fromEntries(
      Object.entries(asRecord(reportValue.timings, "$.report.timings")).map(([key, value]) => [
        key,
        asNumber(value, `$.report.timings.${key}`),
      ]),
    ),
    warnings: asStringArray(reportValue.warnings, "$.report.warnings"),
    ...(reportValue.coverage === undefined
      ? {}
      : (() => {
          const coverage = asRecord(reportValue.coverage, "$.report.coverage");
          const scope = asString(coverage.scope, "$.report.coverage.scope");
          if (scope !== "full" && scope !== "selected")
            throw contractError("$.report.coverage.scope", "full or selected");
          return {
            coverage: {
              scope,
              lines: asNumber(coverage.lines, "$.report.coverage.lines"),
              statements: asNumber(coverage.statements, "$.report.coverage.statements"),
              functions: asNumber(coverage.functions, "$.report.coverage.functions"),
              branches: asNumber(coverage.branches, "$.report.coverage.branches"),
              files: asNumber(coverage.files, "$.report.coverage.files"),
            },
          };
        })()),
    ...(reportValue.estimate === undefined
      ? {}
      : (() => {
          const estimate = asRecord(reportValue.estimate, "$.report.estimate");
          return {
            estimate: {
              skippedTestTimeMs: asNumber(
                estimate.skippedTestTimeMs,
                "$.report.estimate.skippedTestTimeMs",
              ),
              knownSkipped: asNumber(estimate.knownSkipped, "$.report.estimate.knownSkipped"),
              totalSkipped: asNumber(estimate.totalSkipped, "$.report.estimate.totalSkipped"),
            },
          };
        })()),
  };
  const reports: Record<string, string> = {};
  for (const [key, value] of Object.entries(asRecord(envelope.reports, "$.reports")))
    reports[key] = asString(value, `$.reports.${key}`);
  return {
    report,
    reports,
    integrityIssues: asStringArray(envelope.integrityIssues, "$.integrityIssues"),
  };
}

export function parseScanJson(stdout: string): ScanResult {
  const envelope = parseJsonEnvelope(stdout, "scan");
  const profile = asRecord(envelope.profile, "$.profile");
  const profileTests = asRecord(profile.tests, "$.profile.tests");
  const index = asRecord(envelope.index, "$.index");
  const graph = asRecord(envelope.graph, "$.graph");
  const tests = asRecord(envelope.tests, "$.tests");
  return {
    profile: {
      root: asString(profile.root, "$.profile.root"),
      name: asString(profile.name, "$.profile.name"),
      runners: asArray(profile.runners, "$.profile.runners").map((item, runnerIndex) => {
        const path = `$.profile.runners[${runnerIndex}]`;
        const runner = asRecord(item, path);
        return {
          adapter: asString(runner.adapter, `${path}.adapter`),
          ...(runner.dir === undefined ? {} : { dir: asString(runner.dir, `${path}.dir`) }),
          ...(runner.configFile === undefined
            ? {}
            : { configFile: asString(runner.configFile, `${path}.configFile`) }),
        };
      }),
      tests: {
        testFiles: asNumber(profileTests.testFiles, "$.profile.tests.testFiles"),
        ...(profileTests.layout === undefined
          ? {}
          : { layout: asString(profileTests.layout, "$.profile.tests.layout") }),
      },
      ...(profile.warnings === undefined
        ? {}
        : { warnings: asStringArray(profile.warnings, "$.profile.warnings") }),
    },
    vcs: asString(envelope.vcs, "$.vcs"),
    index: {
      files: asNumber(index.files, "$.index.files"),
      symbols: asNumber(index.symbols, "$.index.symbols"),
      imports: asNumber(index.imports, "$.index.imports"),
      ...(index.parsed === undefined ? {} : { parsed: asNumber(index.parsed, "$.index.parsed") }),
      ...(index.reused === undefined ? {} : { reused: asNumber(index.reused, "$.index.reused") }),
    },
    graph: {
      edges: asNumber(graph.edges, "$.graph.edges"),
      uncertainFiles: asNumber(graph.uncertainFiles, "$.graph.uncertainFiles"),
    },
    tests: {
      total: asNumber(tests.total, "$.tests.total"),
      ...(tests.files === undefined ? {} : { files: asStringArray(tests.files, "$.tests.files") }),
    },
    unresolved: asArray(envelope.unresolved, "$.unresolved").map((item, itemIndex) => {
      const path = `$.unresolved[${itemIndex}]`;
      const record = asRecord(item, path);
      return {
        file: asString(record.file, `${path}.file`),
        specifier: asString(record.specifier, `${path}.specifier`),
      };
    }),
    dynamic: asArray(envelope.dynamic, "$.dynamic").map((item, itemIndex) => {
      const path = `$.dynamic[${itemIndex}]`;
      const record = asRecord(item, path);
      return {
        file: asString(record.file, `${path}.file`),
        detail: asString(record.detail, `${path}.detail`),
      };
    }),
  };
}

/**
 * `smarttest graph --format json` prints the graph object directly (there is no
 * command envelope on that path), so it is parsed separately.
 */
export function parseGraphDump(stdout: string): GraphDump {
  const text = stdout.replace(/^\uFEFF/, "").trim();
  if (!text)
    throw new SmartTestExtensionError("The local smarttest produced no graph JSON.", {
      code: "ST_EXT_EMPTY_OUTPUT",
      category: "contract",
      hint: "Run `smarttest graph --format json` in a terminal.",
    });
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new SmartTestExtensionError("The local smarttest did not return graph JSON.", {
      code: "ST_EXT_INVALID_JSON",
      category: "contract",
      hint: "Check that `smarttest graph --format json` works in a terminal.",
      cause: error,
    });
  }
  const record = asRecord(parsed, "$");
  if (record.schemaVersion !== 1) throw contractError("$.schemaVersion", "1");
  return {
    nodes: asArray(record.nodes, "$.nodes").map((item, index) => {
      const path = `$.nodes[${index}]`;
      const node = asRecord(item, path);
      return {
        id: asString(node.id, `${path}.id`),
        kind: asString(node.kind, `${path}.kind`),
        label: asString(node.label, `${path}.label`),
        ...(node.filePath === undefined
          ? {}
          : { filePath: asString(node.filePath, `${path}.filePath`) }),
      };
    }),
    edges: asArray(record.edges, "$.edges").map((item, index) => {
      const path = `$.edges[${index}]`;
      const edge = asRecord(item, path);
      return {
        from: asString(edge.from, `${path}.from`),
        to: asString(edge.to, `${path}.to`),
        kind: asString(edge.kind, `${path}.kind`),
        ...(edge.provenance === undefined
          ? {}
          : { provenance: asString(edge.provenance, `${path}.provenance`) }),
        ...(edge.confidence === undefined
          ? {}
          : { confidence: asString(edge.confidence, `${path}.confidence`) }),
      };
    }),
  };
}

/** Error envelope printed by `smarttest --json` on failure. */
export interface CliErrorEnvelope {
  readonly code: string;
  readonly category: string;
  readonly message: string;
  readonly hint?: string;
}

export function parseCliError(stdout: string): CliErrorEnvelope | undefined {
  const text = stdout.replace(/^\uFEFF/, "").trim();
  if (!text) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const record = parsed as Record<string, unknown>;
    if (typeof record.error !== "object" || record.error === null) return undefined;
    const error = record.error as Record<string, unknown>;
    if (typeof error.code !== "string" || typeof error.message !== "string") return undefined;
    return {
      code: error.code,
      category: typeof error.category === "string" ? error.category : "internal",
      message: error.message,
      ...(typeof error.hint === "string" ? { hint: error.hint } : {}),
    };
  } catch {
    return undefined;
  }
}

/**
 * True when stdout carries a `run` report. The CLI writes one even when it exits
 * 4 (infrastructure) or 70 (integrity check failed); the report, not the exit
 * code, says what ran.
 */
export function hasRunReport(stdout: string): boolean {
  const text = stdout.replace(/^﻿/, "").trim();
  if (!text) return false;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) return false;
    const record = parsed as Record<string, unknown>;
    return record.command === "run" && typeof record.report === "object" && record.report !== null;
  } catch {
    return false;
  }
}
