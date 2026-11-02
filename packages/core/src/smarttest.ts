import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { readFile as readFileText } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { AngularAdapter } from "@smarttest/adapter-angular";
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
import {
  type CoverageReport,
  ingestBrowserV8,
  ingestIstanbul,
  ingestIstanbulLines,
  type LineCoverageReport,
} from "@smarttest/coverage-engine";
import {
  DependencyGraph,
  type GraphOptions,
  nextRoutes,
  type ProvidedGraphInput,
} from "@smarttest/dependency-graph";
import { decideImpact, explainTest, type ImpactResult } from "@smarttest/impact-engine";
import type { TypeScriptResolver } from "@smarttest/language-typescript";
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
import type { ChangeScope, TestAdapter } from "@smarttest/shared";
import {
  angularTestTargets,
  assertConfinedWrite,
  assertNoSymlinkBelow,
  confineWrites,
  ExitCode,
  exists,
  gitProjectFiles,
  type Logger,
  mapLimit,
  matchGlob,
  readJson,
  readPackageScripts,
  readStateFile,
  readText,
  runProcess,
  runWithEnvScope,
  type SafetyMode,
  SmartTestError,
  sha256,
  silentLogger,
  stateKey,
  stateKeyFile,
  stateKeySource,
  vitestScriptTypecheck,
  walkFiles,
  writeFileAtomic,
  writeJson,
  writeStateFile,
} from "@smarttest/shared";
import {
  applyPlan,
  applyUninstall,
  buildPlan,
  type FilePlan,
  type HookManager,
  type HookPlan,
  type HookStage,
  type MigratePlan,
  planHookInstall,
  planHookUninstall,
  planMigrate,
  planUninstall,
  renderSetupReport,
  rollback,
  type SetupPlan,
  suggestHookRunners,
} from "@smarttest/smart-init";
import type { FileAnalysis } from "@smarttest/source-parser";
import { LOCALE_PATH } from "@smarttest/source-parser";
import { SymbolIndex, type UpdateStats } from "@smarttest/symbol-index";
import {
  assignRunner,
  discoverTestFiles,
  expandNodePatterns,
  isTestFile,
  type RunnerRoot,
  runnerPreference,
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
import { HgAdapter } from "@smarttest/vcs-hg";
import { SvnAdapter } from "@smarttest/vcs-svn";
import {
  type AdaptiveTimings,
  adaptiveApplies,
  fullSuiteMeasured,
  nextAdaptiveTimings,
  typicalAnalysisMs,
} from "./adaptive.js";
import { decodeDecisionRecord, encodeDecisionRecord } from "./decision-store.js";
import { FOREIGN_STATE, GraphStore, surfaceOf } from "./graph-store.js";
import {
  assertPushIsHead,
  type CheckResult,
  commitsWithoutHook,
  describeScope,
  GIT_HOOK_ENV,
  type HookRecords,
  hookInvocations,
  isHookContext,
  isolate,
  type LeftToCi,
  loadHookRecords,
  median,
  normalizeProject,
  onlyDeletions,
  outsideHookScope,
  type PushRef,
  planChecks,
  projectPaths,
  readPrePushRefs,
  runChecks,
  saveHookRecords,
  setAside,
  treeOf,
  unknownCheckProjects,
} from "./hook.js";
import { languages } from "./languages.js";
import { outsideLinks } from "./outside.js";
import { ParsePool, parallelParsingAvailable } from "./parse-pool.js";
import { type LoadedPlugin, loadPlugins, pluginsChanged, runEdgeProviders } from "./plugins.js";
import {
  type RunnerInputs,
  readRunnerInputs,
  runnerHits,
  runnerInputFiles,
} from "./runner-inputs.js";
import {
  nothingInScope,
  resolveScopePaths,
  restrictChanges,
  scopeWarnings,
  unchangedScopeDecision,
} from "./scope.js";
import {
  cacheGet,
  cachePut,
  type FlakyEntry,
  failFastOrder,
  flakyReport,
  type HistoryStore,
  loadHistory,
  loadResultCache,
  pruneHistory,
  recentlyFailingFiles,
  recordRun,
  resultKey,
  saveHistory,
  saveResultCache,
  shardFiles,
} from "./speed.js";
import { STYLESHEET, stylesheetImporters } from "./stylesheets.js";
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
  traceEnv,
} from "./traces.js";
import { type Watcher, watchProject } from "./watch.js";

export interface OpenOptions {
  root: string;
  configPath?: string;
  logger?: Logger;
  /** Use this state directory (absolute) instead of the project's (temporary checkouts). */
  storeDir?: string;
  /** Temporary checkouts: the working tree they mirror (see `UpdateOptions.mirror`). */
  mirror?: { root: string; differs: ReadonlySet<string> };
  /**
   * Keep state in a temporary directory removed when the process exits: nothing is written to the
   * project (dry runs).
   */
  ephemeralStore?: boolean;
  /**
   * A store committed to Git is not refused (`ST_STORE_TRACKED`): its state is still never read
   * (the instance works in a temporary store) and `trackedStore` describes it, so `doctor` and
   * `init` can repair it.
   */
  tolerateTrackedStore?: boolean;
}

/**
 * The store holds caches that decide what runs: cached passes, the symbol index, traces. Its
 * content is trusted only because SmartTest wrote it on this machine. A store committed to the
 * repository (for example by a pull request from a fork) could claim passes or hide
 * dependencies and so reduce the selection. Such a store is refused, never read.
 */
async function trackedStoreFiles(
  root: string,
  storeDir: string,
): Promise<{ dir: string; files: string[] } | undefined> {
  const rel = relative(root, storeDir).split("\\").join("/");
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return undefined;
  const res = await runProcess(
    "git",
    ["-c", "core.quotePath=false", "ls-files", "-z", "--", `${rel}/`],
    { cwd: root },
  ).catch(() => undefined);
  if (res?.code !== 0) return undefined; // not a Git repository, or Git is unavailable
  const files = res.stdout.split("\0").filter(Boolean);
  return files.length ? { dir: rel, files } : undefined;
}

export function storeTrackedError(tracked: { dir: string; files: string[] }): SmartTestError {
  const rel = tracked.dir;
  return new SmartTestError(
    `${rel}/ is committed to the repository (${tracked.files.length} tracked file(s), e.g. ${tracked.files[0]}). SmartTest will not trust local state that comes from the repository content.`,
    {
      code: "ST_STORE_TRACKED",
      category: "configuration",
      hint: `Remove it from version control and ignore it: \`git rm -r --cached ${rel}\`, then add \`${rel}/\` to .gitignore (\`smarttest doctor --fix\` adds the entry and offers to run the command). In CI, do not run SmartTest on a pull request that commits it.`,
    },
  );
}

