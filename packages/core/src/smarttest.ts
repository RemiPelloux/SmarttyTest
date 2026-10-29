import { createHash } from "node:crypto";
import { join } from "node:path";
import { JestAdapter } from "@smarttest/adapter-jest";
import { VitestAdapter } from "@smarttest/adapter-vitest";
import {
  BUILTIN_TRIGGERS,
  type LoadedConfig,
  loadConfig,
  type ResolvedConfig,
} from "@smarttest/config";
import { type CoverageReport, ingestIstanbul } from "@smarttest/coverage-engine";
import { DependencyGraph } from "@smarttest/dependency-graph";
import { decideImpact, explainTest, type ImpactResult } from "@smarttest/impact-engine";
import { javascriptAnalyzer } from "@smarttest/language-javascript";
import { TypeScriptResolver, typescriptAnalyzer } from "@smarttest/language-typescript";
import { SnapshotStore } from "@smarttest/native-snapshots";
import { detectProject, type ProjectProfile } from "@smarttest/project-detector";
import {
  type FileExecution,
  newRunId,
  overallStatus,
  type RunReport,
  summarize,
  TOOL,
  validateReportIntegrity,
  writeReports,
} from "@smarttest/report-engine";
import { RulesEngine } from "@smarttest/rules-engine";
import { diffFile, type FileSemanticDiff } from "@smarttest/semantic-diff";
import type { TestAdapter } from "@smarttest/shared";
import {
  ExitCode,
  exists,
  type Logger,
  matchGlob,
  readJson,
  type SafetyMode,
  SmartTestError,
  silentLogger,
  walkFiles,
  writeJson,
} from "@smarttest/shared";
import {
  applyPlan,
  applyUninstall,
  buildPlan,
  planUninstall,
  renderSetupReport,
  rollback,
  type SetupPlan,
} from "@smarttest/smart-init";
import type { Analyzer, FileAnalysis } from "@smarttest/source-parser";
import { SymbolIndex, type UpdateStats } from "@smarttest/symbol-index";
import {
  assignRunner,
  discoverTestFiles,
  isTestFile,
  type RunnerRoot,
} from "@smarttest/test-discovery";
import { type ExecutionEvent, executeGroups, type Group } from "@smarttest/test-executor";
import {
  applyGeneration,
  type GenerationItem,
  planGeneration,
  type SyncReport,
  syncReport,
} from "@smarttest/test-generator";
import { planExecution } from "@smarttest/test-selector";
import type { ChangeAnalysisInput, ChangeSource } from "@smarttest/vcs-core";
import { GitAdapter } from "@smarttest/vcs-git";

const ANALYZERS: Analyzer[] = [typescriptAnalyzer, javascriptAnalyzer];

export interface OpenOptions {
  root: string;
  configPath?: string;
  logger?: Logger;
}

export interface AnalyzeOptions {
  source?: ChangeSource;
  mode?: SafetyMode;
}

export interface Analysis {
  input: ChangeAnalysisInput;
  index: SymbolIndex;
  indexStats: UpdateStats;
  graph: DependencyGraph;
  diffs: Map<string, FileSemanticDiff>;
  testFiles: string[];
  unassignedTests: string[];
  runnerRoots: RunnerRoot[];
  decision: ImpactResult;
  timings: Record<string, number>;
}

export interface RunOptions extends AnalyzeOptions {
  all?: boolean;
  coverage?: boolean;
  retries?: number;
  timeoutMs?: number;
  workers?: number;
  signal?: AbortSignal;
  formats?: ("html" | "json" | "junit" | "markdown")[];
  outputDir?: string;
  command?: string;
  onEvent?: (event: ExecutionEvent) => void;
  onAnalysis?: (analysis: Analysis) => void;
}

export interface RunOutcome {
  report: RunReport;
  written: Record<string, string>;
  exitCode: number;
  analysis: Analysis;
  integrityIssues: string[];
}

export interface DoctorFinding {
  severity: "ok" | "info" | "warn" | "error";
  check: string;
  message: string;
  hint?: string;
}

export interface SelectionValidation {
  selected: number;
  skipped: number;
  failuresFound: string[];
  failuresMissed: { test: string; note: string }[];
  flakyInterference: string[];
  fullDurationMs: number;
  selectedDurationMs: number;
  analysisOverheadMs: number;
  savedPct: number;
  decision: ImpactResult;
}

const timed = async <T>(
  timings: Record<string, number>,
  name: string,
  fn: () => Promise<T> | T,
): Promise<T> => {
  const t = performance.now();
  try {
    return await fn();
  } finally {
    timings[name] = (timings[name] ?? 0) + (performance.now() - t);
  }
};

export class SmartTest {
  private profileCache: ProjectProfile | undefined;
  readonly storeDir: string;

  private constructor(
    readonly root: string,
    readonly loaded: LoadedConfig,
    public logger: Logger,
  ) {
    this.storeDir = join(root, loaded.config.storeDir);
  }

