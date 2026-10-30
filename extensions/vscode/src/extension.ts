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

  registerCommands(context, { state, status, results, codeLens });

  saveScheduler = new KeyedScheduler({
    delayMs: () => {
      const folder = activeFolder();
      return folder ? (state?.settingsFor(folder).refreshDelayMs ?? 350) : 350;
    },
    run: async (key, signal) => {
      if (!state?.trusted) return;
      const folder = vscode.workspace.workspaceFolders?.find(
        (candidate) => candidate.uri.toString() === key,
      );
      if (!folder) return;
      const document = vscode.window.activeTextEditor?.document;
      if (document && state.folderFor(document.uri)?.uri.toString() === key) {
        const analysis = await state.analyzeDocument(document, signal);
        if (analysis) status?.setAnalysis(document.uri, analysis);
      }
      codeLens?.refresh();
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
      const analysis = await state.analyzeDocument(document, signal);
      if (analysis) status?.setAnalysis(document.uri, analysis);
    },
    onError: (error) => {
      if (isCancelledError(error) || !output || !status) return;
      logError(output, "active editor", error);
      status.setError(error instanceof Error ? error.message : String(error));
    },
  });

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      status?.clearAnalysis();
      status?.setError(undefined);
      status?.render();
      if (!editor) return;
      activeTask?.trigger();
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (!state || !saveScheduler) return;
      const folder = state.folderFor(document.uri);
      if (!folder) return;
      state.invalidateDocument(document);
      state.invalidateFolder(folder);
      status?.clearAnalysis(document.uri);
      saveScheduler.trigger(folder.uri.toString());
      codeLens?.refresh();
    }),
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

function activeFolder(): vscode.WorkspaceFolder | undefined {
  const document = vscode.window.activeTextEditor?.document;
  if (!document) return undefined;
  return state?.folderFor(document.uri);
}

export function deactivate(): void {
  saveScheduler?.dispose();
  activeTask?.dispose();
  saveScheduler = undefined;
  activeTask = undefined;
  codeLens = undefined;
  results = undefined;
  status = undefined;
  state = undefined;
  output = undefined;
}
