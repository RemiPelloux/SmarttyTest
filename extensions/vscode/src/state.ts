/**
 * Extension-host state: settings, executable, cached graph/scan snapshots and
 * per-document analyses. Everything is scoped to a workspace folder, which is
 * what makes multi-root workspaces behave independently.
 */
import * as vscode from "vscode";
import {
  explainArgs,
  explainTarget,
  explainUnitsArgs,
  graphArgs,
  scanArgs,
} from "./cli/commands.js";
import { type ExecutableResolution, resolveExecutable } from "./cli/executable.js";
import { type CliResult, runCli } from "./cli/runner.js";
import { analyzeFile, buildFileIndex, type FileAnalysis, type FileIndex } from "./core/analysis.js";
import type { GraphDump, ScanResult, SourceExplain } from "./core/contracts.js";
import { parseExplainJson, parseGraphDump, parseScanJson } from "./core/contracts.js";
import { errorMessage, isCancelledError, SmartTestExtensionError } from "./core/errors.js";
import { toProjectPath } from "./core/paths.js";
import { ConcurrencyLimiter, SharedTasks } from "./core/scheduler.js";
import { type ExtensionSettings, readSettings } from "./core/settings.js";
import type { GraphUnit } from "./core/symbols.js";

interface ProjectSnapshot {
  readonly graph: GraphDump;
  readonly scan: ScanResult;
  readonly index: FileIndex;
  readonly executable: string;
  readonly generation: number;
}

/**
 * Analyses depend only on the on-disk graph and scan (the snapshot), not on the
 * editor buffer, so they are keyed on (project path, snapshot generation):
 * typing does not re-run them, saving invalidates the snapshot and so them.
 */
interface CachedAnalysis {
  readonly generation: number;
  readonly analysis: FileAnalysis;
}

interface CachedExecutable {
  readonly configuredPath: string;
  readonly resolution: ExecutableResolution;
}

interface FolderState {
  readonly folder: vscode.WorkspaceFolder;
  snapshot: ProjectSnapshot | undefined;
  loading: Promise<ProjectSnapshot> | undefined;
  loadingController: AbortController | undefined;
  generation: number;
  readonly analyses: Map<string, CachedAnalysis>;
  /** In-flight analyses keyed by `${generation}:${projectPath}`. */
  readonly inflight: SharedTasks<FileAnalysis>;
  /** One explain bound for the whole folder, shared by every analysis. */
  readonly explainLimit: ConcurrencyLimiter;
  executable: CachedExecutable | undefined;
  /** The CLI rejected `explain --units` (older than 0.9.0): explain one unit per call. */
  noBatchExplain: boolean;
}

export interface ResolvedFolder {
  readonly folder: vscode.WorkspaceFolder;
  readonly settings: ExtensionSettings;
  readonly executable: string;
}

export class ExtensionState implements vscode.Disposable {
  readonly #output: vscode.OutputChannel;
  readonly #folders = new Map<string, FolderState>();
  readonly #disposables: vscode.Disposable[] = [];
  #trusted: boolean;