  static async open(options: OpenOptions): Promise<SmartTest> {
    const loaded = await loadConfig(options.root, options.configPath);
    return new SmartTest(options.root, loaded, options.logger ?? silentLogger);
  }

  useLogger(logger: Logger): this {
    this.logger = logger;
    return this;
  }

  get config(): ResolvedConfig {
    return this.loaded.config;
  }

  isTest = (path: string): boolean => isTestFile(path, this.config.tests.match);

  async profile(): Promise<ProjectProfile> {
    this.profileCache ??= await detectProject(this.root, { isTestFile: this.isTest });
    return this.profileCache;
  }

  async sourceFiles(): Promise<string[]> {
    const generatedExcludes = this.config.generated
      .filter((g) => g.policy === "exclude")
      .map((g) => g.path);
    return walkFiles(this.root, {
      include: this.config.include,
      exclude: [...this.config.exclude, ...generatedExcludes],
    });
  }

  async allFiles(): Promise<string[]> {
    return walkFiles(this.root, {
      exclude: this.config.exclude.filter((e) => !e.startsWith("smarttest.config")),
    });
  }

  async runnerRoots(): Promise<RunnerRoot[]> {
    const profile = await this.profile();
    let roots: RunnerRoot[] = profile.runners.map((r) => ({
      adapter: r.adapter,
      dir: r.dir,
      ...(r.configFile ? { configFile: r.configFile } : {}),
    }));
    if (this.config.adapters.length)
      roots = roots.filter((r) => this.config.adapters.includes(r.adapter));
    // A dependency without config still runs from the package dir; prefer roots with config at equal depth.
    return roots;
  }

  packageOf = (path: string): string | undefined => {
    const ws = this.profileCache?.workspaces ?? [];
    let best: { name: string; dir: string } | undefined;
    for (const w of ws)
      if (
        (path === w.dir || path.startsWith(`${w.dir}/`)) &&
        (!best || w.dir.length > best.dir.length)
      )
        best = w;
    return best?.name;
  };

  // ── VCS & snapshots ─────────────────────────────────────────────────────────────────────

  snapshots(): SnapshotStore {
    return new SnapshotStore(this.root, this.storeDir, () => this.sourceFilesForSnapshots());
  }

  private async sourceFilesForSnapshots(): Promise<string[]> {
    return walkFiles(this.root, {
      exclude: this.config.exclude.filter(
        (e) => !e.startsWith("smarttest.config") && !e.includes("package.json"),
      ),
    });
  }

  git(): GitAdapter {
    return new GitAdapter(this.root);
  }

  async provider(): Promise<"git" | "native"> {
    const p = this.config.vcs.provider;
    if (p !== "auto") return p;
    return (await this.git().detect()) ? "git" : "native";
  }

  async defaultSource(): Promise<ChangeSource> {
    const provider = await this.provider();
    if (provider === "native") return { kind: "snapshot" };
    if (this.config.vcs.base) return { kind: "base", ref: this.config.vcs.base };
    return { kind: "uncommitted" };
  }

  async changeInput(source?: ChangeSource): Promise<ChangeAnalysisInput> {
    const src = source ?? (await this.defaultSource());
    if (src.kind === "snapshot") return this.snapshots().getChangeInput(src);
    if ((await this.provider()) !== "git" && !(await this.git().detect())) {
      throw new SmartTestError("This project is not a Git repository", {
        code: "ST_NOT_GIT",
        category: "usage",
        hint: "Drop --base/--staged/--uncommitted to use native snapshots, or run `git init`.",
      });
    }
    return this.git().getChangeInput(src);
  }

  // ── Index & graph ───────────────────────────────────────────────────────────────────────

  async loadIndex(): Promise<{ index: SymbolIndex; stats: UpdateStats }> {
    const profile = await this.profile();
    const index = await SymbolIndex.load(this.storeDir);
    for (const w of index.loadWarnings) this.logger.warn(w);
    const resolver = new TypeScriptResolver(
      this.root,
      profile.workspaces.map((w) => ({ name: w.name, dir: w.dir, manifest: w.manifest })),
    );
    const contextFiles = [
      "package.json",
      ...profile.layout.tsconfigFiles,
      ...profile.workspaces.map((w) => `${w.dir}/package.json`),
    ];
    const { readFile } = await import("node:fs/promises");
    const contextKey = (
      await Promise.all(
        contextFiles.map(
          async (f) => `${f}:${await readFile(join(this.root, f), "utf8").catch(() => "")}`,
        ),
      )
    ).join("\n");
    const stats = await index.update({
      root: this.root,
      files: await this.sourceFiles(),
      analyzers: ANALYZERS,
      resolver,
      contextKey,
    });
    await index.save();
    return { index, stats };
  }

  buildGraph(index: SymbolIndex): DependencyGraph {
    return new DependencyGraph(index.entries(), this.isTest);
  }