/** A temporary state directory, removed when the process exits. */
function temporaryStore(): string {
  const dir = mkdtempSync(join(tmpdir(), "smarttest-store-"));
  process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export interface AnalyzeOptions {
  source?: ChangeSource;
  mode?: SafetyMode;
  /** Select every test without building the graph (adaptive policy). */
  everything?: { reason: string };
  /** A ready-made change set (watch mode) instead of `source`. */
  input?: ChangeAnalysisInput;
  /**
   * Restrict the changed set to these project-relative paths (files or directories) before
   * selection (`--only`). The dependency analysis is not restricted.
   */
  only?: readonly string[];
}

export interface Analysis {
  /** Project root the analysis ran in (a temporary checkout for isolated hook runs). */
  root: string;
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
  /**
   * The trace view the analysis used (`null`: no traces), for callers that show it (Studio): it
   * is read once. Absent when the analysis did not read traces.
   */
  traces?: TraceView | null;
  /** Present when the change set was restricted with `only`. */
  scope?: ChangeScope;
}

export interface RunOptions extends AnalyzeOptions {
  all?: boolean;
  /** Reuse validated passing results (default: config `cache`, off with `all`). */
  cache?: boolean;
  /** Run only shard `index` of `total` (balanced by recorded durations). */
  shard?: { index: number; total: number };
  /** Stop starting runner groups after one fails. */
  bail?: boolean;
  /**
   * Apply the hook scope (`hook.runners`, `hook.exclude`): selected tests outside it are not run
   * and are reported as left to CI. Internal to `runHook`; `run` and `ci` never set it.
   */
  hookScope?: boolean;
  /** Reuse an analysis computed by the caller (benchmark) instead of analysing again. */
  analysis?: Analysis;
  /**
   * `staged` and `push` sources test exactly what is committed or pushed: when the working tree
   * differs, the run happens in a temporary checkout (default true).
   */
  isolate?: boolean;
  /** Notes added to the report's warnings. */
  notes?: string[];
  /** Work that must finish before a temporary checkout is removed (hook checks). */
  holdCheckout?: () => Promise<unknown>;
  /** Config loaded inside a temporary checkout (internal: hook runs use its checks and budgets). */
  onIsolatedConfig?: (config: ResolvedConfig) => void;
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

export interface HookEstimate {
  estimateMs: number;
  budgetMs: number;
  slowest: { file: string; ms: number }[];
  /** Selected files with no recorded duration yet. */
  unknown: number;
  checks: { name: string; project: string; command: string }[];
}

export interface HookOutcome {
  stage: "pre-commit" | "pre-push";
  skipped: boolean;
  /** The push only deleted remote refs: nothing was tested and nothing needed to be. */
  nothingPushed?: boolean;
  outcome?: RunOutcome;
  checks: CheckResult[];
  /** Hook configuration problems (a check that can never run), shown with the result. */
  warnings: string[];
  /**
   * Selected test files the hook scope (`hook.runners`, `hook.exclude`) did not run: selected,
   * not run in the hook, left to CI. Never counted as passed.
   */
  leftToCi?: { count: number; rules: string[]; files: LeftToCi[] };
  durationMs: number;
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
    // In-source tests (`includeSource`), type tests (`typecheck`) and workspace files: only Vitest
    // knows which files it collects.
    if (/\b(includeSource|typecheck)\b/.test(cfg) || isVitestWorkspaceFile(root.configFile))
      return undefined;
    // `vitest --typecheck` in a script: the adapter passes it, so Vitest also collects type tests.
    let scripts: Record<string, string> = {};
    try {
      scripts = (JSON.parse(pkg || "{}") as { scripts?: Record<string, string> }).scripts ?? {};
    } catch {
      return undefined;
    }
    if (vitestScriptTypecheck(scripts, root.configFile)) return undefined;
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

/** `vitest.workspace.ts` & co.: a list of projects (Vitest 3 and earlier), not a config file. */
function isVitestWorkspaceFile(file: string | undefined): boolean {
  return !!file && /(?:^|\/)vitest\.workspace\.[cm]?[jt]s(?:on)?$/.test(file);
}

/** Vitest type tests by default `typecheck.include` (`*.test-d.ts`, `*.spec-d.ts`). */
const VITEST_TYPE_TEST = /\.(?:test|spec)-d\.[cm]?[jt]sx?$/;

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

/**
 * The project root with symlinks and Windows 8.3 short names resolved. Test runners report the
 * canonical paths they load (macOS's /var is /private/var; Windows' temp dir is often
 * C:\Users\RUNNER~1\...), so relating them to a non-canonical root would lose every result.
 */
function canonicalRoot(root: string): string {
  try {
    return realpathSync.native(root);
  } catch {
    return root;
  }
}

export class SmartTest {
  private profileCache: ProjectProfile | undefined;
  private resolver: TypeScriptResolver | undefined;
  readonly storeDir: string;
  /** The project's store is committed to Git (opened with `tolerateTrackedStore`). */
  trackedStore: { dir: string; files: string[] } | undefined;

  private constructor(
    readonly root: string,
    readonly loaded: LoadedConfig,
    public logger: Logger,
    storeDir?: string,
    private readonly mirror?: OpenOptions["mirror"],
  ) {
    this.storeDir = storeDir ?? join(root, loaded.config.storeDir);
    // Writes into the store and the report directory never pass through a link (spec §30.2).
    confineWrites(root, this.storeDir);
    const reports = loaded.config.reports.outputDir;
    confineWrites(root, isAbsolute(reports) ? reports : join(root, reports));
  }

  static async open(options: OpenOptions): Promise<SmartTest> {
    const root = canonicalRoot(options.root);
    // Paths given inside the root are re-spelled under the canonical root, so the store and the
    // config stay "inside the project" for every later relative() check.
    const rebase = (p: string | undefined) => {
      if (p === undefined || !isAbsolute(p)) return p;
      const rel = relative(options.root, p);
      return rel.startsWith("..") || isAbsolute(rel) ? p : join(root, rel);
    };
    const loaded = await loadConfig(root, rebase(options.configPath));
    const projectStore = rebase(options.storeDir) ?? join(root, loaded.config.storeDir);
    const tracked = await trackedStoreFiles(root, projectStore);
    if (tracked && !options.tolerateTrackedStore) throw storeTrackedError(tracked);
    // A dry run writes nothing to the project, and state committed to the repository is never
    // read: both work in a temporary store.
    const st = new SmartTest(
      root,
      loaded,
      options.logger ?? silentLogger,
      options.ephemeralStore || tracked ? temporaryStore() : projectStore,
      options.mirror,
    );
    st.trackedStore = tracked;
    return st;
  }

  /** Untracks the committed store (`git rm -r --cached`), keeping its files on disk. */
  async untrackStore(): Promise<string | undefined> {
    const dir = this.trackedStore?.dir;
    if (!dir) return undefined;
    const res = await runProcess("git", ["rm", "-r", "-q", "--cached", "--", dir], {
      cwd: this.root,
    });
    if (res.code !== 0)
      throw new SmartTestError(`git rm -r --cached ${dir} failed: ${res.stderr.trim()}`, {
        code: "ST_VCS_COMMAND_FAILED",
        category: "infrastructure",
        hint: `Run \`git rm -r --cached ${dir}\` yourself.`,
      });
    this.trackedStore = undefined;
    return `git rm -r --cached ${dir}`;
  }

  useLogger(logger: Logger): this {
    this.logger = logger;
    return this;
  }

  get config(): ResolvedConfig {
    return this.loaded.config;
  }

  isTest = (path: string): boolean => isTestFile(path, this.config.tests.match);

  /** `gitFiles`: a `gitProjectFiles` listing taken by the caller (saves listing twice). */
  async profile(gitFiles?: readonly string[]): Promise<ProjectProfile> {
    this.profileCache ??= await detectProject(this.root, {
      isTestFile: this.isTest,
      ...(gitFiles ? { files: await walkFiles(this.root, { gitFiles }), gitFiles } : {}),
    });
    return this.profileCache;
  }

  async sourceFiles(gitFiles?: readonly string[]): Promise<string[]> {
    const generatedExcludes = this.config.generated
      .filter((g) => g.policy === "exclude")
      .map((g) => g.path);
    return walkFiles(this.root, {
      include: this.config.include,
      exclude: [...this.config.exclude, ...generatedExcludes],
      ...(gitFiles ? { gitFiles } : {}),
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
          ...(r.project ? { project: r.project } : {}),
        }))
      : profile.runners.map((r) => ({
          adapter: r.adapter,
          dir: r.dir,
          ...(r.configFile ? { configFile: r.configFile } : {}),
          ...(r.patterns ? { patterns: r.patterns } : {}),
          ...(r.project ? { project: r.project } : {}),
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

  async provider(): Promise<"git" | "svn" | "hg" | "native"> {
    const p = this.config.vcs.provider;
    if (p !== "auto") return p;
    this.providerCache ??= (await this.git().detect())
      ? "git"
      : (await new SvnAdapter(this.root).detect())
        ? "svn"
        : (await new HgAdapter(this.root).detect())
          ? "hg"
          : "native";
    return this.providerCache;
  }
  private providerCache: "git" | "svn" | "hg" | "native" | undefined;

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
    const provider = await this.provider();
    if (provider === "svn")
      return this.withoutOwnState(await new SvnAdapter(this.root).getChangeInput(src));
    if (provider === "hg")
      return this.withoutOwnState(await new HgAdapter(this.root).getChangeInput(src));
    if (provider !== "git" && !(await this.git().detect())) {
      throw new SmartTestError("This project is not a Git repository", {
        code: "ST_NOT_GIT",
        category: "usage",
        hint: "Drop --base/--staged/--uncommitted to use native snapshots, or run `git init`.",
      });
    }
    return this.withoutOwnState(await this.git().getChangeInput(src));
  }

  /**
   * SmartTest's own state (store, reports) is never a change to the project. `readBefore` is
   * memoised: semantic diff, traces and Studio read the same files, each read a VCS process.
   */
  private withoutOwnState(input: ChangeAnalysisInput): ChangeAnalysisInput {
    const own = [this.config.storeDir, this.config.reports.outputDir].map((d) =>
      d.replace(/^\.\//, "").replace(/\/$/, ""),
    );
    const changes = input.changeSet.changes.filter(
      (c) => !own.some((d) => c.path === d || c.path.startsWith(`${d}/`)),
    );
    return {
      ...input,
      readBefore: memoiseReadBefore(input),
      ...(changes.length === input.changeSet.changes.length
        ? {}
        : { changeSet: { ...input.changeSet, changes } }),
    };
  }

  // ── Index & graph ───────────────────────────────────────────────────────────────────────

  /**
   * Long-running mode (watch): the index and graph stay in memory between cycles and the graph is
   * patched for changed files instead of rebuilt.
   */
  keepWarm = false;
  private indexCache: SymbolIndex | undefined;
  private graphCache: { graph: DependencyGraph; index: SymbolIndex; e2e: string } | undefined;
  private lastIndexChange: { changed: string[]; structural: boolean } | undefined;
  /**
   * How the last graph was obtained, for diagnostics: "built" from the analyses, "loaded" from the
   * persisted graph, or "patched" (the persisted or in-memory graph, patched for changed files).
   */
  lastGraphBuild: "patched" | "built" | "loaded" | undefined;
  /** Why the persisted graph could not be used last time (diagnostics). */
  lastGraphStoreMiss: string | undefined;

  async loadIndex(
    options: {
      /** A `gitProjectFiles` listing the caller took moments ago (`doctor`): not listed again. */
      gitFiles?: readonly string[];
    } = {},
  ): Promise<{ index: SymbolIndex; stats: UpdateStats }> {
    // One project listing serves detection and the source file set; Git lists while the index
    // is read.
    const listing = options.gitFiles
      ? Promise.resolve(options.gitFiles)
      : gitProjectFiles(this.root);
    const lang = languages();
    const index =
      this.keepWarm && this.indexCache ? this.indexCache : await SymbolIndex.load(this.storeDir);
    const gitFiles = await listing;
    const before = this.keepWarm ? new Map(index.entries()) : undefined;
    // Cold start (no index, or one from another analyzer version) of a large project: parser
    // threads start before files are read, so their start-up overlaps with reading.
    const sample = index.entries().values().next().value as FileAnalysis | undefined;
    const { ts: typescript, analyzers: ANALYZERS } = await lang;
    const cold =
      index.size === 0 ||
      (sample !== undefined && !ANALYZERS.some((a) => a.version === sample.analyzerVersion));
    const profile = await this.profile(gitFiles);
    for (const w of index.loadWarnings) this.logger.warn(w);
    const resolver = new typescript.TypeScriptResolver(
      this.root,
      profile.workspaces.map((w) => ({ name: w.name, dir: w.dir, manifest: w.manifest })),
    );
    const files = await this.sourceFiles(gitFiles);
    // Every file the resolver reads to resolve these files (tsconfig/jsconfig and what they
    // extend or reference, package.json files) keys the stored resolutions.
    const contextFiles = [
      ...new Set([
        "package.json",
        ...profile.layout.tsconfigFiles,
        ...profile.workspaces.map((w) => `${w.dir}/package.json`),
        ...resolver.inputsFor(files),
      ]),
    ];
    const { readFile } = await import("node:fs/promises");
    // RESOLVER_VERSION: a SmartTest upgrade that resolves differently re-resolves every import.
    const contextKey = `${typescript.RESOLVER_VERSION}\n${(
      await Promise.all(
        contextFiles.map(
          async (f) =>
            `${f}:${await readFile(isAbsolute(f) ? f : join(this.root, f), "utf8").catch(() => "")}`,
        ),
      )
    ).join("\n")}`;
    this.resolver = resolver;
    const pool =
      cold && files.length >= 300 && parallelParsingAvailable() ? new ParsePool() : undefined;
    const stats = await index
      .update({
        root: this.root,
        files,
        analyzers: ANALYZERS,
        resolver,
        contextKey,
        ...(this.mirror ? { mirror: this.mirror } : {}),
        ...(pool
          ? {
              parseMany: async (jobs: { path: string; content: string }[]) =>
                (await pool.parse(jobs)) as FileAnalysis[] | undefined,
            }
          : {}),
      })
      .finally(() => pool?.close());
    await index.save();
    await this.runPlugins(index);
    if (before) {
      // Changes other files can see (imports, exports, declarations) need a full graph rebuild.
      const changed: string[] = [];
      // Re-resolved in place (tsconfig paths, package manifests): other files may now point elsewhere.
      let structural = before.size !== index.size || !!stats.resolvedAll;
      for (const [p, a] of index.entries()) {
        const old = before.get(p);
        if (old === a) continue;
        changed.push(p);
        if (!old || surfaceOf(old) !== surfaceOf(a)) structural = true;
      }
      this.lastIndexChange = { changed, structural };
      this.indexCache = index;
    }
    return { index, stats };
  }

  private pluginsLoaded: Promise<LoadedPlugin[]> | undefined;
  /** Output of the plugin edge providers for the current index (recomputed on each load). */
  private provided: (ProvidedGraphInput & { warnings: string[] }) | undefined;

  /**
   * Plugins from the `plugins` option. A long-lived instance (watch mode, Studio) loads a plugin
   * again when its file changed, so later cycles never use the old version's edges.
   */
  async plugins(): Promise<LoadedPlugin[]> {
    const loaded = this.pluginsLoaded;
    if (loaded) {
      const current = await loaded.catch(() => undefined);
      if (current && !(await pluginsChanged(current))) return current;
      // Retry a failed load too: the plugin may have been fixed since.
      if (this.pluginsLoaded !== loaded) return this.plugins();
    }
    this.pluginsLoaded = loadPlugins(this.root, this.config.plugins);
    return this.pluginsLoaded;
  }

  private async runPlugins(index: SymbolIndex): Promise<void> {
    if (!this.config.plugins.length) return;
    this.provided = await runEdgeProviders(await this.plugins(), {
      root: this.root,
      files: [...index.entries().keys()],
      isTest: this.isTest,
      listFiles: () => this.allFiles(),
    });
  }

  buildGraph(index: SymbolIndex, e2eTests?: ReadonlySet<string>): DependencyGraph {
    const e2e = [...(e2eTests ?? [])].sort().join("|");
    const cached = this.graphCache;
    if (
      this.keepWarm &&
      !this.provided &&
      cached &&
      cached.index === index &&
      cached.e2e === e2e &&
      this.lastIndexChange &&
      !this.lastIndexChange.structural &&
      cached.graph.patch(this.lastIndexChange.changed)
    ) {
      this.lastGraphBuild = "patched";
      this.lastIndexChange = { changed: [], structural: false };
      return cached.graph;
    }
    const graph = this.buildGraphFresh(index, e2eTests);
    if (this.keepWarm) this.graphCache = { graph, index, e2e };
    this.lastGraphBuild = "built";
    if (this.lastIndexChange) this.lastIndexChange = { changed: [], structural: false };
    return graph;
  }

  private buildGraphFresh(index: SymbolIndex, e2eTests?: ReadonlySet<string>): DependencyGraph {
    return new DependencyGraph(index.entries(), this.isTest, this.graphOptions(index, e2eTests));
  }

  private graphOptions(index: SymbolIndex, e2eTests?: ReadonlySet<string>): GraphOptions {
    const files = [...index.entries().keys()];
    // Next.js projects: directories with a next.config, or the root when Next.js was detected.
    const nextRoots = new Set(
      files
        .filter((f) => /(?:^|\/)next\.config\.[cm]?[jt]s$/.test(f))
        .map((f) => (f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : "")),
    );
    if (this.profileCache?.frameworks.some((f) => f.value === "Next.js")) nextRoots.add("");
    const routes = nextRoots.size ? nextRoutes(files, [...nextRoots]) : [];
    return {
      ...(routes.length ? { routes } : {}),
      ...(e2eTests?.size ? { e2eTests } : {}),
      ...(this.provided
        ? { provided: { edges: this.provided.edges, unresolved: this.provided.unresolved } }
        : {}),
    };
  }

  /**
   * The graph for an analysis, persisted between runs (`.smarttest/state/graph.json`): restored
   * when it provably matches the current analyses, patched for files whose content changed but
   * whose surface did not, rebuilt otherwise (see graph-store.ts). Watch mode keeps its in-memory
   * graph instead.
   */
  private async analysisGraph(
    index: SymbolIndex,
    e2eTests: ReadonlySet<string>,
  ): Promise<DependencyGraph> {
    // Plugin edges are not part of the store's key: with plugins, always rebuild.
    if (this.provided || (this.keepWarm && this.graphCache))
      return this.buildGraph(index, e2eTests);
    const options = this.graphOptions(index, e2eTests);
    const store = new GraphStore(this.storeDir, this.config, options);
    const loaded = store.load(index.entries(), this.isTest);
    let graph: DependencyGraph;
    if (loaded.status === "loaded" || loaded.status === "patched") {
      graph = loaded.graph;
      this.lastGraphBuild = loaded.status;
      this.lastGraphStoreMiss = undefined;
    } else {
      graph = new DependencyGraph(index.entries(), this.isTest, options);
      this.lastGraphBuild = "built";
      this.lastGraphStoreMiss = `${loaded.status}: ${loaded.reason}`;
      if (loaded.reason === FOREIGN_STATE) this.logger.debug(`graph store: ${FOREIGN_STATE}`);
      else
        this.logger.debug("graph store not used", { status: loaded.status, reason: loaded.reason });
    }
    if (GraphStore.shouldSave(loaded))
      await store
        .save(graph, index.entries())
        .catch((error: Error) =>
          this.logger.debug("graph store not written", { error: error.message }),
        );
    if (this.keepWarm) {
      this.graphCache = { graph, index, e2e: [...e2eTests].sort().join("|") };
      this.lastIndexChange = { changed: [], structural: false };
    }
    return graph;
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
    /** Named like tests, collected by no runner, imported by other files: helpers, not tests. */
    helpers: string[];
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
      if (root?.adapter === "vitest") return VITEST_TYPE_TEST.test(f);
      if (root?.adapter !== "node") return false;
      const rel = root.dir ? f.slice(root.dir.length + 1) : f;
      return matchGlob(rel, expandNodePatterns(root.patterns));
    };
    const staticCandidates = discoverTestFiles(analysed, this.config.tests.match);
    // A test-named file that another file imports and no runner collects is a helper
    // (`__tests__/renderManager.tsx`): the tests importing it are what protects its dependencies.
    const imported = new Set<string>();
    for (const [file, a] of index.entries())
      for (const i of a.imports) if (i.resolved && i.resolved !== file) imported.add(i.resolved);
    const split = (uncollected: string[]) => ({
      unassigned: uncollected.filter((f) => !imported.has(f)),
      helpers: uncollected.filter((f) => imported.has(f)),
    });
    const assignment = new Map<string, RunnerRoot>();
    const warnings: string[] = [];
    const perRoot = new Map<string, number>();
    if (!roots.length)
      return {
        tests: staticCandidates,
        unassigned: [],
        helpers: [],
        roots,
        assignment,
        warnings,
        perRoot,
      };
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
      return {
        tests: [...assignment.keys()],
        ...split(unassigned),
        roots,
        assignment,
        warnings,
        perRoot,
      };
    }
    const cachePath = join(this.storeDir, "state", "discovery.json");
    // Authenticated: a planted cache could list no test files for a runner.
    const cachedText = await readStateFile(cachePath).catch(() => undefined);
    let stored: Record<string, string[]> | undefined;
    try {
      stored = cachedText === undefined ? undefined : JSON.parse(cachedText);
    } catch {
      stored = undefined;
    }
    const cache = options.fresh ? {} : (stored ?? {});
    const nextCache: Record<string, string[]> = {};
    // Runners are asked in parallel; a runner whose config sets nothing about test files is not
    // asked at all: its default patterns are applied here (no process start).
    const listed = await Promise.all(
      roots.map(async (root) => {
        const cfg = root.configFile
          ? ((await readText(join(this.root, root.configFile))) ?? "")
          : "";
        const candidates = analysed.filter((f) => inRoot(f, root) && looksLikeTest(f, root));
        // In-source tests (`if (import.meta.vitest)`) are tests of that runner: they are candidates,
        // so adding or removing one asks Vitest again.
        if (root.adapter === "vitest" && /\bincludeSource\b/.test(cfg)) {
          const known = new Set(candidates);
          for (const f of analysed)
            if (!known.has(f) && inRoot(f, root) && /\.[cm]?[jt]sx?$/.test(f))
              if ((await readText(join(this.root, f)))?.includes("import.meta.vitest"))
                candidates.push(f);
        }
        candidates.sort();
        const pkg = (await readText(join(this.root, root.dir, "package.json"))) ?? "";
        // The local modules the configuration imports (`mergeConfig(shared, …)`) decide what it
        // collects as much as the configuration itself.
        const imported = (await readRunnerInputs(this.root, root)).configs.filter(
          (c) => c.importedBy,
        );
        const importedText = await Promise.all(
          imported.map(async (c) => `${c.file}:${(await readText(join(this.root, c.file))) ?? ""}`),
        );
        const key = sha256(
          [
            rootKey(root),
            (root.patterns ?? []).join(","),
            cfg,
            ...importedText,
            pkg,
            candidates.join("\n"),
          ].join("\u0000"),
        );
        let files = cache[key];
        let failed = false;
        if (!files && !imported.length)
          files = await staticDefaultDiscovery(this.root, root, cfg, pkg, candidates);
        if (!files) {
          try {
            files = (
              await this.createAdapter({
                adapter: root.adapter,
                dir: root.dir,
                files: [],
                ...(root.configFile ? { configFile: root.configFile } : {}),
                ...(root.patterns ? { patterns: root.patterns } : {}),
                ...(root.project ? { project: root.project } : {}),
              } as Group).discover()
            ).map((t) => t.filePath);
          } catch (error) {
            // The first lines of the runner's own error say which file broke the listing.
            warnings.push(
              `${root.adapter} (${root.dir || "."}) discovery failed — using filename patterns: ${(
                error as Error
              ).message
                .split("\n")
                .slice(0, 6)
                .join("\n")}`,
            );
            files = candidates;
            failed = true;
          }
        }
        return { root, key, files, failed };
      }),
    );
    // Runners whose listing worked claim their files first. A runner whose listing failed falls
    // back to filename patterns and only takes files no working runner collects: a broken
    // Playwright listing must not take the unit tests away from their own runner.
    const ordered = [...listed.filter((l) => !l.failed), ...listed.filter((l) => l.failed)];
    const listedBy = new Map<string, boolean>();
    // Two runners in one directory collecting the same file (Jest set up with a config while the
    // Vitest the Angular CLI installed stays in the dependencies): the configured order wins,
    // then the runner the `test` script starts, then a runner with a config file.
    const testScripts = new Map<string, string>();
    const owns = (root: RunnerRoot): number => {
      if (!testScripts.has(root.dir))
        testScripts.set(root.dir, readPackageScripts(join(this.root, root.dir)).test ?? "");
      return runnerPreference(root, testScripts.get(root.dir) as string, this.config.adapters);
    };
    for (const { root, key, files, failed } of ordered) {
      // A fallback is not cached: the failure must be reported again until it is fixed.
      if (!failed) nextCache[key] = files;
      let count = 0;
      for (const f of files) {
        if (!analysedSet.has(f)) continue; // excluded by smarttest config
        // A pattern fallback does not take files other files import: helpers, not specs.
        if (failed && imported.has(f)) continue;
        const prev = assignment.get(f);
        if (failed && prev && listedBy.get(f)) continue;
        // Several runners may collect the same file: the deepest project owns it.
        if (
          !prev ||
          root.dir.length > prev.dir.length ||
          (root.dir.length === prev.dir.length &&
            listedBy.get(f) === !failed &&
            owns(root) < owns(prev))
        ) {
          assignment.set(f, root);
          listedBy.set(f, !failed);
        }
        count++;
      }
      perRoot.set(rootKey(root), count);
    }
    // Written only when it changed: most runs find the same listing.
    const nextText = `${JSON.stringify(nextCache)}\n`;
    if (nextText !== cachedText) await writeStateFile(cachePath, nextText);
    const tests = [...assignment.keys()].sort();
    const { unassigned, helpers } = split(staticCandidates.filter((f) => !assignment.has(f)));
    return { tests, unassigned, helpers, roots, assignment, warnings, perRoot };
  }

  /** What each runner loads because its configuration names it (setup files, config imports…). */
  async runnerInputs(roots: readonly RunnerRoot[]): Promise<RunnerInputs[]> {
    return Promise.all(roots.map((r) => readRunnerInputs(this.root, r)));
  }

  /** The index and graph queries runner inputs need. */
  private runnerGraphView(
    index: SymbolIndex,
    graph: DependencyGraph,
    assignment: ReadonlyMap<string, RunnerRoot>,
  ) {
    const testsByRoot = new Map<RunnerRoot, string[]>();
    for (const [t, r] of assignment) testsByRoot.set(r, [...(testsByRoot.get(r) ?? []), t]);
    const importsOf = (file: string): string[] =>
      (index.get(file)?.imports ?? []).flatMap((i) =>
        i.resolved && i.resolved !== file ? [i.resolved] : [],
      );
    return {
      testsOf: (r: RunnerRoot) => (testsByRoot.get(r) ?? []).sort(),
      importsOf,
      importersOf: (match: (specifier: string) => boolean) =>
        [...index.entries()].flatMap(([file, a]) =>
          a.imports
            .filter((i) => match(i.specifier))
            .map((i) => ({ file, ...(i.resolved ? { resolved: i.resolved } : {}) })),
        ),
      dependsDirectly: (from: string, to: string) =>
        new Set(graph.why(to, from)?.map((k) => k.split("#")[0])).size === 2,
      testsDependingOn: (file: string) => [
        ...graph.dependentsOf([{ file, units: ["*"] }]).tests.keys(),
      ],
      reachesAnyTest: (file: string) => graph.reachesAnyTest([{ file, units: ["*"] }]),
      isTest: (file: string) => graph.isTestFile(file),
    };
  }

  // ── Analysis & impact ───────────────────────────────────────────────────────────────────

  async analyze(options: AnalyzeOptions = {}): Promise<Analysis> {
    const timings: Record<string, number> = {};
    // Change detection (VCS processes) and the index update are independent: run them together
    // (both settle before an error is reported, so nothing keeps writing after it).
    const [changed, updated] = await Promise.allSettled([
      options.input
        ? this.withoutOwnState(options.input)
        : timed(timings, "change detection", () => this.changeInput(options.source)),
      timed(timings, "index update", () => this.loadIndex()),
    ]);
    if (changed.status === "rejected") throw changed.reason;
    if (updated.status === "rejected") throw updated.reason;
    const detected = changed.value;
    const only = options.only
      ? await resolveScopePaths(this.root, options.only, detected.changeSet.changes)
      : undefined;
    const scoped = only ? restrictChanges(detected, only.paths) : undefined;
    const input = scoped?.input ?? detected;
    const scope = scoped?.scope;
    const { index, stats } = updated.value;
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
        warnings: scope
          ? [...(only?.notes ?? []), ...scopeWarnings(scope, input.changeSet.completeness)]
          : [],
        fallbackApplied: true,
        details: { triggers: [], seeds: [], trivialSkipped: [], ignored: [], uncertainty: [] },
      } satisfies ImpactResult;
      return {
        root: this.root,
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
        ...(scope ? { scope } : {}),
      };
    }
    const {
      tests,
      unassigned,
      helpers,
      roots,
      assignment,
      warnings: discoveryWarnings,
    } = await this.discoverTests(index);
    const e2eTests = new Set(
      [...assignment]
        .filter(([, r]) => r.adapter === "playwright" || r.adapter === "cypress")
        .map(([t]) => t),
    );
    // Angular's unit-test and Karma builds compile and type-check everything a spec imports.
    const typeCheckedTests = await this.typeCheckedTests(assignment);
    const graph = await timed(timings, "graph build", () => this.analysisGraph(index, e2eTests));
    graph.setDiscovery({ tests, helpers });
    const graphDiff: { file: string; added: string[]; removed: string[] }[] = [];
    const resources = new Map<string, ResourceChange>();
    const diffs = await timed(timings, "semantic diff", () =>
      this.semanticDiffs(input, index, graphDiff, resources),
    );
    const traceView = await this.traceView(input, index);
    const runners = await timed(timings, "runner configuration", async () =>
      runnerHits({
        ...this.runnerGraphView(index, graph, assignment),
        inputs: await this.runnerInputs(roots),
        changeSet: input.changeSet,
      }),
    );
    // A changed stylesheet reaches code through the stylesheets that import it (Sass partials).
    const changedSheets = input.changeSet.changes
      .flatMap((c) => [c.path, c.previousPath])
      .filter((p): p is string => !!p && STYLESHEET.test(p));
    const stylesheetImporterMap = changedSheets.length
      ? await stylesheetImporters(this.root, await this.allFiles(), changedSheets)
      : new Map<string, string[]>();
    const decision = await timed(timings, "impact analysis", async () =>
      scope && nothingInScope(scope, input.changeSet.completeness)
        ? unchangedScopeDecision(tests, scope, options.mode ?? this.config.mode)
        : decideImpact({
            ...(traceView?.size ? { traces: traceView } : {}),
            ...(input.changeSet.outside?.length
              ? { outsideLinks: outsideLinks(this.root, index.entries()) }
              : {}),
            changeSet: input.changeSet,
            diffs,
            graph,
            files: index.entries(),
            testFiles: tests,
            // A changed helper seeds the tests importing it; it is not a test of its own.
            isTest: (path) => graph.isTestFile(path),
            mode: options.mode ?? this.config.mode,
            triggers: [...BUILTIN_TRIGGERS, ...this.config.triggers],
            runnerInputs: runners.hits,
            ...(typeCheckedTests.size ? { typeCheckedTests } : {}),
            ...(stylesheetImporterMap.size ? { stylesheetImporters: stylesheetImporterMap } : {}),
            // A plugin module inside the project decides edges: changing it widens to everything.
            globalTriggers: this.config.plugins
              .filter((p) => p.startsWith("./"))
              .map((p) => p.slice(2)),
            rules: new RulesEngine(effectiveRules(this.config)),
            packageOf: this.packageOf,
            resources,
            generated: this.config.generated
              .filter((g) => g.policy === "rebuild-required" && g.from?.length)
              .map((g) => ({ path: g.path, from: g.from ?? [] })),
          }),
    );
    if (graphDiff.length) decision.details.graphDiff = graphDiff;
    if (scope)
      decision.warnings.unshift(
        ...(only?.notes ?? []),
        ...scopeWarnings(scope, input.changeSet.completeness),
      );
    decision.warnings.push(
      ...discoveryWarnings,
      ...runners.warnings,
      ...(this.provided?.warnings ?? []),
    );
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
    // Compact, paths in a shared prefix tree: with thousands of selected tests and their
    // dependency paths this file is large (decision-store.ts).
    await writeFileAtomic(
      join(this.storeDir, "runs", "last-decision.json"),
      encodeDecisionRecord({
        createdAt: new Date().toISOString(),
        description: input.description,
        fingerprint: await this.changeFingerprint(input),
        decision,
      }),
    );
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
      root: this.root,
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
      traces: traceView ?? null,
      ...(scope ? { scope } : {}),
    };
  }

  /**
   * Runs a `staged` or `push` selection on exactly the committed/pushed content. Returns undefined
   * when the working tree already matches it (the normal run is then exact).
   */
  private async runIsolated(
    kind: "staged" | "push",
    options: RunOptions,
  ): Promise<RunOutcome | undefined> {
    if ((await this.provider()) !== "git") return undefined;
    const git = this.git();
    const repoRoot = await git.root();
    // A pre-push hook with no commit has nothing to push; the normal (conservative) run tests the
    // working tree instead of an empty checkout.
    if (kind === "push" && !(await git.hasHead())) return undefined;
    const aside = await setAside(this.root, kind);
    if (!aside.unstaged.length && !aside.untracked.length && !aside.staged.length) return undefined;
    const detected = await this.changeInput(options.source ?? { kind });
    // `readBefore` must keep reading the original repository even when called from inside the
    // isolated run, where the hook's Git environment is deliberately unset. Capture the ambient
    // values now and restore them for these reads only (never by mutating process.env).
    const ambientGitEnv = Object.fromEntries(GIT_HOOK_ENV.map((key) => [key, process.env[key]]));
    const readBefore = detected.readBefore.bind(detected);
    const input: ChangeAnalysisInput = {
      ...detected,
      readBefore: (path) => runWithEnvScope(ambientGitEnv, () => readBefore(path)),
    };
    const profile = await this.profile();
    const prefix = await git.prefix();
    const iso = await isolate({
      projectRoot: this.root,
      repoRoot,
      prefix,
      kind,
      input,
      aside,
      nodeModulesDirs: [
        ...new Set([
          "",
          ...profile.workspaces.map((w) => w.dir),
          ...profile.runners.map((r) => r.dir),
        ]),
      ],
    });
    try {
      // The checkout is ready; everything below runs with the hook's Git environment removed.
      // Otherwise the engine (and the test/check subprocesses it starts) would still point at the
      // real repository's index or worktree instead of the temporary checkout.
      const hookEnvUnset = Object.fromEntries(GIT_HOOK_ENV.map((key) => [key, undefined]));
      return await runWithEnvScope(hookEnvUnset, async () => {
        // Load the configuration *inside* the checkout: a staged change to the config must be the
        // one under test, never the dirty copy in the working tree.
        const configPath = this.isolatedConfigPath(iso.root);
        const engine = await SmartTest.open({
          root: iso.root,
          ...(configPath ? { configPath } : {}),
          storeDir: this.storeDir,
          logger: this.logger,
          mirror: {
            root: this.root,
            differs: projectPaths(prefix, [...aside.unstaged, ...aside.staged]),
          },
        });
        const outputDir = isAbsolute(this.config.reports.outputDir)
          ? this.config.reports.outputDir
          : join(this.root, this.config.reports.outputDir);
        // Relative to the engine's (canonical) root, which may differ from iso.root in spelling.
        engine.loaded.config.reports.outputDir = relative(engine.root, outputDir) || ".";
        options.onIsolatedConfig?.(engine.loaded.config);
        try {
          return await engine.run({
            ...options,
            input,
            isolate: false,
            notes: [...(options.notes ?? []), iso.note, ...iso.warnings],
          });
        } finally {
          // Hook checks run in this checkout; removing it before they finish would be a race.
          await options.holdCheckout?.();
        }
      });
    } finally {
      await iso.cleanup();
    }
  }

  /** Config path to use inside a temporary checkout (undefined: discover the staged default). */
  private isolatedConfigPath(isoRoot: string): string | undefined {
    if (!this.loaded.path) return undefined;
    const rel = relative(this.root, this.loaded.path);
    // A config outside the project cannot be reproduced in the checkout; keep it as-is.
    if (rel.startsWith("..") || isAbsolute(rel)) return this.loaded.path;
    const staged = join(isoRoot, rel);
    return existsSync(staged) ? staged : undefined;
  }

  /**
   * `smarttest run --hook`: the commit-hook profile. Fail-fast and `--bail`, result cache and
   * parallel groups, project checks for the affected projects, a time budget that explains a slow
   * hook, and a record of the run.
   */
  async runHook(
    stage: "pre-commit" | "pre-push",
    options: Omit<RunOptions, "source"> & {
      onEstimate?: (e: HookEstimate) => void;
      /** Refs from the pre-push hook's stdin; read automatically when Git invoked the hook. */
      refs?: readonly PushRef[];
    } = {},
  ): Promise<HookOutcome> {
    const t0 = performance.now();
    const records = await loadHookRecords(this.storeDir);
    if (process.env.SMARTTEST_SKIP === "1") {
      records.bypasses.push({ at: new Date().toISOString(), stage, reason: "SMARTTEST_SKIP=1" });
      await saveHookRecords(this.storeDir, records);
      return { stage, skipped: true, checks: [], warnings: [], durationMs: 0 };
    }
    let remoteShas: string[] | undefined;
    if (stage === "pre-push") {
      const fromHook = isHookContext();
      const refs = options.refs ?? (fromHook ? await readPrePushRefs() : []);
      if (fromHook && !refs.length)
        throw new SmartTestError("Could not read the refs being pushed from the pre-push hook", {
          code: "ST_HOOK_PUSH_REFS_MISSING",
          category: "usage",
          hint: "Run `git push` normally: the hook receives the refs on stdin.",
        });
      await assertPushIsHead(this.root, refs);
      if (onlyDeletions(refs)) {
        // Deleting a branch pushes no content; comparing with an empty tree would run (and could
        // fail on) the whole history's tests for a push that sends nothing.
        const durationMs = Math.round(performance.now() - t0);
        records.runs.push({
          at: new Date().toISOString(),
          stage,
          durationMs,
          selected: 0,
          passed: true,
          nothingPushed: true,
        });
        await saveHookRecords(this.storeDir, records);
        return { stage, skipped: false, nothingPushed: true, checks: [], warnings: [], durationMs };
      }
      if (refs.length || options.refs !== undefined)
        remoteShas = refs.filter((ref) => !/^0+$/.test(ref.localSha)).map((ref) => ref.remoteSha);
    }
    const source: ChangeSource =
      stage === "pre-commit"
        ? { kind: "staged" }
        : { kind: "push", ...(remoteShas !== undefined ? { remoteShas } : {}) };
    const durations =
      (await readJson<Record<string, number>>(join(this.storeDir, "state", "durations.json"))) ??
      {};
    // The config under test (the staged one inside a temporary checkout), never the dirty copy.
    let active = this.config;
    let checksPromise: Promise<CheckResult[]> = Promise.resolve([]);
    const warnings: string[] = [];
    // Workspace packages are projects too: a check scoped to one must find it.
    const workspaces = (await this.profile()).workspaces.map((w) => w.dir);
    const outcome = await this.run({
      ...options,
      source,
      // The hook profile: stop at the first failure and reuse validated passes, unless the caller
      // asked for `--no-cache` (an explicit `false` is respected).
      bail: options.bail ?? true,
      cache: options.cache ?? true,
      hookScope: true,
      command: `hook ${stage}`,
      holdCheckout: () => checksPromise,
      onIsolatedConfig: (config) => {
        active = config;
      },
      onAnalysis: (a) => {
        const projects = [
          ...new Set(
            [
              "",
              ...Object.keys(active.projects),
              ...workspaces,
              ...active.runners.map((r) => r.dir ?? ""),
              ...a.runnerRoots.map((r) => r.dir ?? ""),
            ].map(normalizeProject),
          ),
        ];
        warnings.push(...unknownCheckProjects(active.hook.checks, stage, projects));
        const changed = a.input.changeSet.changes.map((c) => ({
          path: c.path,
          deleted: c.type === "deleted",
        }));
        const planned = planChecks(active.hook.checks, stage, changed, projects);
        checksPromise = runChecks(a.root, planned, active.timeoutMs, options.signal);
        const selected = a.decision.selectedTests.map((t) => t.filePath);
        const known = selected.filter((f) => durations[f] !== undefined);
        const summed = known.reduce((s, f) => s + (durations[f] ?? 0), 0);
        const groups = new Set(selected.map((f) => a.assignment.get(f)?.dir ?? "")).size || 1;
        const estimateMs = Math.round(
          summed / Math.max(1, Math.min(groups, 4)) +
            Object.values(a.timings).reduce((x, y) => x + y, 0),
        );
        options.onEstimate?.({
          estimateMs,
          budgetMs: active.hook.budgetMs,
          slowest: [...known]
            .sort((x, y) => (durations[y] ?? 0) - (durations[x] ?? 0))
            .slice(0, 5)
            .map((f) => ({ file: f, ms: durations[f] ?? 0 })),
          unknown: selected.length - known.length,
          checks: planned,
        });
        options.onAnalysis?.(a);
      },
    });
    const checks = await checksPromise;
    const durationMs = Math.round(performance.now() - t0);
    const passed =
      outcome.exitCode === ExitCode.Success && checks.every((c) => c.status === "passed");
    const tree = await treeOf(this.root, stage);
    const left = outcome.report.leftToCi ?? [];
    const scope = describeScope(active.hook);
    records.runs.push({
      at: new Date().toISOString(),
      stage,
      durationMs,
      selected: outcome.report.decision.selectedTests.length,
      passed,
      ...(left.length ? { leftToCi: left.length } : {}),
      ...(scope.length ? { scope } : {}),
      ...(tree ? { tree } : {}),
    });
    await saveHookRecords(this.storeDir, records);
    return {
      stage,
      skipped: false,
      outcome,
      checks,
      warnings,
      ...(left.length
        ? {
            leftToCi: {
              count: left.length,
              rules: [...new Set(left.map((l) => l.rule))],
              files: left,
            },
          }
        : {}),
      durationMs,
    };
  }

  /** `smarttest hook status` details: recent hook durations, bypasses, commits made without it. */
  async hookHistory(): Promise<{
    runs: number;
    medianMs: number;
    slowestMs: number;
    failures: number;
    bypasses: HookRecords["bypasses"];
    withoutHook: { checked: number; without: { sha: string; subject: string }[] };
    installedLocally: boolean;
    /** The hook scope in force (`hook.runners`, `hook.exclude`); empty: the hook runs everything. */
    scope: string[];
    /** Selected test files left to CI by the scope across the recent runs. */
    leftToCi: number;
  }> {
    const records = await loadHookRecords(this.storeDir);
    const recent = records.runs.slice(-30);
    return {
      scope: describeScope(this.config.hook),
      leftToCi: recent.reduce((n, r) => n + (r.leftToCi ?? 0), 0),
      runs: records.runs.length,
      medianMs: median(recent.map((r) => r.durationMs)),
      slowestMs: Math.max(0, ...recent.map((r) => r.durationMs)),
      failures: recent.filter((r) => !r.passed).length,
      bypasses: records.bypasses.slice(-10),
      withoutHook:
        (await this.provider()) === "git"
          ? await commitsWithoutHook(this.root, records)
          : { checked: 0, without: [] },
      installedLocally: existsSync(join(this.root, "node_modules", ".bin", "smarttest")),
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
    const only = new Set(options.files ?? []);
    let wanted = only.size ? tests.filter((t) => only.has(t)) : tests;
    if (options.stale) {
      const view = await this.traceView(undefined, index);
      wanted = wanted.filter((t) => !view?.isFresh(t));
    }
    const current = new Set(tests);
    for (const t of Object.keys(store.tests)) if (!current.has(t)) delete store.tests[t];
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
          ...traceEnv(executed.keys(), index),
          executed: Object.fromEntries([...executed].map(([f, s]) => [f, [...s].sort()])),
          known: Object.fromEntries([...known].map(([f, s]) => [f, [...s].sort()])),
        };
        options.onProgress?.(`[${done}/${total}] ${job.file} — ${executed.size} file(s)`);
      }
    };
    const n = Math.max(1, Math.min(options.concurrency ?? 4, jobs.length));
    await Promise.all(Array.from({ length: n }, () => worker()));
    await cleanDir(tmp);
    const notSaved = await saveTraces(this.storeDir, store);
    if (notSaved) {
      const warning = `Traces could not be saved (${notSaved.message}): they are recorded again next time`;
      this.logger.warn(warning);
      options.onProgress?.(warning);
    }
    return {
      traced: total - failed.length,
      failed,
      kept: notSaved ? 0 : Object.keys(store.tests).length,
      store,
    };
  }

  private async semanticDiffs(
    input: ChangeAnalysisInput,
    index: SymbolIndex,
    graphDiff: { file: string; added: string[]; removed: string[] }[] = [],
    resources = new Map<string, ResourceChange>(),
  ): Promise<Map<string, FileSemanticDiff>> {
    const diffs = new Map<string, FileSemanticDiff>();
    const { readFile } = await import("node:fs/promises");
    const { analyzers: ANALYZERS } = await languages();
    // Each "before" read is a VCS process: start the ones the loop below needs together.
    const resource = (path: string) =>
      isEnvFile(path) || isPrismaSchema(path) || isJsonCatalog(path, LOCALE_PATH);
    await mapLimit(
      input.changeSet.changes.filter(
        (c) =>
          c.type !== "added" &&
          (resource(c.path) ||
            (c.type !== "deleted" &&
              index.get(c.path) !== undefined &&
              ANALYZERS.some((a) => a.supports(c.path)))),
      ),
      8,
      (c) => input.readBefore(c.previousPath ?? c.path),
    );
    for (const change of input.changeSet.changes) {
      // Resource files (env, Prisma schema, JSON catalogs): key-level diff.
      if (resource(change.path)) {
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

  /** Tests whose runner type-checks every file they import (Angular's unit-test and Karma builds). */
  private async typeCheckedTests(
    assignment: ReadonlyMap<string, RunnerRoot>,
  ): Promise<Set<string>> {
    const out = new Set<string>();
    const checks = new Map<RunnerRoot, boolean>();
    for (const [test, root] of assignment) {
      if (root.adapter !== "angular") continue;
      if (!checks.has(root)) {
        const file = root.configFile ?? (root.dir ? `${root.dir}/angular.json` : "angular.json");
        const text = await readFileText(join(this.root, file), "utf8").catch(() => "");
        const target = angularTestTargets(text).find(
          (t) => !root.project || t.project === root.project,
        );
        // Unreadable: assume it does, which selects more, never less.
        checks.set(root, target?.typeChecks ?? true);
      }
      if (checks.get(root)) out.add(test);
    }
    return out;
  }

  // ── Run ─────────────────────────────────────────────────────────────────────────────────

  /** Adapter for a runner group (used by the history benchmark). */
  createAdapterFor(
    group: Group & { configFile?: string; patterns?: string[]; project?: string },
  ): TestAdapter {
    return this.createAdapter(group);
  }

  private createAdapter(group: Group, coverageDir?: string): TestAdapter {
    const cwd = join(this.root, group.dir);
    const g = group as Group & { configFile?: string; patterns?: string[]; project?: string };
    const base = {
      projectRoot: this.root,
      cwd,
      ...(coverageDir ? { coverageDir } : {}),
      ...(g.configFile ? { configFile: g.configFile } : {}),
    };
    if (group.adapter === "jest") return new JestAdapter(base);
    if (group.adapter === "vitest") return new VitestAdapter(base);
    if (group.adapter === "angular")
      return new AngularAdapter({
        projectRoot: this.root,
        cwd,
        ...(g.configFile ? { configFile: g.configFile } : {}),
        ...(g.project ? { project: g.project } : {}),
      });
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
    const kind = options.source?.kind;
    if (
      (kind === "staged" || kind === "push") &&
      options.isolate !== false &&
      !options.analysis &&
      !options.input
    ) {
      const isolated = await this.runIsolated(kind, options);
      if (isolated) return isolated;
    }
    const started = new Date();
    const runId = newRunId();
    // Adaptive policy: when the whole suite ran faster last time than an analysis usually takes,
    // running everything is both cheaper and complete.
    const statsPath = join(this.storeDir, "state", "timings.json");
    const recorded = (await readJson<AdaptiveTimings>(statsPath)) ?? {};
    const typicalAnalysis = typicalAnalysisMs(recorded);
    // A scoped run (`only`) is meant to be small: running everything would defeat it.
    const adaptive =
      !options.all && !options.only && this.config.adaptive !== false && adaptiveApplies(recorded);
    const analysis =
      options.analysis ??
      (await this.analyze({
        ...options,
        ...(adaptive
          ? {
              everything: {
                reason: `Adaptive: the full suite took ${Math.round(recorded.fullRunMs ?? 0)} ms last time, less than a typical analysis (${Math.round(typicalAnalysis ?? 0)} ms), so everything runs`,
              },
            }
          : {}),
      }));
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
      throw new SmartTestError(
        "No test runner setup found (Jest, Vitest, node --test, Playwright or Cypress)",
        {
          code: "ST_NO_RUNNER",
          category: "infrastructure",
          hint: 'Install Vitest or Jest, add a `"test": "node --test"` script, or set `adapters` in smarttest.config; `smarttest doctor` shows what was detected.',
        },
      );
    }
    const durationsPath = join(this.storeDir, "state", "durations.json");
    const durations = (await readJson<Record<string, number>>(durationsPath)) ?? {};
    const warnings: string[] = [...(options.notes ?? [])];
    // Sharding: this run takes its share of the selection, balanced by recorded durations.
    if (options.shard) {
      const all = analysis.decision.selectedTests.map((t) => t.filePath);
      const mine = new Set(
        shardFiles(all, durations, options.shard.total)[options.shard.index - 1] ?? [],
      );
      analysis.decision.selectedTests = analysis.decision.selectedTests.filter((t) =>
        mine.has(t.filePath),
      );
      warnings.push(
        `Shard ${options.shard.index}/${options.shard.total}: ${mine.size} of ${all.length} selected test files run here; the others run in the other shards`,
      );
    }
    // Hook scope: selected tests the hook does not run stay selected and are reported as left to
    // CI with the rule that removed them; they are never passed and never dropped (§32.2).
    const leftToCi = options.hookScope
      ? outsideHookScope(
          analysis.decision.selectedTests.map((t) => ({
            file: t.filePath,
            adapter: analysis.assignment.get(t.filePath)?.adapter,
          })),
          this.config.hook,
        )
      : [];
    const leftFiles = new Set(leftToCi.map((l) => l.file));
    const toRun = analysis.decision.selectedTests.filter((t) => !leftFiles.has(t.filePath));
    if (leftToCi.length)
      warnings.push(
        `${leftToCi.length} selected test file(s) not run in the hook (left to CI) by ${[...new Set(leftToCi.map((l) => l.rule))].join(", ")} — \`smarttest run\` and \`smarttest ci\` run them`,
      );
    // Validated result cache: a passing result is reused only while every input is unchanged.
    const history = await loadHistory(this.storeDir);
    const useCache = (options.cache ?? this.config.cache) && !options.all && !options.coverage;
    const resultCache = useCache ? await loadResultCache(this.storeDir) : undefined;
    const keys = useCache
      ? await this.resultKeys(
          analysis,
          toRun.map((t) => t.filePath),
          history,
        )
      : new Map<string, string>();
    const cachedExecutions: FileExecution[] = [];
    let cacheSavedMs = 0;
    if (resultCache)
      for (const [file, key] of keys) {
        const hit = cacheGet(resultCache, file, key);
        if (!hit) continue;
        cacheSavedMs += hit.durationMs;
        cachedExecutions.push({
          file,
          adapter: analysis.assignment.get(file)?.adapter ?? "cache",
          status: "cached-pass",
          durationMs: 0,
          tests: hit.tests.map((t) => ({
            testId: t.testId,
            status: "cached-pass",
            durationMs: 0,
            attempts: 0,
          })),
        });
      }
    const cachedFiles = new Set(cachedExecutions.map((e) => e.file));
    // Fail-fast order: recent failures, then the tests closest to the change.
    const depthOf = new Map(
      toRun.map((t) => [t.filePath, Math.min(...t.reasons.map((r) => r.path?.length ?? 99), 99)]),
    );
    const order = failFastOrder(
      toRun.map((t) => t.filePath).filter((f) => !cachedFiles.has(f)),
      recentlyFailingFiles(history),
      (f) => depthOf.get(f) ?? 99,
    );
    const rank = new Map(order.map((f, i) => [f, i]));
    const plan = planExecution(
      order,
      analysis.runnerRoots,
      this.config.adapters,
      analysis.assignment,
    );
    for (const g of plan.groups) g.files.sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0));
    // A selected test that no runner collects cannot run. It is never dropped: it gets an
    // infrastructure-error record, so the run fails (exit 4) and names the file and the cause.
    const discoveryFailures = analysis.decision.warnings.filter((w) =>
      w.includes("discovery failed"),
    );
    const uncollected: FileExecution[] = plan.unassigned.map((file) => ({
      file,
      adapter: "none",
      status: "infrastructure-error",
      durationMs: 0,
      tests: [],
      error: `Selected, but no runner collects this file, so it was not run.${
        discoveryFailures.length
          ? ` Cause: ${discoveryFailures.join("; ")}`
          : " Add it to a runner's include patterns (or declare `runners`); if it is not meant to run, add it to `exclude` in the SmartTest config."
      }`,
    }));
    if (uncollected.length) {
      warnings.push(
        `${uncollected.length} selected test file(s) were not run because no runner collects them: ${uncollected
          .slice(0, 5)
          .map((u) => u.file)
          .join(", ")}${uncollected.length > 5 ? "…" : ""} — the run cannot pass`,
      );
    }
    // A runner whose listing failed is shown with every run, hook runs included, until fixed.
    warnings.push(...discoveryFailures);
    plan.groups.sort(
      (a, b) => (rank.get(a.files[0] ?? "") ?? 0) - (rank.get(b.files[0] ?? "") ?? 0),
    );
    // Duration-aware scheduling: independent runner groups in parallel within the CPU budget.
    const cpus = availableParallelism();
    const concurrency =
      this.config.parallelGroups === "auto"
        ? Math.max(1, Math.min(plan.groups.length, Math.floor(cpus / 4), 4))
        : Math.max(1, this.config.parallelGroups);
    const explicitWorkers = options.workers ?? this.config.workers;
    const workers =
      explicitWorkers ??
      (concurrency > 1 && plan.groups.length > 1
        ? Math.max(1, Math.floor((cpus - 1) / Math.min(concurrency, plan.groups.length)))
        : undefined);
    const coverageDirs: string[] = [];
    const browserCoverageDirs: string[] = [];
    const summary = await timed(timings, "test execution", () =>
      executeGroups(plan.groups, {
        concurrency,
        exclusive: ["playwright", "cypress"],
        ...(options.bail ? { bail: true } : {}),
        createAdapter: (g) => {
          const dir = options.coverage ? this.coverageDirFor(g) : undefined;
          if (dir) coverageDirs.push(join(dir, "coverage-final.json"));
          // The Playwright coverage fixture writes Chromium's V8 coverage here.
          if (dir && g.adapter === "playwright") browserCoverageDirs.push(join(dir, "v8"));
          return this.createAdapter(g, dir);
        },
        timeoutMs: options.timeoutMs ?? this.config.timeoutMs,
        retries: options.retries ?? this.config.retries,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(workers ? { workers } : {}),
        coverage: !!options.coverage,
        ...(options.onEvent ? { onEvent: options.onEvent } : {}),
      }),
    );
    if (cachedExecutions.length)
      warnings.push(
        `${cachedExecutions.length} test file(s) reused a cached passing result (every input unchanged; not run, about ${Math.round(cacheSavedMs)} ms saved) — \`--no-cache\` runs them`,
      );
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
      // "full" only when every test of the suite ran here: not a shard, nothing left to CI,
      // nothing cancelled (bail, abort) or uncollected. Anything less is partial coverage (§32.2).
      const scope =
        options.all &&
        !options.shard &&
        !leftToCi.length &&
        !uncollected.length &&
        summary.files.every((f) => f.status !== "cancelled" && f.status !== "infrastructure-error")
          ? "full"
          : "selected";
      const [summaryReport, lines, browser] = await timed(timings, "coverage", () =>
        Promise.all([
          ingestIstanbul(coverageDirs, this.root, scope, runId),
          ingestIstanbulLines(coverageDirs, this.root, scope, runId),
          browserCoverageDirs.length
            ? ingestBrowserV8(browserCoverageDirs, this.root, scope, runId)
            : Promise.resolve(undefined),
        ]),
      );
      coverage = summaryReport;
      // Line detail of each origin is replaced only by a run that measured that origin; each file
      // names its run, scope and time, and readers check file hashes before showing lines.
      if (coverage) await writeJson(join(this.storeDir, "runs", "coverage.json"), coverage);
      if (lines) await writeJson(join(this.storeDir, "runs", "coverage-lines.json"), lines);
      if (browser)
        await writeJson(join(this.storeDir, "runs", "browser-coverage-lines.json"), browser);
      if (!coverage && !browser)
        warnings.push(
          "Coverage was requested but no coverage report was produced — is a coverage provider installed?",
        );
      else if (browser && !coverage)
        warnings.push(
          "Only browser coverage was recorded (Playwright, Chromium): it is kept apart from runner coverage and has no summary percentage",
        );
    }
    const executions: FileExecution[] = [
      ...summary.files.map((f) => ({ ...f })),
      ...cachedExecutions,
      ...uncollected,
    ].sort((a, b) => a.file.localeCompare(b.file));
    // Record fresh passing results in the cache and every fresh result in the history. Per-test
    // state of files that no longer exist (deleted, renamed tests) is dropped: it only grows.
    let live: Set<string> | undefined;
    const liveFiles = () => {
      live ??= new Set([...analysis.testFiles, ...analysis.index.entries().keys()]);
      return live;
    };
    if (resultCache) {
      for (const f of summary.files) {
        const key = keys.get(f.file);
        const clean =
          f.status === "passed" &&
          f.tests.every(
            (t) =>
              t.attempts <= 1 &&
              (t.status === "passed" || t.status === "skipped" || t.status === "pending"),
          );
        if (key && clean)
          cachePut(resultCache, f.file, {
            key,
            at: new Date().toISOString(),
            durationMs: Math.round(f.durationMs),
            tests: f.tests,
          });
      }
      await saveResultCache(this.storeDir, resultCache, liveFiles());
    }
    recordRun(
      history,
      summary.files.flatMap((f) => f.tests),
    );
    pruneHistory(history, liveFiles());
    await saveHistory(this.storeDir, history);
    // Duration history: estimate what skipping saved, then record fresh measurements.
    const skipped = analysis.decision.skippedTests.map((t) => t.filePath);
    const known = skipped.filter((f) => durations[f] !== undefined);
    const estimate = known.length
      ? {
          skippedTestTimeMs: known.reduce((a, f) => a + (durations[f] ?? 0), 0),
          knownSkipped: known.length,
          totalSkipped: skipped.length,
        }
      : undefined;
    for (const e of summary.files)
      if (e.status !== "cancelled" && e.status !== "infrastructure-error")
        durations[e.file] = Math.round(e.durationMs);
    for (const f of Object.keys(durations)) if (!liveFiles().has(f)) delete durations[f];
    await writeFileAtomic(durationsPath, `${JSON.stringify(durations)}\n`);
    // Timings for the adaptive policy: typical analysis time, and the last full-suite wall time.
    // The full-suite time counts only when the whole suite really ran (see `fullSuiteMeasured`).
    const fullRun =
      analysis.decision.skippedTests.length === 0 &&
      analysis.testFiles.length > 0 &&
      !cachedExecutions.length &&
      !leftToCi.length &&
      !uncollected.length &&
      !options.shard &&
      fullSuiteMeasured(summary, { bail: !!options.bail, aborted: !!options.signal?.aborted });
    await writeJson(
      statsPath,
      nextAdaptiveTimings(recorded, {
        adaptive,
        analysisMs,
        fullRun,
        fullRunMs: timings["test execution"] ?? 0,
        at: new Date(),
      }),
    );
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
      change: {
        description: analysis.input.description,
        changeSet: analysis.input.changeSet,
        ...(analysis.scope ? { only: analysis.scope } : {}),
      },
      decision: stripDetails(analysis.decision),
      executions,
      summary: summarize(analysis.decision, executions, durationMs, leftToCi.length),
      ...(leftToCi.length ? { leftToCi } : {}),
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
    // A scoped run (`only`), a shard, and a run that left selected tests to CI did not test the
    // whole change set, so none of them advances it (the other shards' tests would never run).
    if (
      status === "passed" &&
      !analysis.scope &&
      !options.shard &&
      !leftToCi.length &&
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

  /**
   * Line and branch detail of the last coverage run of each origin: runner istanbul output and
   * browser V8 coverage (Playwright fixture). The two are separate measurements, never merged.
   */
  async lineCoverage(): Promise<{
    istanbul: LineCoverageReport | undefined;
    browser: LineCoverageReport | undefined;
  }> {
    const [istanbul, browser] = await Promise.all([
      readJson<LineCoverageReport>(join(this.storeDir, "runs", "coverage-lines.json")),
      readJson<LineCoverageReport>(join(this.storeDir, "runs", "browser-coverage-lines.json")),
    ]);
    const valid = (r: LineCoverageReport | undefined) =>
      r && r.schemaVersion === 1 && r.files && typeof r.files === "object" ? r : undefined;
    return { istanbul: valid(istanbul), browser: valid(browser) };
  }

  // ── Explain & graph ─────────────────────────────────────────────────────────────────────

  async explain(
    target: string,
    options: AnalyzeOptions & {
      fresh?: boolean;
      /** Per-unit breakdown for these units of a source file, in one graph build. */
      units?: readonly string[];
    } = {},
  ) {
    let saved = options.fresh
      ? undefined
      : await readFileText(join(this.storeDir, "runs", "last-decision.json"), "utf8").then(
          (text) =>
            decodeDecisionRecord<{
              decision: ImpactResult;
              description: string;
              createdAt?: string;
              fingerprint?: string;
            }>(text),
          () => undefined,
        );
    // The last decision explains the last run only while the change and the mode are the same:
    // after an edit (or with another mode or source) it would explain a selection that no longer
    // applies, so the change is analysed again.
    let moved: string | undefined;
    if (saved) {
      const mode = options.mode ?? this.config.mode;
      const fingerprint = await this.changeFingerprint(await this.changeInput(options.source));
      if (
        saved.fingerprint !== fingerprint ||
        (saved.decision.requestedMode ?? saved.decision.safetyMode) !== mode
      ) {
        moved = saved.createdAt ?? "an earlier run";
        saved = undefined;
      }
    }
    const analysis = saved ? undefined : await this.analyze(options);
    const decision = saved?.decision ?? (analysis as Analysis).decision;
    const description = saved
      ? `${saved.description} · decision of the run at ${saved.createdAt ?? "an earlier time"}`
      : moved
        ? `fresh analysis (the change or mode moved since the run at ${moved})`
        : "fresh analysis";
    const asTest = () => ({
      kind: "test" as const,
      target,
      description,
      mode: decision.safetyMode,
      analysisStatus: decision.analysisStatus,
      ...explainTest(decision, target),
    });
    // A test of the decision is explained from the decision alone: no index, graph or discovery.
    if (
      decision.selectedTests.some((t) => t.filePath === target) ||
      decision.skippedTests.some((t) => t.filePath === target)
    )
      return asTest();
    // The analysis just made has the index, graph and discovery this needs. Its graph links
    // end-to-end tests to the routes they visit, which the graph below does not: with end-to-end
    // tests, the graph is built as before.
    const reuse =
      analysis &&
      !options.everything &&
      ![...analysis.assignment.values()].some(
        (r) => r.adapter === "playwright" || r.adapter === "cypress",
      )
        ? analysis
        : undefined;
    const index = reuse ? reuse.index : (await this.loadIndex()).index;
    const graph = reuse ? reuse.graph : this.buildGraph(index);
    let discovered: { roots: RunnerRoot[]; assignment: Map<string, RunnerRoot> };
    if (reuse) discovered = { roots: reuse.runnerRoots, assignment: reuse.assignment };
    else {
      const found = await this.discoverTests(index);
      graph.setDiscovery(found);
      discovered = found;
    }
    if (graph.isTestFile(target)) return asTest();
    // A source file or symbol: which tests protect it?
    const [file, unit] = target.includes("#")
      ? (target.split("#") as [string, string])
      : [target, "*"];
    // Files a runner loads because its configuration names them (setup files, config imports…).
    const loadedBy = runnerHits({
      ...this.runnerGraphView(index, graph, discovered.assignment),
      inputs: await this.runnerInputs(discovered.roots),
      changeSet: {
        provider: "explain",
        changes: [{ path: file, type: "modified" }],
        completeness: "complete",
        warnings: [],
      },
    }).hits.map((h) => ({
      reason: h.message.replace(/^.+? changed — /, ""),
      tests: [...h.tests],
      ...(h.path ? { path: h.path } : {}),
    }));
    if (!index.get(file) && !graph.hasFile(file) && !loadedBy.length) {
      throw new SmartTestError(`Unknown test, file or symbol: ${target}`, {
        code: "ST_UNKNOWN_TARGET",
        category: "usage",
        hint: "Use a project-relative path, e.g. src/auth/AuthService.ts or src/auth/AuthService.ts#AuthService",
      });
    }
    const hits = graph.dependentsOf([{ file, units: [unit] }]);
    const testsOf = (h: typeof hits) =>
      [...h.tests.values()].map((x) => ({ test: x.test, path: x.path }));
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
      tests: testsOf(hits),
      ...(options.units
        ? {
            units: options.units.map((u) => ({
              unit: u,
              tests: testsOf(graph.dependentsOf([{ file, units: [u] }])),
            })),
          }
        : {}),
      uncertainty: graph.uncertaintyReachableFrom(file),
      loadedBy,
      rules: policy.matched.map((m) => m.rule.name),
      risk: policy.risk,
    };
  }

  /**
   * Identifies a change: its source, revisions, and each changed path with its current content.
   * Two analyses with the same fingerprint decide on the same change.
   */
  private async changeFingerprint(input: ChangeAnalysisInput): Promise<string> {
    const cs = input.changeSet;
    const parts: string[] = [input.description, cs.baseRevision ?? "", cs.targetRevision ?? ""];
    for (const c of [...cs.changes].sort((a, b) => a.path.localeCompare(b.path)))
      parts.push(
        `${c.type}:${c.previousPath ?? ""}:${c.path}:${c.type === "deleted" ? "" : ((await hashFile(this.root, c.path)) ?? "missing")}`,
      );
    return createHash("sha256").update(parts.join("\n")).digest("hex");
  }

  /** Shortest dependency path, import cycles and untested files (`smarttest graph why|cycles|orphans`). */
  async graphInsights(): Promise<{ graph: DependencyGraph; tests: string[] }> {
    const { index } = await this.loadIndex();
    const graph = this.buildGraph(index);
    const { tests, helpers } = await this.discoverTests(index);
    graph.setDiscovery({ tests, helpers });
    return { graph, tests };
  }

  async graphQuery(options: {
    from?: string;
    direction?: "dependents" | "dependencies";
    depth?: number;
  }) {
    const { index } = await this.loadIndex();
    const graph = this.buildGraph(index);
    // Exports mark test files too: what a runner collects, not only what is named like a test.
    graph.setDiscovery(await this.discoverTests(index));
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
    // A file a runner collects is a test whatever its name (`test/math.js` under `node --test`).
    const testSet = new Set(tests);
    const sources = [...index.entries().keys()].filter((f) => !testSet.has(f) && !this.isTest(f));
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
      // A hook SmartTest must not edit (shared, owned by a dependency, not a shell script) leaves
      // the rest of the setup intact: init reports it and goes on without the hook.
      const hook = await planHookInstall(this.root, {
        replace: true,
        testCommands: profile.testCommands,
      }).catch((error: unknown) => {
        if (
          error instanceof SmartTestError &&
          ["ST_HOOK_PATH_OUTSIDE_REPO", "ST_HOOK_PATH_IN_DEPENDENCY", "ST_HOOK_NOT_SHELL"].includes(
            error.code,
          )
        ) {
          plan.warnings.push(
            `Git hook not installed: ${error.message}. ${error.hint ?? ""}`.trim(),
          );
          return undefined;
        }
        throw error;
      });
      if (hook && !hook.installed) {
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
    options: { manager?: HookManager; replace?: boolean; stage?: HookStage } = {},
  ): Promise<HookPlan> {
    const profile = await this.profile();
    return planHookInstall(this.root, { ...options, testCommands: profile.testCommands });
  }

  /**
   * The hook scope to propose (`hook.runners`) when browser runners (Playwright, Cypress) sit next
   * to a unit runner and no scope is configured; undefined otherwise.
   */
  async hookScopeSuggestion(): Promise<string[] | undefined> {
    if (describeScope(this.config.hook).length) return undefined;
    const roots = await this.runnerRoots();
    return suggestHookRunners(roots.map((r) => r.adapter));
  }

  async hookUninstallPlan(
    manager?: HookManager,
    stages?: readonly HookStage[],
  ): Promise<FilePlan[]> {
    return planHookUninstall(this.root, manager, stages);
  }

  /**
   * Applies file changes. `journal` (default true) records them in the init journal, so
   * `init --rollback` undoes them too (`migrate`); hook installs and removals are not init's steps
   * and pass false (`smarttest hook uninstall` undoes them).
   */
  async applyFiles(files: FilePlan[], options: { journal?: boolean } = {}): Promise<string[]> {
    const plan = { summary: "", recommendations: [], warnings: [], files, config: {} } as SetupPlan;
    const journal = await applyPlan(this.root, this.storeDir, plan, options);
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
    const formatWarnings: string[] = [];
    const journal = await applyPlan(this.root, this.storeDir, plan, {
      ...options,
      onWarning: (m) => formatWarnings.push(m),
    });
    const applied = plan.files
      .filter((f) => f.action !== "skip" && journal.entries.some((e) => e.path === f.path))
      .map((f) => f.path);
    const validation = await this.validateSetup();
    // A formatter failure never fails init: the file is valid, only its style differs.
    validation.messages.push(...formatWarnings);
    const reportPath = join(this.storeDir, "reports", "setup.md");
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
        // Each root is listed with its own config: vitest.config.ts and vitest.stryker.config.ts in
        // one directory collect different files.
        const cases = await this.createAdapter({
          adapter: r.adapter,
          dir: r.dir,
          files: [],
          ...(r.configFile ? { configFile: r.configFile } : {}),
          ...(r.patterns ? { patterns: r.patterns } : {}),
          ...(r.project ? { project: r.project } : {}),
        } as Group).discover();
        const where = r.configFile ?? (r.dir || ".");
        messages.push(`${r.adapter} (${where}) discovers ${cases.length} test file(s)`);
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

  /**
   * Result-cache keys for the tests that can be cached: every input that can change a test's
   * result is hashed (its static closure and the files its last fresh trace loaded, runner config,
   * manifests, lockfiles, tsconfig, env files, setup files, manual mocks, snapshots, Node and runner
   * versions). Tests with uncertain dependencies, file reads, flaky history or an end-to-end runner
   * are never cached.
   */
  private async resultKeys(
    analysis: Analysis,
    tests: readonly string[],
    history: HistoryStore,
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (!tests.length) return out;
    const profile = await this.profile();
    const files = await this.allFiles();
    const fileSet = new Set(files);
    const hashes = new Map<string, string>();
    const h = async (f: string): Promise<string> => {
      let v = hashes.get(f);
      if (v === undefined) {
        v = analysis.index.get(f)?.hash ?? (await hashFile(this.root, f)) ?? "missing";
        hashes.set(f, v);
      }
      return v;
    };
    const { readJson: rj } = await import("@smarttest/shared");
    const view = await this.traceView(undefined, analysis.index).catch(() => undefined);
    const flaky = new Set(
      Object.entries(history.tests)
        .filter(([, x]) => x.flaky > 0 || /F.*P|P.*F/.test(x.recent.slice(-10)))
        .map(([id]) => id.slice(0, id.indexOf("::") > -1 ? id.indexOf("::") : undefined)),
    );
    const shared = new Map<string, Record<string, string>>();
    for (const t of tests) {
      const root = analysis.assignment.get(t);
      if (!root || root.adapter === "playwright" || root.adapter === "cypress") continue;
      if (flaky.has(t)) continue;
      if (analysis.graph.uncertaintyCount(t)) continue;
      const closure = [t, ...analysis.graph.dependenciesOf(t)];
      if (closure.some((f) => analysis.index.get(f)?.assetReads?.length)) continue;
      const rk = `${root.adapter}:${root.dir}`;
      let base = shared.get(rk);
      if (!base) {
        const dir = root.dir ? `${root.dir}/` : "";
        const inScope = (f: string) => !root.dir || f.startsWith(dir) || !f.includes("/");
        const global = files.filter(
          (f) =>
            inScope(f) &&
            (/(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|tsconfig[^/]*\.json|\.env[^/]*|babel\.config\.[^/]+|\.babelrc[^/]*|\.swcrc|\.nvmrc|\.node-version|\.tool-versions|\.npmrc|postcss\.config\.[^/]+|\.postcssrc[^/]*|tailwind\.config\.[^/]+)$/.test(
              f,
            ) ||
              /(^|\/)__mocks__\//.test(f) ||
              profile.tests.setupFiles.includes(f)),
        );
        const runnerPkg = root.adapter === "node" ? undefined : root.adapter;
        let runnerVersion = "";
        for (let d = join(this.root, root.dir); runnerPkg; d = join(d, "..")) {
          const pkg = await rj<{ version?: string }>(
            join(d, "node_modules", runnerPkg, "package.json"),
          );
          if (pkg?.version) {
            runnerVersion = pkg.version;
            break;
          }
          if (d === this.root || d === join(d, "..")) break;
        }
        base = {
          node: process.versions.node,
          runner: `${root.adapter}@${runnerVersion}`,
          smarttest: TOOL.version,
          config: root.configFile ? await h(root.configFile) : "",
        };
        for (const f of global.sort()) base[`g:${f}`] = await h(f);
        // What the configuration makes the runner load: its imports, setup files, mapped
        // modules, and everything they import. Any change there can change any result.
        const inputs = await readRunnerInputs(this.root, root);
        for (const f of runnerInputFiles(inputs, (file) =>
          (analysis.index.get(file)?.imports ?? []).flatMap((i) =>
            i.resolved && i.resolved !== file ? [i.resolved] : [],
          ),
        ))
          base[`r:${f}`] = await h(f);
        // A value it can't read statically could name any file: no cached result.
        if (inputs.computed.length) base = { uncacheable: "computed configuration" };
        shared.set(rk, base);
      }
      if (base.uncacheable) continue;
      const parts: Record<string, string> = { ...base };
      for (const f of closure) parts[`f:${f}`] = await h(f);
      const trace = view?.trace(t);
      if (trace) for (const f of Object.keys(trace.fileHashes)) parts[`f:${f}`] = await h(f);
      const snap = `${t.includes("/") ? t.slice(0, t.lastIndexOf("/") + 1) : ""}__snapshots__/${t.slice(t.lastIndexOf("/") + 1)}.snap`;
      if (fileSet.has(snap)) parts[`s:${snap}`] = await h(snap);
      out.set(t, resultKey(parts));
    }
    return out;
  }

  /** Files of one shard of the selection (or of every test with `all`). */
  async shardPlan(options: {
    total: number;
    index: number;
    source?: ChangeSource;
    all?: boolean;
  }): Promise<string[]> {
    const analysis = await this.analyze(options.source ? { source: options.source } : {});
    const files = options.all
      ? analysis.testFiles
      : analysis.decision.selectedTests.map((t) => t.filePath);
    const durations =
      (await readJson<Record<string, number>>(join(this.storeDir, "state", "durations.json"))) ??
      {};
    return shardFiles(files, durations, options.total)[options.index - 1] ?? [];
  }

  /** Flaky tests from the recorded run history. */
  async flakyTests(minRate = 0.05): Promise<FlakyEntry[]> {
    return flakyReport(await loadHistory(this.storeDir), minRate);
  }

  /** `smarttest watch`: reruns affected tests after each batch of saves until closed. */
  async watch(options: {
    onRun: (outcome: RunOutcome, files: string[]) => void;
    onAnalysis?: (analysis: Analysis) => void;
    onError?: (error: Error) => void;
    mode?: SafetyMode;
  }): Promise<Watcher> {
    const git = (await this.provider()) === "git";
    this.keepWarm = true;
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
  /** Adds the store to `.gitignore` (Git projects); returns what was done, if anything. */
  async ignoreStore(): Promise<string | undefined> {
    const { readFile, writeFile: wf } = await import("node:fs/promises");
    const gi = join(this.root, ".gitignore");
    const storeRel =
      this.trackedStore?.dir ?? relative(this.root, this.storeDir).split("\\").join("/");
    if ((await this.provider()) !== "git" || !storeRel || storeRel.startsWith(".."))
      return undefined;
    const text = await readFile(gi, "utf8").catch(() => "");
    if (
      text.split(/\r?\n/).some((l) => l.trim().replace(/^\//, "").replace(/\/$/, "") === storeRel)
    )
      return undefined;
    assertNoSymlinkBelow(this.root, gi); // a committed `.gitignore` link must not be followed
    await wf(gi, `${text}${text && !text.endsWith("\n") ? "\n" : ""}${storeRel}/\n`);
    return `.gitignore: ignore ${storeRel}/`;
  }

  async doctorFix(): Promise<string[]> {
    const fixed: string[] = [];
    const { readFile, readdir, rm } = await import("node:fs/promises");
    const storeRel = relative(this.root, this.storeDir).split("\\").join("/");
    const ignored = await this.ignoreStore();
    if (ignored) fixed.push(ignored);
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
    if (this.trackedStore) {
      const e = storeTrackedError(this.trackedStore);
      out.push({
        severity: "error",
        check: "store",
        message: e.message,
        hint: `Run \`git rm -r --cached ${this.trackedStore.dir}\` and ignore ${this.trackedStore.dir}/ (\`smarttest doctor --fix\` adds the entry and offers to run the command).`,
      });
    }
    // One project listing serves detection and the index below.
    const listing = (await gitProjectFiles(this.root)) ?? undefined;
    const profile = await this.profile(listing);
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
    {
      // The key every signed cache (index, graph, discovery, cached passes) is checked with.
      stateKey();
      const source = stateKeySource();
      if (source === "repaired")
        out.push({
          severity: "warn",
          check: "state-key",
          message: `The state key (${stateKeyFile()}) was truncated or damaged and has been replaced; caches signed with the old key are rebuilt once`,
          hint: "Nothing to do. If it happens again, check the disk and what else writes to that directory.",
        });
      else if (source === "ephemeral")
        out.push({
          severity: "warn",
          check: "state-key",
          message: `No state key could be stored (${stateKeyFile()}): signed caches last for one process, so every run rebuilds the index and graph`,
          hint: "Make the directory writable, or set SMARTTEST_STATE_KEY (32+ characters).",
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
    if (this.config.plugins.length) {
      try {
        for (const { spec, plugin } of await this.plugins()) {
          const providers = (plugin.edgeProviders ?? []).map((p) => p.id);
          out.push({
            severity: "ok",
            check: "plugins",
            message: `${plugin.name} (${spec})${providers.length ? ` · edge providers: ${providers.join(", ")}` : ""}`,
          });
        }
      } catch (error) {
        const e = error as SmartTestError;
        out.push({
          severity: "error",
          check: "plugins",
          message: e.message,
          ...(e.hint ? { hint: e.hint } : {}),
        });
      }
    }
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
    if (provider === "svn" || provider === "hg") {
      const state = await (provider === "svn"
        ? new SvnAdapter(this.root)
        : new HgAdapter(this.root)
      ).getWorkingState();
      out.push({
        severity: "ok",
        check: "vcs",
        message: `${provider === "svn" ? "Subversion" : "Mercurial"} · ${state.head?.ref ?? "no revision"}${state.dirty ? " · uncommitted changes" : ""}`,
      });
    } else if (provider === "git") {
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
      const { index, stats } = await this.loadIndex(listing ? { gitFiles: listing } : {});
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
    if ((await this.provider()) === "git") {
      const history = await this.hookHistory();
      const stages: HookStage[] = ["pre-commit", "pre-push"];
      const plans = await Promise.all(
        stages.map((stage) =>
          this.hookInstallPlan({ stage }).catch((error: unknown) => {
            // A hook SmartTest refuses to edit (outside the repository, not a shell script).
            if (!(error instanceof SmartTestError)) throw error;
            out.push({
              severity: "warn",
              check: "hook",
              message: `${stage}: ${error.message}`,
              ...(error.hint ? { hint: error.hint } : {}),
            });
            return undefined;
          }),
        ),
      );
      for (const plan of plans) {
        if (!plan) continue;
        if (!plan.installed) {
          out.push({
            severity: "info",
            check: "hook",
            message: `${plan.stage} hook not installed`,
            hint: `Run \`smarttest hook install${plan.stage === "pre-push" ? " --pre-push" : ""}\`.`,
          });
          continue;
        }
        const text = (await readText(join(this.root, plan.file))) ?? "";
        const invocations = hookInvocations(text, plan.stage);
        out.push({
          severity: "ok",
          check: "hook",
          message: `${plan.stage} hook installed in ${plan.file} (${plan.manager})`,
        });
        if (invocations > 1)
          out.push({
            severity: "warn",
            check: "hook",
            message: `${plan.stage} runs SmartTest ${invocations} times`,
            hint: "Remove the duplicate blocks (`smarttest hook uninstall`) and install once.",
          });
        if (plan.remaining.length)
          out.push({
            severity: "warn",
            check: "hook",
            message: `${plan.stage} still runs ${plan.remaining.length} whole-suite step(s)`,
            hint: "Re-install with `smarttest hook install --replace` to comment them out.",
          });
      }
      if (plans.some((p) => p?.installed) && !history.installedLocally)
        out.push({
          // The installed hook deliberately does not block commits when SmartTest is absent
          // (a teammate's fresh clone), so this is a warning rather than a doctor failure.
          severity: "warn",
          check: "hook",
          message: "a hook is installed but node_modules/.bin/smarttest is missing",
          hint: "The hook cannot run tests until dependencies are installed (or on a teammate's fresh clone).",
        });
      if (history.runs)
        out.push({
          severity: history.medianMs > this.config.hook.budgetMs ? "warn" : "ok",
          check: "hook",
          message: `${history.runs} run(s), median ${Math.round(history.medianMs)} ms, slowest ${Math.round(history.slowestMs)} ms`,
          ...(history.medianMs > this.config.hook.budgetMs
            ? {
                hint: `Above the ${this.config.hook.budgetMs} ms budget: move slow checks to pre-push, or run \`smarttest trace --stale\`.`,
              }
            : {}),
        });
      if (history.scope.length)
        out.push({
          severity: "info",
          check: "hook",
          message: `hook scope: ${history.scope.join(", ")}; selected tests outside it are not run in the hook (left to CI)${history.leftToCi ? ` — ${history.leftToCi} in recent hook runs` : ""}`,
          hint: "`smarttest run` and `smarttest ci` still run them; make sure CI does.",
        });
      else if (plans.some((p) => p?.installed)) {
        const suggested = await this.hookScopeSuggestion();
        if (suggested)
          out.push({
            severity: "info",
            check: "hook",
            message:
              "the hook also runs browser end-to-end specs (Playwright/Cypress) when they are selected",
            hint: `To leave them to CI, set \`hook: { runners: [${suggested.map((a) => `"${a}"`).join(", ")}] }\`; the hook then reports them as left to CI.`,
          });
      }
      if (history.bypasses.length)
        out.push({
          severity: "warn",
          check: "hook",
          message: `${history.bypasses.length} bypass(es) recorded (SMARTTEST_SKIP=1)`,
          hint: "A bypass skips the affected tests; the commit is visible in `smarttest hook status`.",
        });
      if (history.withoutHook.without.length)
        out.push({
          severity: "warn",
          check: "hook",
          message: `${history.withoutHook.without.length} recent commit(s) have no successful hook record`,
          hint: "They were made with --no-verify, before the hook was installed, or the hook failed to run.",
        });
    }
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
    // A reference file that could not run (runner crash, not collected, cancelled) has an unknown
    // outcome: it may hide a failure, so it counts as one, never as a pass (§32.2).
    const notRun = new Set<string>(["infrastructure-error", "cancelled"]);
    const failing = [
      ...full.files,
      ...plan.unassigned.map((file) => ({ file, status: "infrastructure-error" as const })),
    ].filter((f) => f.status === "failed" || f.status === "timed-out" || notRun.has(f.status));
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
          note: notRun.has(f.status)
            ? `could not run in the full reference run (${f.status}) and was not selected: a failure there cannot be ruled out — fix the runner and validate again`
            : "failed in the full run but was not selected (may be a pre-existing failure — compare with a clean checkout)",
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
    const shadowLog = join(this.storeDir, "shadow", "history.jsonl");
    assertConfinedWrite(shadowLog); // appendFile follows a link at the file itself
    await mkdir(join(this.storeDir, "shadow"), { recursive: true });
    await appendFile(shadowLog, `${JSON.stringify(record)}\n`);
    await capShadowLog(shadowLog);
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
    // The index lists the project once and detects the project from that listing.
    const { index, stats } = await this.loadIndex();
    const profile = await this.profile();
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

/** Shadow Mode keeps its most recent records: the log is trimmed once it passes this size. */
export const SHADOW_LOG_MAX_BYTES = 2 * 1024 * 1024;
export const SHADOW_LOG_KEEP_RECORDS = 2_000;

/** Trims the Shadow Mode log to its most recent records once it is too large (atomically). */
export async function capShadowLog(
  path: string,
  maxBytes = SHADOW_LOG_MAX_BYTES,
  keep = SHADOW_LOG_KEEP_RECORDS,
): Promise<void> {
  const { readFile, stat } = await import("node:fs/promises");
  const size = await stat(path).then(
    (s) => s.size,
    () => 0,
  );
  if (size <= maxBytes) return;
  const lines = (await readFile(path, "utf8")).split("\n").filter(Boolean);
  // Never more than half the limit after trimming, so it is not trimmed again on the next run.
  let start = Math.max(0, lines.length - keep);
  let bytes = 0;
  for (let i = lines.length - 1; i >= start; i--) {
    bytes += Buffer.byteLength(lines[i] as string) + 1;
    if (bytes > maxBytes / 2 && i < lines.length - 1) {
      start = i + 1;
      break;
    }
  }
  await writeFileAtomic(path, `${lines.slice(start).join("\n")}\n`);
}

const memoised = new WeakSet<ChangeAnalysisInput["readBefore"]>();

function memoiseReadBefore(input: ChangeAnalysisInput): ChangeAnalysisInput["readBefore"] {
  if (memoised.has(input.readBefore)) return input.readBefore;
  const read = input.readBefore.bind(input);
  const cache = new Map<string, Promise<string | undefined>>();
  const readBefore = (path: string) => {
    let hit = cache.get(path);
    if (!hit) {
      hit = read(path);
      cache.set(path, hit);
      hit.catch(() => cache.delete(path));
    }
    return hit;
  };
  memoised.add(readBefore);
  return readBefore;
}

function stripDetails(decision: ImpactResult): RunReport["decision"] {
  const { details: _details, ...rest } = decision;
  return rest;
}
