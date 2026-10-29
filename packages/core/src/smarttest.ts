import { createHash } from "node:crypto";
import { join, relative } from "node:path";
import { CypressAdapter } from "@smarttest/adapter-cypress";
import { JestAdapter } from "@smarttest/adapter-jest";
import { NodeTestAdapter } from "@smarttest/adapter-node";
import { PlaywrightAdapter } from "@smarttest/adapter-playwright";
import { VitestAdapter } from "@smarttest/adapter-vitest";
import {
  BUILTIN_TRIGGERS,
  effectiveRules,
  type LoadedConfig,
  loadConfig,
  type ResolvedConfig,
} from "@smarttest/config";
import { type CoverageReport, ingestIstanbul } from "@smarttest/coverage-engine";
import { DependencyGraph, nextRoutes } from "@smarttest/dependency-graph";
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
import {
  diffCatalog,
  diffFile,
  diffResource,
  type FileSemanticDiff,
  isEnvFile,
  isJsonCatalog,
  isPrismaSchema,
  type ResourceChange,
} from "@smarttest/semantic-diff";
import type { TestAdapter } from "@smarttest/shared";
import {
  ExitCode,
  exists,
  type Logger,
  matchGlob,
  readJson,
  readText,
  type SafetyMode,
  SmartTestError,
  sha256,
  silentLogger,
  walkFiles,
  writeJson,
} from "@smarttest/shared";
import {
  applyPlan,
  applyUninstall,
  buildPlan,
  type FilePlan,
  type HookManager,
  type HookPlan,
  type MigratePlan,
  planHookInstall,
  planHookUninstall,
  planMigrate,
  planUninstall,
  renderSetupReport,
  rollback,
  type SetupPlan,
} from "@smarttest/smart-init";
import type { Analyzer, FileAnalysis } from "@smarttest/source-parser";
import { LOCALE_PATH } from "@smarttest/source-parser";
import { SymbolIndex, type UpdateStats } from "@smarttest/symbol-index";
import {
  assignRunner,
  discoverTestFiles,
  expandNodePatterns,
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
import { planExecution, rootKey } from "@smarttest/test-selector";
import type { ChangeAnalysisInput, ChangeSource } from "@smarttest/vcs-core";
import { GitAdapter } from "@smarttest/vcs-git";
import { ParsePool, parallelParsingAvailable } from "./parse-pool.js";
import { detectDrift, patchConfig, type SyncResult } from "./sync.js";
import {
  cleanDir,
  hashFile,
  loadTraces,
  readV8Coverage,
  saveTraces,
  TRACE_STORE_VERSION,
  type TraceStore,
  TraceView,
} from "./traces.js";
import { type Watcher, watchProject } from "./watch.js";

const ANALYZERS: Analyzer[] = [typescriptAnalyzer, javascriptAnalyzer];

export interface OpenOptions {
  root: string;
  configPath?: string;
  logger?: Logger;
}

export interface AnalyzeOptions {
  source?: ChangeSource;
  mode?: SafetyMode;
  /** Select every test without building the graph (adaptive policy). */
  everything?: { reason: string };
  /** A ready-made change set (watch mode) instead of `source`. */
  input?: ChangeAnalysisInput;
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
  /** Which runner root collected each test file. */
  assignment: Map<string, RunnerRoot>;
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

export interface ShadowRecord {
  at: string;
  head?: string;
  mode: string;
  changed: number;
  selected: number;
  total: number;
  failuresFound: string[];
  failuresMissed: string[];
  observedSkips: number;
  fullMs: number;
  selectedMs: number;
}

export interface ShadowReport {
  runs: number;
  missed: number;
  runsWithMisses: number;
  selected: number;
  total: number;
  savedPct: number;
  records: ShadowRecord[];
}

/**
 * Test files a runner collects with its default patterns, when its configuration sets nothing
 * about which files are tests (no include/testMatch/projects…). Undefined means "ask the runner".
 */
async function staticDefaultDiscovery(
  projectRoot: string,
  root: RunnerRoot,
  cfg: string,
  pkg: string,
  candidates: string[],
): Promise<string[] | undefined> {
  const rel = (f: string) => (root.dir ? f.slice(root.dir.length + 1) : f);
  const settings =
    /\b(include|exclude|testMatch|testRegex|roots|rootDir|projects|workspace|dir|root|preset|testPathIgnorePatterns|mergeConfig|extends)\b/;
  if (root.adapter === "vitest") {
    if (settings.test(cfg)) return undefined;
    if (!root.configFile)
      for (const v of ["vite.config.ts", "vite.config.js", "vite.config.mjs", "vite.config.mts"])
        if (await exists(join(projectRoot, root.dir, v))) return undefined;
    return candidates.filter((f) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(rel(f)));
  }
  if (root.adapter === "jest") {
    if (settings.test(cfg)) return undefined;
    if (/"jest"\s*:/.test(pkg)) return undefined;
    return candidates.filter(
      (f) =>
        /(^|\/)__tests__\/.+\.[cm]?[jt]sx?$/.test(rel(f)) ||
        /(^|[/.])(spec|test)\.[cm]?[jt]sx?$/.test(rel(f)),
    );
  }
  return undefined;
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
  private resolver: TypeScriptResolver | undefined;
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
    let roots: RunnerRoot[] = this.config.runners.length
      ? this.config.runners.map((r) => ({
          adapter: r.adapter,
          dir: r.dir ?? "",
          ...(r.config ? { configFile: r.config } : {}),
          ...(r.patterns ? { patterns: r.patterns } : {}),
        }))
      : profile.runners.map((r) => ({
          adapter: r.adapter,
          dir: r.dir,
          ...(r.configFile ? { configFile: r.configFile } : {}),
          ...(r.patterns ? { patterns: r.patterns } : {}),
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
    if (src.kind === "snapshot")
      return this.withoutOwnState(await this.snapshots().getChangeInput(src));
    if ((await this.provider()) !== "git" && !(await this.git().detect())) {
      throw new SmartTestError("This project is not a Git repository", {
        code: "ST_NOT_GIT",
        category: "usage",
        hint: "Drop --base/--staged/--uncommitted to use native snapshots, or run `git init`.",
      });
    }
    return this.withoutOwnState(await this.git().getChangeInput(src));
  }

  /** SmartTest's own state (store, reports) is never a change to the project. */
  private withoutOwnState(input: ChangeAnalysisInput): ChangeAnalysisInput {
    const own = [this.config.storeDir, this.config.reports.outputDir].map((d) =>
      d.replace(/^\.\//, "").replace(/\/$/, ""),
    );
    const changes = input.changeSet.changes.filter(
      (c) => !own.some((d) => c.path === d || c.path.startsWith(`${d}/`)),
    );
    return changes.length === input.changeSet.changes.length
      ? input
      : { ...input, changeSet: { ...input.changeSet, changes } };
  }

  // ── Index & graph ───────────────────────────────────────────────────────────────────────

  async loadIndex(): Promise<{ index: SymbolIndex; stats: UpdateStats }> {
    const index = await SymbolIndex.load(this.storeDir);
    // Cold start (no index, or one from another analyzer version) of a large project: parser
    // threads start before files are read, so their start-up overlaps with reading.
    const sample = index.entries().values().next().value as FileAnalysis | undefined;
    const cold =
      index.size === 0 ||
      (sample !== undefined && !ANALYZERS.some((a) => a.version === sample.analyzerVersion));
    const profile = await this.profile();
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
    this.resolver = resolver;
    const files = await this.sourceFiles();
    const pool =
      cold && files.length >= 300 && parallelParsingAvailable() ? new ParsePool() : undefined;
    const stats = await index
      .update({
        root: this.root,
        files,
        analyzers: ANALYZERS,
        resolver,
        contextKey,
        ...(pool
          ? {
              parseMany: async (jobs: { path: string; content: string }[]) =>
                (await pool.parse(jobs)) as FileAnalysis[] | undefined,
            }
          : {}),
      })
      .finally(() => pool?.close());
    await index.save();
    return { index, stats };
  }

  buildGraph(index: SymbolIndex, e2eTests?: ReadonlySet<string>): DependencyGraph {
    const files = [...index.entries().keys()];
    // Next.js projects: directories with a next.config, or the root when Next.js was detected.
    const nextRoots = new Set(
      files
        .filter((f) => /(?:^|\/)next\.config\.[cm]?[jt]s$/.test(f))
        .map((f) => (f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : "")),
    );
    if (this.profileCache?.frameworks.some((f) => f.value === "Next.js")) nextRoots.add("");
    const routes = nextRoots.size ? nextRoutes(files, [...nextRoots]) : [];
    return new DependencyGraph(index.entries(), this.isTest, {
      ...(routes.length ? { routes } : {}),
      ...(e2eTests?.size ? { e2eTests } : {}),
    });
  }

  /**
   * Test discovery. In "runner" mode (default) every runner root is asked which files it actually
   * collects (respecting its own include/exclude config), cached until its config, package.json or
   * the set of test-looking files changes. "static" mode uses filename patterns only.
   */
  async discoverTests(
    index: SymbolIndex,
    options: { fresh?: boolean } = {},
  ): Promise<{
    tests: string[];
    unassigned: string[];
    roots: RunnerRoot[];
    assignment: Map<string, RunnerRoot>;
    warnings: string[];
    perRoot: Map<string, number>;
  }> {
    const roots = await this.runnerRoots();
    const analysed = [...index.entries().keys()];
    const analysedSet = new Set(analysed);
    const looksLikeTest = (f: string, root?: RunnerRoot) => {
      if (this.isTest(f)) return true;
      if (root?.adapter !== "node") return false;
      const rel = root.dir ? f.slice(root.dir.length + 1) : f;
      return matchGlob(rel, expandNodePatterns(root.patterns));
    };
    const staticCandidates = discoverTestFiles(analysed, this.config.tests.match);
    const assignment = new Map<string, RunnerRoot>();
    const warnings: string[] = [];
    const perRoot = new Map<string, number>();
    if (!roots.length)
      return { tests: staticCandidates, unassigned: [], roots, assignment, warnings, perRoot };
    const inRoot = (f: string, root: RunnerRoot) => root.dir === "" || f.startsWith(`${root.dir}/`);
    if (this.config.tests.discovery === "static") {
      const unassigned: string[] = [];
      const candidates = new Set([
        ...staticCandidates,
        ...analysed.filter((f) =>
          roots.some((r) => r.adapter === "node" && inRoot(f, r) && looksLikeTest(f, r)),
        ),
      ]);
      for (const t of [...candidates].sort()) {
        const r = assignRunner(t, roots, this.config.adapters);
        if (r) assignment.set(t, r);
        else unassigned.push(t);
      }
      for (const r of roots)
        perRoot.set(rootKey(r), [...assignment.values()].filter((x) => x === r).length);
      return { tests: [...assignment.keys()], unassigned, roots, assignment, warnings, perRoot };
    }
    const cachePath = join(this.storeDir, "state", "discovery.json");
    const cache = options.fresh
      ? {}
      : ((await readJson<Record<string, string[]>>(cachePath)) ?? {});
    const nextCache: Record<string, string[]> = {};
    // Runners are asked in parallel; a runner whose config sets nothing about test files is not
    // asked at all: its default patterns are applied here (no process start).
    const listed = await Promise.all(
      roots.map(async (root) => {
        const candidates = analysed.filter((f) => inRoot(f, root) && looksLikeTest(f, root)).sort();
        const cfg = root.configFile
          ? ((await readText(join(this.root, root.configFile))) ?? "")
          : "";
        const pkg = (await readText(join(this.root, root.dir, "package.json"))) ?? "";
        const key = sha256(
          [rootKey(root), (root.patterns ?? []).join(","), cfg, pkg, candidates.join("\n")].join(
            "\u0000",
          ),
        );
        let files = cache[key];
        if (!files) files = await staticDefaultDiscovery(this.root, root, cfg, pkg, candidates);
        if (!files) {
          try {
            files = (
              await this.createAdapter({
                adapter: root.adapter,
                dir: root.dir,
                files: [],
                ...(root.configFile ? { configFile: root.configFile } : {}),
                ...(root.patterns ? { patterns: root.patterns } : {}),
              } as Group).discover()
            ).map((t) => t.filePath);
          } catch (error) {
            warnings.push(
              `${root.adapter} (${root.dir || "."}) discovery failed — using filename patterns: ${(error as Error).message.split("\n")[0]}`,
            );
            files = candidates;
          }
        }
        return { root, key, files };
      }),
    );
    for (const { root, key, files } of listed) {
      nextCache[key] = files;
      let count = 0;
      for (const f of files) {
        if (!analysedSet.has(f)) continue; // excluded by smarttest config
        // Several runners may collect the same file: the deepest project owns it.
        const prev = assignment.get(f);
        if (!prev || root.dir.length > prev.dir.length) assignment.set(f, root);
        count++;
      }
      perRoot.set(rootKey(root), count);
    }
    await writeJson(cachePath, nextCache);
    const tests = [...assignment.keys()].sort();
    const unassigned = staticCandidates.filter((f) => !assignment.has(f));
    return { tests, unassigned, roots, assignment, warnings, perRoot };
  }

  // ── Analysis & impact ───────────────────────────────────────────────────────────────────

  async analyze(options: AnalyzeOptions = {}): Promise<Analysis> {
    const timings: Record<string, number> = {};
    const input = options.input
      ? this.withoutOwnState(options.input)
      : await timed(timings, "change detection", () => this.changeInput(options.source));
    const { index, stats } = await timed(timings, "index update", () => this.loadIndex());
    if (options.everything) {
      const { tests, unassigned, roots, assignment } = await this.discoverTests(index);
      const reason = { kind: "fallback" as const, message: options.everything.reason };
      const decision = {
        selectedTests: tests.map((t) => ({ testId: t, filePath: t, reasons: [reason] })),
        skippedTests: [],
        affectedFiles: input.changeSet.changes.map((c) => c.path),
        affectedSymbols: [],
        analysisStatus: "fallback" as const,
        safetyMode: options.mode ?? this.config.mode,
        requestedMode: options.mode ?? this.config.mode,
        reasons: [reason],
        warnings: [],
        fallbackApplied: true,
        details: { triggers: [], seeds: [], trivialSkipped: [], ignored: [], uncertainty: [] },
      } satisfies ImpactResult;
      return {
        input,
        index,
        indexStats: stats,
        graph: new DependencyGraph(new Map(), this.isTest),
        diffs: new Map(),
        testFiles: tests,
        unassignedTests: unassigned,
        runnerRoots: roots,
        assignment,
        decision,
        timings,
      };
    }
    const {
      tests,
      unassigned,
      roots,
      assignment,
      warnings: discoveryWarnings,
    } = await this.discoverTests(index);
    const e2eTests = new Set(
      [...assignment]
        .filter(([, r]) => r.adapter === "playwright" || r.adapter === "cypress")
        .map(([t]) => t),
    );
    const graph = await timed(timings, "graph build", () => this.buildGraph(index, e2eTests));
    const graphDiff: { file: string; added: string[]; removed: string[] }[] = [];
    const resources = new Map<string, ResourceChange>();
    const diffs = await timed(timings, "semantic diff", () =>
      this.semanticDiffs(input, index, graphDiff, resources),
    );
    const traceView = await this.traceView(input, index);
    const decision = await timed(timings, "impact analysis", () =>
      decideImpact({
        ...(traceView?.size ? { traces: traceView } : {}),
        changeSet: input.changeSet,
        diffs,
        graph,
        files: index.entries(),
        testFiles: tests,
        isTest: this.isTest,
        mode: options.mode ?? this.config.mode,
        triggers: [...BUILTIN_TRIGGERS, ...this.config.triggers],
        rules: new RulesEngine(effectiveRules(this.config)),
        packageOf: this.packageOf,
        resources,
        generated: this.config.generated
          .filter((g) => g.policy === "rebuild-required" && g.from?.length)
          .map((g) => ({ path: g.path, from: g.from ?? [] })),
      }),
    );
    if (graphDiff.length) decision.details.graphDiff = graphDiff;
    decision.warnings.push(...discoveryWarnings);
    const profileNow = this.profileCache;
    if (profileNow) {
      const drift = detectDrift(this.config, this.loaded.raw, profileNow).filter(
        (d) => d.key === "adapters" || d.key === "vcs.provider",
      );
      if (drift.length)
        decision.warnings.push(
          `Configuration is out of date (${drift.map((d) => `${d.key}: ${d.reason}`).join("; ")}) — run \`smarttest sync\``,
        );
    }
    if (unassigned.length)
      decision.warnings.push(
        `${unassigned.length} file(s) look like tests but no runner collects them, so they never run (e.g. ${unassigned.slice(0, 2).join(", ")})`,
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
      assignment,
      decision,
      timings,
    };
  }

  /** Fingerprint of the runtime and installed dependencies traces depend on. */
  async envFingerprint(): Promise<string> {
    const profile = await this.profile();
    const parts = [`node ${process.versions.node.split(".")[0]}`];
    for (const dir of ["", ...profile.workspaces.map((w) => w.dir)])
      for (const lock of ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock"]) {
        const f = dir ? `${dir}/${lock}` : lock;
        const h = await hashFile(this.root, f);
        if (h) parts.push(`${f}:${h.slice(0, 16)}`);
      }
    return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 16);
  }

  /** Traces seen at the base of the change: changed files are compared with their old content. */
  async traceView(
    input: ChangeAnalysisInput | undefined,
    index: SymbolIndex,
  ): Promise<TraceView | undefined> {
    const store = await loadTraces(this.storeDir);
    if (!store || !Object.keys(store.tests).length) return undefined;
    const traced = new Set<string>();
    for (const t of Object.values(store.tests))
      for (const f of Object.keys(t.fileHashes)) traced.add(f);
    const base = new Map<string, string | undefined>();
    const changed = new Map((input?.changeSet.changes ?? []).map((c) => [c.path, c]));
    for (const f of traced) {
      const c = changed.get(f);
      if (c) {
        const before =
          c.type === "added" || !input ? undefined : await input.readBefore(c.previousPath ?? f);
        base.set(f, before === undefined ? undefined : sha256(before));
      } else base.set(f, index.get(f)?.hash ?? (await hashFile(this.root, f)));
    }
    return new TraceView(store, await this.envFingerprint(), (f) => base.get(f), index.entries());
  }

  /**
   * Runs each test file on its own with V8 coverage and stores which functions it ran
   * (`smarttest trace`). With `stale`, only tests without a fresh trace are run.
   */
  async collectTraces(
    options: {
      files?: string[];
      stale?: boolean;
      concurrency?: number;
      timeoutMs?: number;
      onProgress?: (message: string) => void;
    } = {},
  ): Promise<{ traced: number; failed: string[]; kept: number; store: TraceStore }> {
    const { index } = await this.loadIndex();
    const { tests, roots, assignment } = await this.discoverTests(index);
    const env = await this.envFingerprint();
    const previous = await loadTraces(this.storeDir);
    const store: TraceStore = {
      version: TRACE_STORE_VERSION,
      env,
      tests: previous?.env === env ? { ...previous.tests } : {},
    };
    let wanted = options.files?.length ? tests.filter((t) => options.files?.includes(t)) : tests;
    if (options.stale) {
      const view = await this.traceView(undefined, index);
      wanted = wanted.filter((t) => !view?.isFresh(t));
    }
    for (const t of Object.keys(store.tests)) if (!tests.includes(t)) delete store.tests[t];
    const plan = planExecution(wanted, roots, this.config.adapters, assignment);
    const jobs = plan.groups.flatMap((g) => g.files.map((file) => ({ group: g, file })));
    const failed: string[] = [];
    const total = jobs.length;
    let done = 0;
    const tmp = join(this.storeDir, "tmp", "traces");
    await cleanDir(tmp);
    const worker = async (): Promise<void> => {
      for (let job = jobs.shift(); job; job = jobs.shift()) {
        const dir = join(tmp, `${total - jobs.length}-${process.pid}`);
        const adapter = this.createAdapter({ ...job.group, files: [job.file] });
        const run = await adapter
          .execute(
            { files: [job.file] },
            {
              env: { NODE_V8_COVERAGE: dir },
              trace: true,
              timeoutMs: options.timeoutMs ?? this.config.timeoutMs,
            },
          )
          .catch(() => undefined);
        const statuses = (run?.executions ?? []).map((e) => e.status);
        const passed =
          statuses.length > 0 &&
          statuses.every((s) => s === "passed" || s === "skipped" || s === "pending");
        const { executed, known } = await readV8Coverage(dir, this.root);
        await cleanDir(dir);
        done++;
        if (!passed || !executed.has(job.file)) {
          failed.push(job.file);
          delete store.tests[job.file];
          options.onProgress?.(
            `[${done}/${total}] ${job.file} — not traced${passed ? " (no coverage written)" : " (failed)"}`,
          );
          continue;
        }
        const fileHashes: Record<string, string> = {};
        for (const f of executed.keys()) {
          const h = index.get(f)?.hash ?? (await hashFile(this.root, f));
          if (h) fileHashes[f] = h;
        }
        store.tests[job.file] = {
          at: new Date().toISOString(),
          status: "passed",
          fileHashes,
          executed: Object.fromEntries([...executed].map(([f, s]) => [f, [...s].sort()])),
          known: Object.fromEntries([...known].map(([f, s]) => [f, [...s].sort()])),
        };
        options.onProgress?.(`[${done}/${total}] ${job.file} — ${executed.size} file(s)`);
      }
    };
    const n = Math.max(1, Math.min(options.concurrency ?? 4, jobs.length));
    await Promise.all(Array.from({ length: n }, () => worker()));
    await cleanDir(tmp);
    await saveTraces(this.storeDir, store);
    return { traced: total - failed.length, failed, kept: Object.keys(store.tests).length, store };
  }

  private async semanticDiffs(
    input: ChangeAnalysisInput,
    index: SymbolIndex,
    graphDiff: { file: string; added: string[]; removed: string[] }[] = [],
    resources = new Map<string, ResourceChange>(),
  ): Promise<Map<string, FileSemanticDiff>> {
    const diffs = new Map<string, FileSemanticDiff>();
    const { readFile } = await import("node:fs/promises");
    for (const change of input.changeSet.changes) {
      // Resource files (env, Prisma schema, JSON catalogs): key-level diff.
      if (
        isEnvFile(change.path) ||
        isPrismaSchema(change.path) ||
        isJsonCatalog(change.path, LOCALE_PATH)
      ) {
        const beforeText =
          change.type === "added"
            ? undefined
            : await input.readBefore(change.previousPath ?? change.path);
        const afterText =
          change.type === "deleted"
            ? undefined
            : await readFile(join(this.root, change.path), "utf8").catch(() => undefined);
        const rc = diffResource(change.path, beforeText, afterText, LOCALE_PATH);
        if (rc) resources.set(change.path, rc);
        continue;
      }
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
      if (after.catalogKeys || before?.catalogKeys)
        resources.set(
          change.path,
          diffCatalog(change.path, before?.catalogKeys, after.catalogKeys),
        );
      if (before) {
        before.path = change.path;
        // Graph diff: internal dependencies this change adds or removes.
        if (this.resolver) {
          const beforeTargets = new Set(
            before.imports
              .map((i) => this.resolver?.resolve(change.path, i.specifier).resolved)
              .filter((r): r is string => !!r),
          );
          const afterTargets = new Set(
            after.imports.map((i) => i.resolved).filter((r): r is string => !!r),
          );
          const added = [...afterTargets].filter((t) => !beforeTargets.has(t)).sort();
          const removed = [...beforeTargets].filter((t) => !afterTargets.has(t)).sort();
          if (added.length || removed.length) graphDiff.push({ file: change.path, added, removed });
        }
      }
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

  /** Adapter for a runner group (used by the history benchmark). */
  createAdapterFor(group: Group & { configFile?: string; patterns?: string[] }): TestAdapter {
    return this.createAdapter(group);
  }

  private createAdapter(group: Group, coverageDir?: string): TestAdapter {
    const cwd = join(this.root, group.dir);
    const g = group as Group & { configFile?: string; patterns?: string[] };
    const base = {
      projectRoot: this.root,
      cwd,
      ...(coverageDir ? { coverageDir } : {}),
      ...(g.configFile ? { configFile: g.configFile } : {}),
    };
    if (group.adapter === "jest") return new JestAdapter(base);
    if (group.adapter === "vitest") return new VitestAdapter(base);
    if (group.adapter === "playwright") return new PlaywrightAdapter(base);
    if (group.adapter === "cypress")
      return new CypressAdapter({ ...base, files: () => this.sourceFilesForSnapshots() });
    if (group.adapter === "node")
      return new NodeTestAdapter({
        projectRoot: this.root,
        cwd,
        ...(g.patterns ? { patterns: g.patterns } : {}),
      });
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
    // Adaptive policy: when the whole suite ran faster last time than an analysis usually takes,
    // running everything is both cheaper and complete.
    const statsPath = join(this.storeDir, "state", "timings.json");
    const recorded =
      (await readJson<{ analysisMs?: number[]; fullRunMs?: number }>(statsPath)) ?? {};
    const typicalAnalysis = recorded.analysisMs?.length
      ? [...recorded.analysisMs].sort((a, b) => a - b)[Math.floor(recorded.analysisMs.length / 2)]
      : undefined;
    const adaptive =
      !options.all &&
      this.config.adaptive !== false &&
      recorded.fullRunMs !== undefined &&
      typicalAnalysis !== undefined &&
      recorded.fullRunMs < typicalAnalysis;
    const analysis = await this.analyze({
      ...options,
      ...(adaptive
        ? {
            everything: {
              reason: `Adaptive: the full suite took ${Math.round(recorded.fullRunMs ?? 0)} ms last time, less than a typical analysis (${Math.round(typicalAnalysis ?? 0)} ms), so everything runs`,
            },
          }
        : {}),
    });
    const timings = analysis.timings;
    const analysisMs = Object.values(timings).reduce((a, b) => a + b, 0);
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
      analysis.assignment,
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
    // Duration history: estimate what skipping saved, then record fresh measurements.
    const durationsPath = join(this.storeDir, "state", "durations.json");
    const durations = (await readJson<Record<string, number>>(durationsPath)) ?? {};
    const skipped = analysis.decision.skippedTests.map((t) => t.filePath);
    const known = skipped.filter((f) => durations[f] !== undefined);
    const estimate = known.length
      ? {
          skippedTestTimeMs: known.reduce((a, f) => a + (durations[f] ?? 0), 0),
          knownSkipped: known.length,
          totalSkipped: skipped.length,
        }
      : undefined;
    for (const e of executions)
      if (e.status !== "cancelled" && e.status !== "infrastructure-error")
        durations[e.file] = Math.round(e.durationMs);
    await writeJson(durationsPath, durations);
    // Timings for the adaptive policy: typical analysis time, and the last full-suite wall time.
    const fullRun = analysis.decision.skippedTests.length === 0 && analysis.testFiles.length > 0;
    await writeJson(statsPath, {
      analysisMs: adaptive
        ? (recorded.analysisMs ?? [])
        : [...(recorded.analysisMs ?? []), Math.round(analysisMs)].slice(-7),
      ...(fullRun
        ? { fullRunMs: Math.round(timings["test execution"] ?? 0) }
        : recorded.fullRunMs !== undefined
          ? { fullRunMs: recorded.fullRunMs }
          : {}),
    });
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
      ...(estimate ? { estimate } : {}),
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
    const policy = new RulesEngine(effectiveRules(this.config)).evaluateAll([
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

  /** Shortest dependency path, import cycles and untested files (`smarttest graph why|cycles|orphans`). */
  async graphInsights(): Promise<{ graph: DependencyGraph; tests: string[] }> {
    const { index } = await this.loadIndex();
    const graph = this.buildGraph(index);
    const { tests } = await this.discoverTests(index);
    return { graph, tests };
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
    const runner = (roots.find(
      (r) => r.adapter === "vitest" || r.adapter === "jest" || r.adapter === "node",
    )?.adapter ?? "vitest") as "vitest" | "jest" | "node";
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
      rules: new RulesEngine(effectiveRules(this.config)),
      packageOf: this.packageOf,
      projects: Object.entries(this.config.projects).map(([dir, p]) => ({
        dir: dir.replace(/\/+$/, ""),
        ...(p.tests?.layout ? { layout: p.tests.layout } : {}),
        ...(p.tests?.directory !== undefined ? { directory: p.tests.directory } : {}),
        ...(p.tests?.naming ? { naming: p.tests.naming } : {}),
        ...(p.tests?.path ? { path: p.tests.path } : {}),
      })),
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
    return new RulesEngine(effectiveRules(this.config));
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
    // Only source files inside projects that run tests, excluding assets and tooling.
    const roots = await this.runnerRoots();
    const untested = sources.filter(
      (s) =>
        !tested.has(s) &&
        roots.some((r) => r.dir === "" || s.startsWith(`${r.dir}/`)) &&
        !/(?:^|\/)(?:public|static|scripts|assets|migrations|fixtures|mocks|__mocks__)\//.test(s) &&
        !/(?:^|\/)(?:index|main)\.[cm]?[jt]sx?$/.test(s) &&
        !/\.(?:config|d|wasp)\.[cm]?[jt]sx?$/.test(s),
    );
    const files = await this.allFiles();
    const globalConfigFiles = files.filter(
      (f) => BUILTIN_TRIGGERS.some((t) => matchGlob(f, t)) && !/lock|package\.json/.test(f),
    );
    const plan = await buildPlan(profile, sources, {
      untestedModules: untested,
      globalConfigFiles,
      overrides,
    });
    // Offer the Git hook, replacing the full-suite test steps the hook runs today.
    if (profile.vcs.provider === "git") {
      const hook = await planHookInstall(this.root, {
        replace: true,
        testCommands: profile.testCommands,
      });
      if (!hook.installed) {
        plan.files.push(hook.plan);
        if (hook.replaced.length)
          plan.warnings.push(
            `${hook.file}: ${hook.replaced.length} test step(s) would be commented out and replaced by \`smarttest run --staged\` (${hook.replaced.map((r) => `line ${r.line}`).join(", ")}); \`smarttest hook uninstall\` restores them`,
          );
      }
    }
    return plan;
  }

  /** Plans `smarttest hook install`. */
  async hookInstallPlan(
    options: { manager?: HookManager; replace?: boolean } = {},
  ): Promise<HookPlan> {
    const profile = await this.profile();
    return planHookInstall(this.root, { ...options, testCommands: profile.testCommands });
  }

  async hookUninstallPlan(manager?: HookManager): Promise<FilePlan[]> {
    return planHookUninstall(this.root, manager);
  }

  /** Applies hook file changes (recorded in the init journal, so `init --rollback` undoes them too). */
  async applyFiles(files: FilePlan[]): Promise<string[]> {
    const plan = { summary: "", recommendations: [], warnings: [], files, config: {} } as SetupPlan;
    const journal = await applyPlan(this.root, this.storeDir, plan);
    return files
      .filter((f) => f.action !== "skip" && journal.entries.some((e) => e.path === f.path))
      .map((f) => f.path);
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

  /** `smarttest watch`: reruns affected tests after each batch of saves until closed. */
  async watch(options: {
    onRun: (outcome: RunOutcome, files: string[]) => void;
    onAnalysis?: (analysis: Analysis) => void;
    onError?: (error: Error) => void;
    mode?: SafetyMode;
  }): Promise<Watcher> {
    const git = (await this.provider()) === "git";
    return watchProject(this.root, {
      exclude: this.config.exclude,
      git,
      ...(options.onError ? { onError: options.onError } : {}),
      onCycle: async ({ files, input }) => {
        const outcome = await this.run({
          input,
          command: "watch",
          ...(options.mode ? { mode: options.mode } : {}),
          ...(options.onAnalysis ? { onAnalysis: options.onAnalysis } : {}),
        });
        options.onRun(outcome, files);
      },
    });
  }

  /** `smarttest migrate --to vitest`: plan for every Jest project (or the one in `dir`). */
  async migratePlan(options: { to: "vitest"; dir?: string }): Promise<MigratePlan> {
    const profile = await this.profile();
    const { index } = await this.loadIndex();
    const { assignment } = await this.discoverTests(index);
    const jestRoots = [
      ...new Set([...assignment.values()].filter((r) => r.adapter === "jest")),
    ].filter((r) => options.dir === undefined || r.dir === options.dir);
    const plan: MigratePlan = { files: [], notes: [], install: "" };
    const installs: string[] = [];
    for (const r of jestRoots) {
      const testFiles = [...assignment].filter(([, x]) => x === r).map(([t]) => t);
      const p = await planMigrate(this.root, {
        dir: r.dir,
        testFiles,
        packageManager: profile.packageManager.name,
        typescript: profile.layout.typescript,
      });
      plan.files.push(...p.files);
      plan.notes.push(...p.notes);
      installs.push(p.install);
    }
    plan.install = installs.join(" && ");
    // SmartTest's own configuration: same rules, Vitest instead of Jest.
    const path = this.loaded.path;
    if (path && this.loaded.raw.adapters?.includes("jest")) {
      const { readFile } = await import("node:fs/promises");
      const before = await readFile(path, "utf8");
      const next = [...new Set(this.loaded.raw.adapters.map((a) => (a === "jest" ? "vitest" : a)))];
      const { after } = patchConfig(before, [
        {
          key: "adapters",
          current: "",
          proposed: `[${next.map((a) => JSON.stringify(a)).join(", ")}]`,
          reason: "",
        },
      ]);
      if (after !== before)
        plan.files.push({
          path: relative(this.root, path).split("\\").join("/"),
          action: "modify",
          reason: "adapters: jest → vitest (rules and history are kept)",
          before,
          after,
          risk: "medium",
        });
    }
    return plan;
  }

  /** `smarttest sync`: configuration drift against the project as it is now, and the patch. */
  async syncPlan(): Promise<SyncResult> {
    this.profileCache = undefined; // detect again
    const profile = await this.profile();
    const detectedProjects = this.loaded.raw.projects
      ? (await this.initPlan()).config.projects
      : undefined;
    const drift = detectDrift(this.config, this.loaded.raw, profile, detectedProjects);
    const path = this.loaded.path;
    if (!drift.length || !path) return { drift, manual: [], ...(path ? { path } : {}) };
    const { readFile } = await import("node:fs/promises");
    const before = await readFile(path, "utf8");
    const { after, manual } = patchConfig(before, drift, detectedProjects);
    return { drift, manual, path, before, ...(after !== before ? { after } : {}) };
  }

  /** Writes the sync patch (recorded in the init journal). */
  async applySync(result: SyncResult): Promise<boolean> {
    if (!result.after || !result.path || result.before === undefined) return false;
    const rel = relative(this.root, result.path).split("\\").join("/");
    const applied = await this.applyFiles([
      {
        path: rel,
        action: "modify",
        reason: "sync configuration with the project",
        before: result.before,
        after: result.after,
        risk: "medium",
      },
    ]);
    return applied.length > 0;
  }

  /** `doctor --fix`: safe repairs only (ignore file, unreadable local state, configuration drift). */
  async doctorFix(): Promise<string[]> {
    const fixed: string[] = [];
    const { readFile, readdir, rm, writeFile: wf } = await import("node:fs/promises");
    const gi = join(this.root, ".gitignore");
    const storeRel = relative(this.root, this.storeDir).split("\\").join("/");
    if ((await this.provider()) === "git" && storeRel && !storeRel.startsWith("..")) {
      const text = await readFile(gi, "utf8").catch(() => "");
      if (
        !text
          .split(/\r?\n/)
          .some((l) => l.trim().replace(/^\//, "").replace(/\/$/, "") === storeRel)
      ) {
        await wf(gi, `${text}${text && !text.endsWith("\n") ? "\n" : ""}${storeRel}/\n`);
        fixed.push(`.gitignore: ignore ${storeRel}/`);
      }
    }
    const stateDir = join(this.storeDir, "state");
    for (const f of await readdir(stateDir).catch(() => [] as string[])) {
      if (!f.endsWith(".json")) continue;
      try {
        JSON.parse(await readFile(join(stateDir, f), "utf8"));
      } catch {
        await rm(join(stateDir, f), { force: true });
        fixed.push(`removed unreadable ${storeRel}/state/${f} (rebuilt on the next run)`);
      }
    }
    const sync = await this.syncPlan();
    if (sync.after && (await this.applySync(sync)))
      fixed.push(...sync.drift.map((d) => `config ${d.key}: ${d.current} → ${d.proposed}`));
    return fixed;
  }

  async doctor(): Promise<DoctorFinding[]> {
    const out: DoctorFinding[] = [];
    const profile = await this.profile();
    {
      const drift = detectDrift(this.config, this.loaded.raw, profile);
      if (drift.length)
        out.push({
          check: "sync",
          severity: "warn",
          message: `configuration out of date: ${drift.map((d) => `${d.key} (${d.reason})`).join("; ")}`,
          hint: "Run `smarttest sync` to update it, or `smarttest doctor --fix`.",
        });
    }
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
      const {
        unassigned,
        roots,
        perRoot,
        warnings: dw,
      } = await this.discoverTests(index, { fresh: true });
      if (!roots.length)
        out.push({
          severity: "error",
          check: "runner",
          message: "No Jest, Vitest or node:test setup found",
          hint: "Install vitest or jest, or declare `runners` in smarttest.config",
        });
      for (const r of roots) {
        out.push({
          severity: "ok",
          check: "runner",
          message: `${r.adapter} (${r.dir || "."}${r.configFile ? ` · ${r.configFile}` : ""}) collects ${perRoot.get(rootKey(r)) ?? 0} test file(s)`,
        });
      }
      for (const w of dw)
        out.push({
          severity: "error",
          check: "runner",
          message: w,
          hint: "Is the runner installed? Try running it directly.",
        });
      if (unassigned.length)
        out.push({
          severity: "warn",
          check: "runner",
          message: `${unassigned.length} file(s) look like tests but no configured runner collects them (e.g. ${unassigned.slice(0, 3).join(", ")})`,
          hint: "They never run. Add them to a runner's include patterns, declare `runners`, or set `tests.match`.",
        });
    } catch (error) {
      out.push({ severity: "error", check: "index", message: (error as Error).message });
    }
    if (
      (await exists(join(this.root, "package.json"))) &&
      !(await exists(join(this.root, "node_modules")))
    )
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
    const plan = planExecution(
      analysis.testFiles,
      analysis.runnerRoots,
      this.config.adapters,
      analysis.assignment,
    );
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

  /**
   * Shadow Mode: runs the full suite next to the selection for the current change and appends the
   * comparison to `.smarttest/shadow/history.jsonl`, so drift (missed failures) is visible over time.
   */
  async shadow(
    options: AnalyzeOptions & { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<{ record: ShadowRecord; validation: SelectionValidation }> {
    const v = await this.validateSelection(options);
    const input = v.decision;
    const head = (await this.git().detect())
      ? await this.git()
          .head()
          .catch(() => undefined)
      : undefined;
    const record: ShadowRecord = {
      at: new Date().toISOString(),
      ...(head ? { head } : {}),
      mode: input.safetyMode,
      changed: input.affectedFiles.length,
      selected: v.selected,
      total: v.selected + v.skipped,
      failuresFound: v.failuresFound,
      failuresMissed: v.failuresMissed.map((m) => m.test),
      observedSkips: input.details.observedSkips?.length ?? 0,
      fullMs: Math.round(v.fullDurationMs),
      selectedMs: Math.round(v.selectedDurationMs + v.analysisOverheadMs),
    };
    const { appendFile, mkdir } = await import("node:fs/promises");
    await mkdir(join(this.storeDir, "shadow"), { recursive: true });
    await appendFile(join(this.storeDir, "shadow", "history.jsonl"), `${JSON.stringify(record)}\n`);
    return { record, validation: v };
  }

  /** Summary of all Shadow Mode runs recorded in this project. */
  async shadowReport(): Promise<ShadowReport> {
    const { readFile } = await import("node:fs/promises");
    const text = await readFile(join(this.storeDir, "shadow", "history.jsonl"), "utf8").catch(
      () => "",
    );
    const records = text
      .split("\n")
      .filter(Boolean)
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as ShadowRecord];
        } catch {
          return [];
        }
      });
    const fullMs = records.reduce((a, r) => a + r.fullMs, 0);
    const selectedMs = records.reduce((a, r) => a + r.selectedMs, 0);
    return {
      runs: records.length,
      missed: records.reduce((a, r) => a + r.failuresMissed.length, 0),
      runsWithMisses: records.filter((r) => r.failuresMissed.length).length,
      selected: records.reduce((a, r) => a + r.selected, 0),
      total: records.reduce((a, r) => a + r.total, 0),
      savedPct: fullMs ? Math.round(((fullMs - selectedMs) / fullMs) * 100) : 0,
      records,
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