  async discoverTests(
    index: SymbolIndex,
  ): Promise<{ tests: string[]; unassigned: string[]; roots: RunnerRoot[] }> {
    const roots = await this.runnerRoots();
    const candidates = discoverTestFiles([...index.entries().keys()], this.config.tests.match);
    if (!roots.length) return { tests: candidates, unassigned: [], roots };
    const tests: string[] = [];
    const unassigned: string[] = [];
    for (const t of candidates)
      (assignRunner(t, roots, this.config.adapters) ? tests : unassigned).push(t);
    return { tests, unassigned, roots };
  }

  // ── Analysis & impact ───────────────────────────────────────────────────────────────────

  async analyze(options: AnalyzeOptions = {}): Promise<Analysis> {
    const timings: Record<string, number> = {};
    const input = await timed(timings, "change detection", () => this.changeInput(options.source));
    const { index, stats } = await timed(timings, "index update", () => this.loadIndex());
    const graph = await timed(timings, "graph build", () => this.buildGraph(index));
    const { tests, unassigned, roots } = await this.discoverTests(index);
    const diffs = await timed(timings, "semantic diff", () => this.semanticDiffs(input, index));
    const decision = await timed(timings, "impact analysis", () =>
      decideImpact({
        changeSet: input.changeSet,
        diffs,
        graph,
        files: index.entries(),
        testFiles: tests,
        isTest: this.isTest,
        mode: options.mode ?? this.config.mode,
        triggers: [...BUILTIN_TRIGGERS, ...this.config.triggers],
        rules: new RulesEngine(this.config.rules),
        packageOf: this.packageOf,
      }),
    );
    if (unassigned.length)
      decision.warnings.push(
        `${unassigned.length} test file(s) are not covered by any configured runner: ${unassigned.slice(0, 3).join(", ")}`,
      );
    await writeJson(join(this.storeDir, "runs", "last-decision.json"), {
      createdAt: new Date().toISOString(),
      description: input.description,
      decision,
    });
    this.logger.info("impact decision", {
      source: input.description,
      changed: input.changeSet.changes.length,
      selected: decision.selectedTests.length,
      skipped: decision.skippedTests.length,
      status: decision.analysisStatus,
      mode: decision.safetyMode,
      timings,
    });
    this.logger.debug("index", { ...stats });
    return {
      input,
      index,
      indexStats: stats,
      graph,
      diffs,
      testFiles: tests,
      unassignedTests: unassigned,
      runnerRoots: roots,
      decision,
      timings,
    };
  }

  private async semanticDiffs(
    input: ChangeAnalysisInput,
    index: SymbolIndex,
  ): Promise<Map<string, FileSemanticDiff>> {
    const diffs = new Map<string, FileSemanticDiff>();
    const { readFile } = await import("node:fs/promises");
    for (const change of input.changeSet.changes) {
      if (change.type === "deleted") continue;
      const after = index.get(change.path);
      if (!after) continue;
      const analyzer = ANALYZERS.find((a) => a.supports(change.path));
      if (!analyzer) continue;
      if (change.type === "added") {
        diffs.set(change.path, {
          path: change.path,
          changes: [
            {
              filePath: change.path,
              kind: "exported-api",
              confidence: "high",
              notes: "file added",
            },
          ],
          units: ["*"],
          trivialOnly: false,
          confidence: "high",
        });
        continue;
      }
      const beforeText = await input.readBefore(change.previousPath ?? change.path);
      const afterText = await readFile(join(this.root, change.path), "utf8").catch(() => undefined);
      const before =
        beforeText !== undefined
          ? analyzer.analyze(change.previousPath ?? change.path, beforeText)
          : undefined;
      if (before) before.path = change.path;
      diffs.set(
        change.path,
        diffFile({
          path: change.path,
          ...(before ? { before } : {}),
          after,
          ...(beforeText !== undefined ? { beforeText } : {}),
          ...(afterText !== undefined ? { afterText } : {}),
          ...(change.changedRanges ? { ranges: change.changedRanges } : {}),
        }),
      );
    }
    return diffs;
  }

  // ── Run ─────────────────────────────────────────────────────────────────────────────────

  private createAdapter(group: Group, coverageDir?: string): TestAdapter {
    const cwd = join(this.root, group.dir);
    const g = group as Group & { configFile?: string };
    const base = { projectRoot: this.root, cwd, ...(coverageDir ? { coverageDir } : {}) };
    if (group.adapter === "jest") return new JestAdapter(base);
    if (group.adapter === "vitest") return new VitestAdapter(base);
    void g;
    throw new SmartTestError(`Unknown adapter ${group.adapter}`, {
      code: "ST_UNKNOWN_ADAPTER",
      category: "configuration",
    });
  }

  private coverageDirFor(group: Group): string {
    const h = createHash("sha256")
      .update(`${group.adapter}:${group.dir}`)
      .digest("hex")
      .slice(0, 8);
    return join(this.storeDir, "coverage", `${group.adapter}-${h}`);
  }

