import * as vscode from "vscode";
import { registerCommands } from "./commands.js";
import { isCancelledError } from "./core/errors.js";
import { KeyedScheduler, LatestTask } from "./core/scheduler.js";
import { SmartTestCodeLensProvider } from "./providers/code-lens.js";
import { SmartTestHoverProvider } from "./providers/hover.js";
import { logError } from "./providers/util.js";
import { SmartTestResultsProvider } from "./results-view.js";
import { ExtensionState } from "./state.js";
import { SmartTestStatusBar } from "./status.js";

let output: vscode.OutputChannel | undefined;
let state: ExtensionState | undefined;
let status: SmartTestStatusBar | undefined;
let codeLens: SmartTestCodeLensProvider | undefined;
let results: SmartTestResultsProvider | undefined;
let saveScheduler: KeyedScheduler | undefined;
let activeTask: LatestTask | undefined;
let commands: vscode.Disposable | undefined;

/** Sources, configs and manifests that can change the scan or the graph. */
const WATCH_GLOB = "**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs,json}";
/**
 * Dependency, state, build-output and test-report folders: a watch build writing there would
 * otherwise rebuild the snapshot on every emit, and a run's own reports would mark that run out
 * of date as soon as it finished. Saves in the editor always refresh, wherever the file is.
 */
const IGNORED_PATH =
  /\/(node_modules|\.git|\.smarttest|coverage|dist|build|out|\.next|\.turbo|\.cache|test-results|playwright-report|\.nyc_output)\//;

const SELECTOR: vscode.DocumentSelector = [
  { language: "typescript", scheme: "file" },
  { language: "javascript", scheme: "file" },
  { language: "typescriptreact", scheme: "file" },
  { language: "javascriptreact", scheme: "file" },
];

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel("SmartTest");
  state = new ExtensionState(output);
  status = new SmartTestStatusBar(state);
  results = new SmartTestResultsProvider();
  codeLens = new SmartTestCodeLensProvider(state, (uri, analysis) =>
    status?.setAnalysis(uri, analysis),
  );

  const treeView = vscode.window.createTreeView("smarttest.results", {
    treeDataProvider: results,
    showCollapseAll: true,
  });
  context.subscriptions.push(output, state, status, results, codeLens, treeView);

  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(SELECTOR, codeLens),
    vscode.languages.registerHoverProvider(SELECTOR, new SmartTestHoverProvider(state)),
  );

  commands = registerCommands(context, { state, status, results, codeLens });

  // Saves and out-of-editor file changes both land here; invalidation and the
  // CodeLens refresh happen once per debounced burst, not once per event.
  saveScheduler = new KeyedScheduler({
    delayMs: (key) => {
      const folder = folderByKey(key);
      return folder ? (state?.settingsFor(folder).refreshDelayMs ?? 350) : 350;
    },
    run: async (key, signal) => {
      const folder = folderByKey(key);
      if (!folder || !state) return;
      state.invalidateFolder(folder);
      // The last run's verdict described the code before this change.
      status?.invalidateRun(key);
      results?.markStale(folder.uri.fsPath);
      const document = vscode.window.activeTextEditor?.document;
      const inFolder = !!document && state.folderFor(document.uri)?.uri.toString() === key;
      if (document && inFolder) status?.clearAnalysis(document.uri);
      codeLens?.refresh();
      if (!state.trusted) return;
      if (document && inFolder) {
        const analysis = await state.analyzeDocument(document, signal);
        if (analysis) status?.setAnalysis(document.uri, analysis);
      }
    },
    onError: (key, error) => {
      if (isCancelledError(error) || !output || !status) return;
      logError(output, `refresh ${key}`, error);
      status.setError(error instanceof Error ? error.message : String(error));
    },
  });

  activeTask = new LatestTask({
    delayMs: 200,
    run: async (signal) => {
      if (!state?.trusted) return;
      const document = vscode.window.activeTextEditor?.document;
      if (!document) {
        status?.clearAnalysis();
        return;
      }
      if (document.uri.scheme !== "file") return;
      const folder = state.folderFor(document.uri);
      if (!folder) {
        status?.clearAnalysis();
        return;
      }
      const ticket = status?.beginAnalysing(document.uri);
      try {
        const analysis = await state.analyzeDocument(document, signal);
        if (analysis) status?.setAnalysis(document.uri, analysis);
      } finally {
        // Only this request's spinner: a newer one may already have started.
        if (ticket !== undefined) status?.endAnalysing(ticket);
      }
    },
    onError: (error) => {
      if (isCancelledError(error) || !output || !status) return;
      logError(output, "active editor", error);
      status.setError(error instanceof Error ? error.message : String(error));
    },
  });

  // Files changed outside the editor (git checkout, codegen, another tool)
  // invalidate the snapshot the same way a save does.
  const watcher = vscode.workspace.createFileSystemWatcher(WATCH_GLOB);
  const scheduleRefresh = (uri: vscode.Uri, saved = false): void => {
    if (!state || !saveScheduler || uri.scheme !== "file") return;
    if (!saved && IGNORED_PATH.test(uri.path)) return;
    const folder = state.folderFor(uri);
    if (!folder) return;
    saveScheduler.trigger(folder.uri.toString());
  };

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      status?.clearAnalysis();
      status?.setError(undefined);
      status?.render();
      if (!editor) return;
      activeTask?.trigger();
    }),
    vscode.workspace.onDidSaveTextDocument((document) => scheduleRefresh(document.uri, true)),
    watcher,
    watcher.onDidCreate((uri) => scheduleRefresh(uri)),
    watcher.onDidChange((uri) => scheduleRefresh(uri)),
    watcher.onDidDelete((uri) => scheduleRefresh(uri)),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration("smarttest")) return;
      codeLens?.refresh();
      status?.render();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      codeLens?.refresh();
      status?.render();
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => {
      codeLens?.refresh();
      status?.render();
      activeTask?.trigger();
    }),
  );

  status.render();
  activeTask.trigger();
  output.appendLine(
    `SmartTest extension ${context.extension.packageJSON.version as string} activated; executable is resolved per workspace folder.`,
  );
}

function folderByKey(key: string): vscode.WorkspaceFolder | undefined {
  return vscode.workspace.workspaceFolders?.find((candidate) => candidate.uri.toString() === key);
}

/** Stops every SmartTest process: pending refreshes, analyses and a run in flight. */
export function deactivate(): void {
  saveScheduler?.dispose();
  activeTask?.dispose();
  commands?.dispose();
  state?.dispose();
  saveScheduler = undefined;
  activeTask = undefined;
  commands = undefined;
  codeLens = undefined;
  results = undefined;
  status = undefined;
  state = undefined;
  output = undefined;
}
