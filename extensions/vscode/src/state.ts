/**
 * Extension-host state: settings, executable, cached graph/scan snapshots and
 * per-document analyses. Everything is scoped to a workspace folder, which is
 * what makes multi-root workspaces behave independently.
 */
import * as vscode from "vscode";
import { explainArgs, explainTarget, graphArgs, scanArgs } from "./cli/commands.js";
import { resolveExecutable } from "./cli/executable.js";
import { type CliResult, runCli } from "./cli/runner.js";
import { analyzeFile, type FileAnalysis } from "./core/analysis.js";
import type { GraphDump, ScanResult, SourceExplain } from "./core/contracts.js";
import { parseExplainJson, parseGraphDump, parseScanJson } from "./core/contracts.js";
import { errorMessage, isCancelledError, SmartTestExtensionError } from "./core/errors.js";
import { toProjectPath } from "./core/paths.js";
import { type ExtensionSettings, readSettings } from "./core/settings.js";

interface ProjectSnapshot {
  readonly graph: GraphDump;
  readonly scan: ScanResult;
  readonly executable: string;
  readonly loadedAt: number;
  readonly generation: number;
}

interface CachedAnalysis {
  readonly version: number;
  readonly generation: number;
  readonly analysis: FileAnalysis;
}

interface FolderState {
  readonly folder: vscode.WorkspaceFolder;
  snapshot: ProjectSnapshot | undefined;
  loading: Promise<ProjectSnapshot> | undefined;
  loadingController: AbortController | undefined;
  generation: number;
  readonly analyses: Map<string, CachedAnalysis>;
}

const SNAPSHOT_TTL_MS = 10_000;

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
    const resolution = resolveExecutable({
      configuredPath: settings.executablePath,
      workspaceDir: folder.uri.fsPath,
    });
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
    const now = Date.now();
    if (state.snapshot && now - state.snapshot.loadedAt < SNAPSHOT_TTL_MS) return state.snapshot;
    if (state.loading) return await state.loading;

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
      const snapshot: ProjectSnapshot = {
        graph: parseGraphDump(graphResult.stdout),
        scan: parseScanJson(scanResult.stdout),
        executable: resolved.executable,
        loadedAt: Date.now(),
        generation: state.generation,
      };
      state.snapshot = snapshot;
      state.analyses.clear();
      return snapshot;
    } catch (error) {
      controller.abort();
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
    if (
      cached &&
      cached.version === document.version &&
      state.snapshot &&
      cached.generation === state.snapshot.generation
    )
      return cached.analysis;

    const snapshot = await this.snapshot(folder, signal);
    const resolved = this.resolveFolder(folder);
    const analysis = await analyzeFile({
      file: projectPath,
      graph: snapshot.graph,
      scan: snapshot.scan,
      maxUnits: resolved.settings.maxUnitsPerFile,
      concurrency: resolved.settings.maxConcurrentExplain,
      signal,
      explain: async (unit, explainSignal) => {
        const result = await runCli({
          executable: snapshot.executable,
          args: explainArgs(explainTarget(projectPath, unit.qualifiedName)),
          cwd: folder.uri.fsPath,
          signal: explainSignal,
          timeoutMs: resolved.settings.analysisTimeoutMs,
        });
        return parseExplainJson(result.stdout);
      },
    });
    state.analyses.set(projectPath, {
      version: document.version,
      generation: snapshot.generation,
      analysis,
    });
    return analysis;
  }

  invalidateFolder(folder: vscode.WorkspaceFolder): void {
    const state = this.#folderState(folder);
    state.loadingController?.abort();
    state.loadingController = undefined;
    state.snapshot = undefined;
    state.loading = undefined;
    state.analyses.clear();
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