  async run(options: RunOptions = {}): Promise<RunOutcome> {
    const started = new Date();
    const runId = newRunId();
    const analysis = await this.analyze(options);
    const timings = analysis.timings;
    if (options.all) {
      const reason = { kind: "fallback" as const, message: "Full suite requested (--all)" };
      analysis.decision.selectedTests = analysis.testFiles.map((t) => ({
        testId: t,
        filePath: t,
        reasons: [reason],
      }));
      analysis.decision.skippedTests = [];
      analysis.decision.analysisStatus = "fallback";
      analysis.decision.fallbackApplied = true;
      analysis.decision.reasons.unshift(reason);
    }
    options.onAnalysis?.(analysis);
    if (!analysis.runnerRoots.length && analysis.decision.selectedTests.length) {
      throw new SmartTestError("No Jest or Vitest setup found", {
        code: "ST_NO_RUNNER",
        category: "infrastructure",
        hint: "Install vitest or jest in the project, or set `adapters` in smarttest.config.",
      });
    }
    const plan = planExecution(
      analysis.decision.selectedTests.map((t) => t.filePath),
      analysis.runnerRoots,
      this.config.adapters,
    );
    const coverageDirs: string[] = [];
    const summary = await timed(timings, "test execution", () =>
      executeGroups(plan.groups, {
        createAdapter: (g) => {
          const dir = options.coverage ? this.coverageDirFor(g) : undefined;
          if (dir) coverageDirs.push(join(dir, "coverage-final.json"));
          return this.createAdapter(g, dir);
        },
        timeoutMs: options.timeoutMs ?? this.config.timeoutMs,
        retries: options.retries ?? this.config.retries,
        ...(options.signal ? { signal: options.signal } : {}),
        ...((options.workers ?? this.config.workers)
          ? { workers: (options.workers ?? this.config.workers) as number }
          : {}),
        coverage: !!options.coverage,
        ...(options.onEvent ? { onEvent: options.onEvent } : {}),
      }),
    );
    const warnings: string[] = [];
    // Files the runner didn't collect (e.g. excluded by its own config) were not run — say so honestly.
    for (const f of summary.files) {
      if (
        f.status === "infrastructure-error" &&
        f.tests.length === 1 &&
        f.tests[0]?.error?.message.includes("no result")
      ) {
        warnings.push(
          `${f.file} was not collected by ${f.adapter} — check the runner's include patterns`,
        );
      }
    }
    let coverage: CoverageReport | undefined;
    if (options.coverage) {
      coverage = await timed(timings, "coverage", () =>
        ingestIstanbul(coverageDirs, this.root, options.all ? "full" : "selected", runId),
      );
      if (coverage) await writeJson(join(this.storeDir, "runs", "coverage.json"), coverage);
      else
        warnings.push(
          "Coverage was requested but no coverage report was produced — is a coverage provider installed?",
        );
    }
    const executions: FileExecution[] = summary.files.map((f) => ({ ...f }));
    const durationMs = Object.values(timings).reduce((a, b) => a + b, 0);
    const report: RunReport = {
      schemaVersion: 1,
      tool: TOOL,
      runId,
      command: options.command ?? (options.all ? "run --all" : "run --affected"),
      startedAt: started.toISOString(),
      finishedAt: new Date().toISOString(),
      project: (await this.profile()).name,
      mode: analysis.decision.safetyMode,
      change: { description: analysis.input.description, changeSet: analysis.input.changeSet },
      decision: stripDetails(analysis.decision),
      executions,
      summary: summarize(analysis.decision, executions, durationMs),
      ...(coverage
        ? {
            coverage: {
              scope: coverage.scope,
              lines: coverage.total.lines.pct,
              statements: coverage.total.statements.pct,
              functions: coverage.total.functions.pct,
              branches: coverage.total.branches.pct,
              files: Object.keys(coverage.files).length,
            },
          }
        : {}),
      timings,
      warnings: [...warnings, ...summary.infrastructureErrors],
    };
    const integrityIssues = validateReportIntegrity(report);
    this.logger.info("run finished", { runId, summary: report.summary, integrityIssues });
    for (const issue of integrityIssues) this.logger.error("report integrity violation", { issue });
    const written = await timed(timings, "reports", () =>
      writeReports(
        report,
        options.outputDir
          ? join(this.root, options.outputDir)
          : join(this.root, this.config.reports.outputDir),
        options.formats ?? this.config.reports.formats,
      ),
    );
    await writeJson(join(this.storeDir, "runs", `${runId}.json`), report);
    await writeJson(join(this.storeDir, "runs", "latest.json"), report);
    await this.recordFlaky(report);
    const status = overallStatus(report);
    // Advance the native baseline only after a fully passing run, so failures are never hidden.
    if (
      status === "passed" &&
      (analysis.input.changeSet.provider === "native" ||
        (this.config.vcs.snapshots && !options.source))
    ) {
      const snap = await this.snapshots().create({
        storeContent: this.config.snapshots.storeContent,
      });
      await this.snapshots().markVerified(snap.id, runId, "passed");
    }
    const exitCode =
      status === "error"
        ? ExitCode.InfrastructureFailure
        : status === "failed"
          ? ExitCode.TestFailure
          : ExitCode.Success;
    return { report, written, exitCode, analysis, integrityIssues };
  }