  constructor(output: vscode.OutputChannel) {
    this.#output = output;
    this.#trusted = vscode.workspace.isTrusted;
    this.#disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.#pruneFolders()),
      vscode.workspace.onDidGrantWorkspaceTrust(() => {
        this.#trusted = true;
        this.invalidateAll();
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("smarttest")) this.invalidateAll();
      }),
    );
  }

  get trusted(): boolean {
    return this.#trusted;
  }

  get output(): vscode.OutputChannel {
    return this.#output;
  }

  folderFor(uri: vscode.Uri): vscode.WorkspaceFolder | undefined {
    return vscode.workspace.getWorkspaceFolder(uri);
  }

  settingsFor(folder: vscode.WorkspaceFolder): ExtensionSettings {
    const config = vscode.workspace.getConfiguration("smarttest", folder.uri);
    return readSettings((key) => config.get(key)).settings;
  }

  /** Settings problems are reported through the output channel and the status bar. */
  settingProblems(folder: vscode.WorkspaceFolder): readonly string[] {
    const config = vscode.workspace.getConfiguration("smarttest", folder.uri);
    return readSettings((key) => config.get(key)).problems;
  }

  resolveFolder(folder: vscode.WorkspaceFolder): ResolvedFolder {
    const settings = this.settingsFor(folder);
    const state = this.#folderState(folder);
    // Resolution stats the filesystem; it is cached until settings, trust or
    // a manual refresh invalidate it. A failed lookup is never cached.
    const cached =
      state.executable?.configuredPath === settings.executablePath
        ? state.executable.resolution
        : undefined;
    const resolution =
      cached ??
      resolveExecutable({
        configuredPath: settings.executablePath,
        workspaceDir: folder.uri.fsPath,
      });
    state.executable = resolution
      ? { configuredPath: settings.executablePath, resolution }
      : undefined;
    if (!resolution)
      throw new SmartTestExtensionError(
        settings.executablePath
          ? `smarttest was not found at \`${settings.executablePath}\`.`
          : "smarttest was not found in this workspace or on PATH.",
        {
          code: "ST_EXT_EXECUTABLE_NOT_FOUND",
          category: "configuration",
          hint: "Install smarttest in the workspace (npx smarttest init) or set `smarttest.executablePath`.",
        },
      );
    return { folder, settings, executable: resolution.executable };
  }

  async snapshot(folder: vscode.WorkspaceFolder, signal: AbortSignal): Promise<ProjectSnapshot> {
    const state = this.#folderState(folder);
    // No TTL: saves and the file-system watcher invalidate the snapshot.
    if (state.snapshot) return state.snapshot;
    if (state.loading) return await abortable(state.loading, signal);

    const loading = this.#loadSnapshot(folder, state).finally(() => {
      if (state.loading === loading) state.loading = undefined;
    });
    state.loading = loading;
    // The promise is shared, but the caller's cancellation still stops waiting.
    return await abortable(loading, signal);
  }

  async #loadSnapshot(
    folder: vscode.WorkspaceFolder,
    state: FolderState,
  ): Promise<ProjectSnapshot> {
    const resolved = this.resolveFolder(folder);
    const controller = new AbortController();
    state.loadingController = controller;
    try {
      const [scanResult, graphResult] = await Promise.all([
        runCli({
          executable: resolved.executable,
          args: scanArgs(),
          cwd: folder.uri.fsPath,
          signal: controller.signal,
          timeoutMs: resolved.settings.analysisTimeoutMs,
        }),
        runCli({
          executable: resolved.executable,
          args: graphArgs(),
          cwd: folder.uri.fsPath,
          signal: controller.signal,
          timeoutMs: resolved.settings.analysisTimeoutMs,
        }),
      ]);
      this.#logCli("scan", scanResult);
      this.#logCli("graph", graphResult);
      state.generation += 1;
      const graph = parseGraphDump(graphResult.stdout);
      const scan = parseScanJson(scanResult.stdout);
      const snapshot: ProjectSnapshot = {
        graph,
        scan,
        index: buildFileIndex(graph, scan),
        executable: resolved.executable,
        generation: state.generation,
      };
      state.snapshot = snapshot;
      state.analyses.clear();
      return snapshot;
    } catch (error) {
      controller.abort();
      state.executable = undefined;
      throw error;
    } finally {
      if (state.loadingController === controller) state.loadingController = undefined;
    }
  }

  async analyzeDocument(
    document: vscode.TextDocument,
    signal: AbortSignal,
  ): Promise<FileAnalysis | undefined> {
    if (!this.#trusted) return undefined;
    if (document.uri.scheme !== "file") return undefined;
    const folder = this.folderFor(document.uri);
    if (!folder) return undefined;
    const projectPath = toProjectPath(folder.uri.fsPath, document.uri.fsPath);
    if (!projectPath) return undefined;

    const state = this.#folderState(folder);
    const cached = state.analyses.get(projectPath);
    if (cached && state.snapshot && cached.generation === state.snapshot.generation)
      return cached.analysis;

    const snapshot = await this.snapshot(folder, signal);
    const settled = state.analyses.get(projectPath);
    if (settled && settled.generation === snapshot.generation) return settled.analysis;
    // CodeLens, hover and the active-editor task often ask for the same file at
    // once; they share one analysis, aborted only when all of them cancel.
    return await state.inflight.run(`${snapshot.generation}:${projectPath}`, signal, (shared) =>
      this.#analyze(folder, state, snapshot, projectPath, shared),
    );
  }

  async #analyze(
    folder: vscode.WorkspaceFolder,
    state: FolderState,
    snapshot: ProjectSnapshot,
    projectPath: string,
    signal: AbortSignal,
  ): Promise<FileAnalysis> {
    const resolved = this.resolveFolder(folder);
    state.explainLimit.setLimit(resolved.settings.maxConcurrentExplain);
    const analysis = await analyzeFile({
      file: projectPath,
      graph: snapshot.graph,
      scan: snapshot.scan,
      index: snapshot.index,
      maxUnits: resolved.settings.maxUnitsPerFile,
      // The folder-wide limiter is the real bound; mapLimit only feeds it.
      concurrency: Number.MAX_SAFE_INTEGER,
      signal,
      ...(state.noBatchExplain
        ? {}
        : {
            explainUnits: (units: readonly GraphUnit[], explainSignal: AbortSignal) =>
              state.explainLimit.run(async () => {
                try {
                  const result = await runCli({
                    executable: snapshot.executable,
                    args: explainUnitsArgs(
                      projectPath,
                      units.map((u) => u.qualifiedName),
                    ),
                    cwd: folder.uri.fsPath,
                    signal: explainSignal,
                    timeoutMs: resolved.settings.analysisTimeoutMs,
                  });
                  return parseExplainJson(result.stdout);
                } catch (error) {
                  if (error instanceof SmartTestExtensionError && error.cliCode === "ST_USAGE")
                    state.noBatchExplain = true;
                  throw error;
                }
              }, explainSignal),
          }),
      explain: (unit, explainSignal) =>
        state.explainLimit.run(async () => {
          const result = await runCli({
            executable: snapshot.executable,
            args: explainArgs(explainTarget(projectPath, unit.qualifiedName)),
            cwd: folder.uri.fsPath,
            signal: explainSignal,
            timeoutMs: resolved.settings.analysisTimeoutMs,
          });
          return parseExplainJson(result.stdout);
        }, explainSignal),
    });
    // A newer snapshot may have replaced this one while explain calls ran.
    if (state.snapshot?.generation === snapshot.generation)
      state.analyses.set(projectPath, { generation: snapshot.generation, analysis });
    return analysis;
  }

  invalidateFolder(folder: vscode.WorkspaceFolder): void {
    const state = this.#folderState(folder);
    state.loadingController?.abort();
    state.loadingController = undefined;
    state.snapshot = undefined;
    state.loading = undefined;
    state.analyses.clear();
    state.inflight.clear();
    state.generation += 1;
  }

  invalidateDocument(document: vscode.TextDocument): void {
    if (document.uri.scheme !== "file") return;
    const folder = this.folderFor(document.uri);
    if (!folder) return;
    const projectPath = toProjectPath(folder.uri.fsPath, document.uri.fsPath);
    if (!projectPath) return;
    this.#folderState(folder).analyses.delete(projectPath);
  }

  invalidateAll(): void {
    for (const state of this.#folders.values()) {
      state.loadingController?.abort();
      state.loadingController = undefined;
      state.snapshot = undefined;
      state.loading = undefined;
      state.analyses.clear();
      state.inflight.clear();
      state.executable = undefined;
      state.noBatchExplain = false;
      state.generation += 1;
    }
  }

  #folderState(folder: vscode.WorkspaceFolder): FolderState {
    let state = this.#folders.get(folder.uri.toString());
    if (!state) {
      state = {
        folder,
        snapshot: undefined,
        loading: undefined,
        loadingController: undefined,
        generation: 0,
        analyses: new Map(),
        inflight: new SharedTasks<FileAnalysis>(),
        explainLimit: new ConcurrencyLimiter(this.settingsFor(folder).maxConcurrentExplain),
        executable: undefined,
        noBatchExplain: false,
      };
      this.#folders.set(folder.uri.toString(), state);
    }
    return state;
  }

  #pruneFolders(): void {
    const live = new Set(vscode.workspace.workspaceFolders?.map((f) => f.uri.toString()) ?? []);
    for (const key of this.#folders.keys()) if (!live.has(key)) this.#folders.delete(key);
  }

  #logCli(command: string, result: CliResult): void {
    if (result.stderr.trim())
      this.#output.appendLine(`[${command}] stderr: ${result.stderr.trim()}`);
  }

  dispose(): void {
    for (const disposable of this.#disposables) disposable.dispose();
    this.#folders.clear();
  }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export function describeError(error: unknown): { message: string; hint?: string } {
  if (error instanceof SmartTestExtensionError)
    return {
      message: error.message,
      ...(error.hint === undefined ? {} : { hint: error.hint }),
    };
  return { message: errorMessage(error) };
}

export function isAbort(error: unknown): boolean {
  return isCancelledError(error);
}

export type { SourceExplain };