  private async recordFlaky(report: RunReport): Promise<void> {
    const flaky = report.executions.flatMap((e) =>
      e.tests.filter((t) => t.status === "flaky").map((t) => t.testId),
    );
    if (!flaky.length) return;
    const path = join(this.storeDir, "runs", "flaky.json");
    const data = (await readJson<Record<string, { count: number; lastRunId: string }>>(path)) ?? {};
    for (const id of flaky)
      data[id] = { count: (data[id]?.count ?? 0) + 1, lastRunId: report.runId };
    await writeJson(path, data);
  }

  async latestReport(): Promise<RunReport | undefined> {
    return readJson<RunReport>(join(this.storeDir, "runs", "latest.json"));
  }

  async rerenderReports(
    formats: ("html" | "json" | "junit" | "markdown")[],
    outputDir?: string,
  ): Promise<Record<string, string>> {
    const report = await this.latestReport();
    if (!report)
      throw new SmartTestError("No run recorded yet", {
        code: "ST_NO_RUN",
        category: "usage",
        hint: "Run `smarttest run --affected` first.",
      });
    return writeReports(
      report,
      outputDir ? join(this.root, outputDir) : join(this.root, this.config.reports.outputDir),
      formats,
    );
  }

  async coverage(): Promise<CoverageReport | undefined> {
    return readJson<CoverageReport>(join(this.storeDir, "runs", "coverage.json"));
  }

  // ── Explain & graph ─────────────────────────────────────────────────────────────────────

  async explain(target: string, options: AnalyzeOptions & { fresh?: boolean } = {}) {
    const saved = options.fresh
      ? undefined
      : await readJson<{ decision: ImpactResult; description: string }>(
          join(this.storeDir, "runs", "last-decision.json"),
        );
    const decision = saved?.decision ?? (await this.analyze(options)).decision;
    const description = saved?.description ?? "fresh analysis";
    if (
      this.isTest(target) ||
      decision.selectedTests.some((t) => t.filePath === target) ||
      decision.skippedTests.some((t) => t.filePath === target)
    ) {
      return {
        kind: "test" as const,
        target,
        description,
        mode: decision.safetyMode,
        analysisStatus: decision.analysisStatus,
        ...explainTest(decision, target),
      };
    }
    // A source file or symbol: which tests protect it?
    const { index } = await this.loadIndex();
    const graph = this.buildGraph(index);
    const [file, unit] = target.includes("#")
      ? (target.split("#") as [string, string])
      : [target, "*"];
    if (!index.get(file) && !graph.hasFile(file)) {
      throw new SmartTestError(`Unknown test, file or symbol: ${target}`, {
        code: "ST_UNKNOWN_TARGET",
        category: "usage",
        hint: "Use a project-relative path, e.g. src/auth/AuthService.ts or src/auth/AuthService.ts#AuthService",
      });
    }
    const hits = graph.dependentsOf([{ file, units: [unit] }]);
    const policy = new RulesEngine(this.config.rules).evaluateAll([
      { path: file },
      ...(index.get(file)?.symbols ?? []).map((s) => ({
        path: file,
        symbol: {
          name: s.name,
          qualifiedName: s.qualifiedName,
          kind: s.kind,
          decorators: s.decorators,
          ...(s.parent ? { parent: s.parent } : {}),
        },
      })),
    ]);
    return {
      kind: "source" as const,
      target,
      description,
      tests: [...hits.tests.values()].map((h) => ({ test: h.test, path: h.path })),
      uncertainty: graph.uncertaintyReachableFrom(file),
      rules: policy.matched.map((m) => m.rule.name),
      risk: policy.risk,
    };
  }

  async graphQuery(options: {
    from?: string;
    direction?: "dependents" | "dependencies";
    depth?: number;
  }) {
    const { index } = await this.loadIndex();
    const graph = this.buildGraph(index);
    if (!options.from) return { graph, stats: graph.stats };
    const [file, unit] = options.from.includes("#")
      ? (options.from.split("#") as [string, string])
      : [options.from, "*"];
    if (options.direction === "dependencies") {
      return { graph, stats: graph.stats, results: [...graph.dependenciesOf(file)].sort() };
    }
    const r = graph.dependentsOf([{ file, units: [unit] }]);
    const depth = options.depth ?? Number.POSITIVE_INFINITY;
    return {
      graph,
      stats: graph.stats,
      results: [...r.affectedFiles].filter((f) => f !== file).sort(),
      tests: [...r.tests.values()]
        .filter((t) => t.depth <= depth)
        .map((t) => ({ test: t.test, path: t.path })),
    };
  }

  // ── Generate ────────────────────────────────────────────────────────────────────────────

  async generate(
    options: {
      class?: string;
      module?: string;
      path?: string;
      type?: "unit" | "integration" | "e2e";
      dryRun?: boolean;
      sync?: boolean;
      source?: ChangeSource;
    } = {},
  ): Promise<{ items: GenerationItem[]; written: string[]; sync?: SyncReport }> {
    const profile = await this.profile();
    const { index } = await this.loadIndex();
    const graph = this.buildGraph(index);
    const { tests, roots } = await this.discoverTests(index);
    const runner = roots[0]?.adapter ?? "vitest";
    const pkg = await readJson<{ type?: string }>(join(this.root, "package.json"));
    const layout =
      this.config.tests.layout ?? (profile.tests.layout === "colocated" ? "colocated" : "mirror");
    const genOpts = {
      root: this.root,
      layout,
      directory: this.config.tests.directory,
      ...(this.config.tests.naming ? { naming: this.config.tests.naming } : {}),
      ...(this.config.tests.templates ? { templatesDir: this.config.tests.templates } : {}),
      runner,
      type: options.type ?? "unit",
      moduleType: (pkg?.type === "module" ? "esm" : profile.layout.typescript ? "esm" : "cjs") as
        | "esm"
        | "cjs",
      filter: {
        ...(options.class ? { class: options.class } : {}),
        ...(options.module ? { module: options.module } : {}),
        ...(options.path ? { path: options.path } : {}),
      },
      rules: new RulesEngine(this.config.rules),
      packageOf: this.packageOf,
    };
    const items = await planGeneration(index.entries(), tests, graph, genOpts);
    let sync: SyncReport | undefined;
    if (options.sync) {
      let renames: { from: string; to: string }[] = [];
      try {
        const input = await this.changeInput(options.source);
        renames = input.changeSet.changes
          .filter((c) => c.type === "renamed" && c.previousPath)
          .map((c) => ({ from: c.previousPath as string, to: c.path }));
      } catch {
        renames = [];
      }
      sync = syncReport(items, index.entries(), tests, renames, genOpts);
    }
    const written = options.dryRun || options.sync ? [] : await applyGeneration(this.root, items);
    return { items, written, ...(sync ? { sync } : {}) };
  }

  // ── Rules ───────────────────────────────────────────────────────────────────────────────

  rules(): RulesEngine {
    return new RulesEngine(this.config.rules);
  }

  async explainRules(target: string) {
    const engine = this.rules();
    const [file, symbolName] = target.includes("#")
      ? (target.split("#") as [string, string])
      : [target, undefined];
    const { index } = await this.loadIndex();
    const a = index.get(file);
    const symbols = (a?.symbols ?? []).filter(
      (s) => !symbolName || s.qualifiedName === symbolName || s.parent === symbolName,
    );
    const pkg = this.packageOf(file);
    const fileTarget = { path: file, ...(pkg ? { package: pkg } : {}) };
    const perSymbol = symbols.map((s) => ({
      symbol: s.qualifiedName,
      policy: engine.evaluate({
        ...fileTarget,
        symbol: {
          name: s.name,
          qualifiedName: s.qualifiedName,
          kind: s.kind,
          decorators: s.decorators,
          ...(s.visibility ? { visibility: s.visibility } : {}),
          ...(s.parent ? { parent: s.parent } : {}),
          ...(s.extends ? { extends: s.extends } : {}),
          ...(s.implements ? { implements: s.implements } : {}),
        },
      }),
    }));
    return {
      file: engine.evaluate(fileTarget),
      symbols: perSymbol.filter((p) => p.policy.matched.length),
      effective: engine.evaluateAll([
        fileTarget,
        ...symbols.map((s) => ({
          ...fileTarget,
          symbol: {
            name: s.name,
            qualifiedName: s.qualifiedName,
            kind: s.kind,
            decorators: s.decorators,
            ...(s.parent ? { parent: s.parent } : {}),
          },
        })),
      ]),
    };
  }

  // ── Init / doctor / uninstall ───────────────────────────────────────────────────────────

  async initPlan(overrides: Parameters<typeof buildPlan>[2]["overrides"] = {}): Promise<SetupPlan> {
    const profile = await this.profile();
    const { index } = await this.loadIndex();
    const graph = this.buildGraph(index);
    const { tests } = await this.discoverTests(index);
    const sources = [...index.entries().keys()].filter((f) => !this.isTest(f));
    const tested = new Set(tests.flatMap((t) => [...graph.dependenciesOf(t)]));
    const untested = sources.filter(
      (s) =>
        !tested.has(s) && !/(?:^|\/)(?:index|main)\.[cm]?[jt]sx?$/.test(s) && !/\.config\./.test(s),
    );
    const files = await this.allFiles();
    const globalConfigFiles = files.filter(
      (f) => BUILTIN_TRIGGERS.some((t) => matchGlob(f, t)) && !/lock|package\.json/.test(f),
    );
    return buildPlan(profile, sources, { untestedModules: untested, globalConfigFiles, overrides });
  }

  async initApply(
    plan: SetupPlan,
    options: { onlyLowRisk?: boolean } = {},
  ): Promise<{
    applied: string[];
    validation: { ok: boolean; messages: string[] };
    reportPath: string;
  }> {
    const journal = await applyPlan(this.root, this.storeDir, plan, options);
    const applied = plan.files
      .filter((f) => f.action !== "skip" && journal.entries.some((e) => e.path === f.path))
      .map((f) => f.path);
    const validation = await this.validateSetup();
    const reportPath = join(this.storeDir, "reports", "setup.md");
    const { writeFileAtomic } = await import("@smarttest/shared");
    await writeFileAtomic(reportPath, renderSetupReport(plan, applied, validation));
    return { applied, validation, reportPath };
  }

  async validateSetup(): Promise<{ ok: boolean; messages: string[] }> {
    const messages: string[] = [];
    let ok = true;
    try {
      const fresh = await loadConfig(this.root);
      messages.push(
        fresh.path
          ? `Configuration valid (${fresh.path.slice(this.root.length + 1)})`
          : "No configuration file (defaults in use)",
      );
    } catch (error) {
      ok = false;
      messages.push((error as Error).message);
    }
    const roots = await this.runnerRoots();
    if (!roots.length) {
      ok = false;
      messages.push("No test runner detected");
    }
    for (const r of roots) {
      try {
        const cases = await this.createAdapter({
          adapter: r.adapter,
          dir: r.dir,
          files: [],
        }).discover();
        messages.push(`${r.adapter} (${r.dir || "."}) discovers ${cases.length} test file(s)`);
      } catch (error) {
        ok = false;
        messages.push(
          `${r.adapter} (${r.dir || "."}) discovery failed: ${(error as Error).message}`,
        );
      }
    }
    return { ok, messages };
  }

  async rollbackInit(options: { dryRun?: boolean } = {}) {
    return rollback(this.root, this.storeDir, options);
  }

  async uninstall(options: { dryRun?: boolean } = {}) {
    const plan = await planUninstall(this.root, this.storeDir);
    if (options.dryRun) return { plan, done: [] as string[] };
    return { plan, done: await applyUninstall(this.root, plan) };
  }

  async doctor(): Promise<DoctorFinding[]> {
    const out: DoctorFinding[] = [];
    const profile = await this.profile();
    out.push(
      profile.runtime.nodeSupported
        ? {
            severity: "ok",
            check: "runtime",
            message: `Node ${profile.runtime.node} on ${profile.runtime.os}/${profile.runtime.arch}`,
          }
        : {
            severity: "error",
            check: "runtime",
            message: `Node ${profile.runtime.node} is not supported`,
            hint: "Use Node 22.12+ or 24 LTS",
          },
    );
    out.push(
      this.loaded.path
        ? {
            severity: "ok",
            check: "config",
            message: `Using ${this.loaded.path.slice(this.root.length + 1)}`,
          }
        : {
            severity: "info",
            check: "config",
            message: "No smarttest.config found — defaults in use",
            hint: "Run `smarttest init`",
          },
    );
    for (const w of this.loaded.warnings)
      out.push({ severity: "warn", check: "config", message: `${w.path}: ${w.message}` });
    const rulesIssues = this.rules().validate();
    for (const r of rulesIssues)
      out.push({
        severity: "error",
        check: "rules",
        message: r,
        hint: "Run `smarttest rules validate`",
      });
    if (!profile.runtime.rootWritable)
      out.push({
        severity: "error",
        check: "filesystem",
        message: "Project root is not writable",
        hint: "SmartTest stores state in .smarttest/",
      });
    const provider = await this.provider();
    if (provider === "git") {
      const state = await this.git().getWorkingState();
      out.push({
        severity: state.warnings.length ? "warn" : "ok",
        check: "vcs",
        message: `Git · ${state.head?.ref ?? "no commits"}${state.dirty ? " · uncommitted changes" : ""}`,
        ...(state.warnings.length ? { hint: state.warnings.join("; ") } : {}),
      });
    } else {
      const latest = await this.snapshots().latest();
      out.push(
        latest
          ? {
              severity: "ok",
              check: "vcs",
              message: `Native snapshots · latest ${latest.id}${latest.verified ? " (verified baseline)" : ""}`,
            }
          : {
              severity: "info",
              check: "vcs",
              message: "Native snapshots · no baseline yet (first run executes the full suite)",
            },
      );
    }
    for (const u of profile.vcs.unsupported)
      out.push({ severity: "warn", check: "vcs", message: u });
    try {
      const { index, stats } = await this.loadIndex();
      const s = index.stats();
      out.push({
        severity: "ok",
        check: "index",
        message: `${s.files} files · ${s.symbols} symbols · ${stats.parsed} re-parsed, ${stats.reused} reused`,
      });
      if (s.unresolved)
        out.push({
          severity: "warn",
          check: "index",
          message: `${s.unresolved} unresolved import(s) — affected tests are widened in balanced/safe modes`,
          hint: "Run `smarttest scan` to list them",
        });
      if (s.dynamic)
        out.push({
          severity: "info",
          check: "index",
          message: `${s.dynamic} dynamic import(s)/require(s) with non-literal paths`,
        });
      const { tests, unassigned, roots } = await this.discoverTests(index);
      if (!roots.length)
        out.push({
          severity: "error",
          check: "runner",
          message: "No Jest or Vitest setup found",
          hint: "Install vitest or jest",
        });
      for (const r of roots) {
        try {
          const discovered = await this.createAdapter({
            adapter: r.adapter,
            dir: r.dir,
            files: [],
          }).discover();
          const staticSet = new Set(
            tests.filter(
              (t) =>
                assignRunner(t, roots)?.dir === r.dir &&
                assignRunner(t, roots)?.adapter === r.adapter,
            ),
          );
          const runnerSet = new Set(discovered.map((d) => d.filePath));
          const onlyStatic = [...staticSet].filter((t) => !runnerSet.has(t));
          const onlyRunner = [...runnerSet].filter((t) => !staticSet.has(t));
          out.push({
            severity: "ok",
            check: "runner",
            message: `${r.adapter} (${r.dir || "."}) discovers ${runnerSet.size} test file(s)`,
          });
          if (onlyStatic.length)
            out.push({
              severity: "warn",
              check: "runner",
              message: `${onlyStatic.length} file(s) look like tests but ${r.adapter} doesn't collect them: ${onlyStatic.slice(0, 3).join(", ")}`,
              hint: "Adjust the runner include patterns or `tests.match`",
            });
          if (onlyRunner.length)
            out.push({
              severity: "warn",
              check: "runner",
              message: `${onlyRunner.length} test file(s) collected by ${r.adapter} aren't recognised by SmartTest: ${onlyRunner.slice(0, 3).join(", ")}`,
              hint: "Set `tests.match` in smarttest.config",
            });
        } catch (error) {
          out.push({
            severity: "error",
            check: "runner",
            message: (error as Error).message,
            hint: "Is the runner installed? Try running it directly.",
          });
        }
      }
      if (unassigned.length)
        out.push({
          severity: "warn",
          check: "runner",
          message: `${unassigned.length} test file(s) outside any runner root`,
        });
    } catch (error) {
      out.push({ severity: "error", check: "index", message: (error as Error).message });
    }
    if (!(await exists(join(this.root, "node_modules"))))
      out.push({
        severity: "warn",
        check: "dependencies",
        message: "node_modules not found at the project root",
        hint: "Install dependencies first",
      });
    return out;
  }

  // ── Validate selection ──────────────────────────────────────────────────────────────────

  async validateSelection(
    options: AnalyzeOptions & { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<SelectionValidation> {
    const t0 = performance.now();
    const analysis = await this.analyze(options);
    const analysisOverheadMs = performance.now() - t0;
    const plan = planExecution(analysis.testFiles, analysis.runnerRoots, this.config.adapters);
    const full = await executeGroups(plan.groups, {
      createAdapter: (g) => this.createAdapter(g),
      timeoutMs: options.timeoutMs ?? this.config.timeoutMs,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const selected = new Set(analysis.decision.selectedTests.map((t) => t.filePath));
    const failing = full.files.filter((f) => f.status === "failed" || f.status === "timed-out");
    const fullDurationMs = full.files.reduce((a, f) => a + f.durationMs, 0);
    const selectedDurationMs = full.files
      .filter((f) => selected.has(f.file))
      .reduce((a, f) => a + f.durationMs, 0);
    return {
      selected: selected.size,
      skipped: analysis.decision.skippedTests.length,
      failuresFound: failing.filter((f) => selected.has(f.file)).map((f) => f.file),
      failuresMissed: failing
        .filter((f) => !selected.has(f.file))
        .map((f) => ({
          test: f.file,
          note: "failed in the full run but was not selected (may be a pre-existing failure — compare with a clean checkout)",
        })),
      flakyInterference: full.files.filter((f) => f.status === "flaky").map((f) => f.file),
      fullDurationMs,
      selectedDurationMs,
      analysisOverheadMs,
      savedPct: fullDurationMs
        ? Math.max(
            0,
            Math.round(
              ((fullDurationMs - selectedDurationMs - analysisOverheadMs) / fullDurationMs) * 100,
            ),
          )
        : 0,
      decision: analysis.decision,
    };
  }

  async scan() {
    const profile = await this.profile();
    const { index, stats } = await this.loadIndex();
    const graph = this.buildGraph(index);
    const { tests, unassigned } = await this.discoverTests(index);
    const unresolved: { file: string; specifier: string; reason: string }[] = [];
    for (const a of index.entries().values())
      for (const i of a.imports)
        if (i.unresolved && !i.missing)
          unresolved.push({ file: a.path, specifier: i.specifier, reason: i.unresolved });
    const dynamic = [...index.entries().values()].flatMap((a: FileAnalysis) =>
      a.dynamicUnresolved.map((d) => ({ file: a.path, detail: d })),
    );
    return {
      profile,
      vcs: await this.provider(),
      index: {
        ...index.stats(),
        parsed: stats.parsed,
        reused: stats.reused,
        durationMs: stats.durationMs,
      },
      graph: graph.stats,
      tests: { total: tests.length, unassigned },
      unresolved,
      dynamic,
    };
  }
}

function stripDetails(decision: ImpactResult): RunReport["decision"] {
  const { details: _details, ...rest } = decision;
  return rest;
}
