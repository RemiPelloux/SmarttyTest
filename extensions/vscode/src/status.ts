import * as vscode from "vscode";
import type { FileAnalysis } from "./core/analysis.js";
import type { RunReport } from "./core/contracts.js";
import { summarizeFile } from "./core/protection.js";
import { statusBarRunText } from "./core/results.js";
import type { ExtensionState } from "./state.js";

/** One item; it always describes the active editor's workspace folder. */
export class SmartTestStatusBar implements vscode.Disposable {
  readonly #item: vscode.StatusBarItem;
  readonly #state: ExtensionState;
  #last: { readonly uri: string; readonly analysis: FileAnalysis } | undefined;
  #error: string | undefined;
  #busy: string | undefined;
  #run: RunReport | undefined;
  #runFolderKey: string | undefined;
  /** The active file whose analysis is in progress (first open, or after a save). */
  #analysing: string | undefined;

  constructor(state: ExtensionState) {
    this.#state = state;
    this.#item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
    this.#item.name = "SmartTest";
    this.#item.command = "smarttest.showImpact";
  }

  setBusy(label: string | undefined): void {
    this.#busy = label;
    this.render();
  }

  setError(message: string | undefined): void {
    this.#error = message;
    this.render();
  }

  setRun(report: RunReport | undefined, folderKey?: string): void {
    this.#run = report;
    this.#runFolderKey = report ? folderKey : undefined;
    this.render();
  }

  setAnalysis(uri: vscode.Uri, analysis: FileAnalysis): void {
    if (vscode.window.activeTextEditor?.document.uri.toString() !== uri.toString()) return;
    this.#last = { uri: uri.toString(), analysis };
    this.#error = undefined;
    this.render();
  }

  setAnalysing(uri: vscode.Uri | undefined): void {
    this.#analysing = uri?.toString();
    this.render();
  }

  clearAnalysis(uri?: vscode.Uri): void {
    if (uri && this.#last?.uri !== uri.toString()) return;
    this.#last = undefined;
    this.render();
  }

  render(): void {
    if (!this.#state.trusted) {
      this.#item.text = "$(lock) SmartTest: Restricted Mode";
      this.#item.tooltip =
        "SmartTest is disabled in Restricted Mode. Trust the workspace to enable it.";
      this.#item.backgroundColor = undefined;
      this.#item.command = "smarttest.showRestrictedMode";
      this.#item.show();
      return;
    }
    const folder = this.#activeFolder();
    if (!folder || !this.#state.settingsFor(folder).statusBarEnabled) {
      this.#item.hide();
      return;
    }
    this.#item.command = "smarttest.showImpact";
    this.#item.backgroundColor = undefined;

    if (this.#busy) {
      this.#item.text = `$(sync~spin) SmartTest: ${this.#busy}`;
      this.#item.tooltip = "SmartTest is working. Click to show the current impact.";
      this.#item.show();
      return;
    }
    if (this.#error) {
      this.#item.text = "$(warning) SmartTest: analysis failed";
      this.#item.tooltip = `${this.#error}\n\nClick to open the SmartTest output.`;
      this.#item.command = "smarttest.openOutput";
      this.#item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
      this.#item.show();
      return;
    }
    if (this.#run && this.#runFolderKey === folder.uri.toString()) {
      this.#item.text = `$(shield) ${statusBarRunText(this.#run)}`;
      this.#item.tooltip =
        "Last affected-test run. Cached and skipped tests are not counted as passed. Click for the current impact.";
      this.#item.show();
      return;
    }
    const analysis = this.#last?.analysis;
    const active = vscode.window.activeTextEditor?.document.uri.toString();
    if (!analysis && this.#analysing && this.#analysing === active) {
      this.#item.text = "$(sync~spin) SmartTest: analysing this file";
      this.#item.tooltip = "SmartTest is finding the tests that reach this file's symbols.";
      this.#item.show();
      return;
    }
    if (!analysis) {
      this.#item.text = "$(shield) SmartTest";
      this.#item.tooltip =
        "SmartTest is ready. Open a TypeScript or JavaScript file to see its tests.";
      this.#item.show();
      return;
    }
    const summary = summarizeFile(analysis.protections);
    const parts: string[] = [];
    if (summary.protectedUnits > 0) parts.push(`${summary.protectedUnits} protected`);
    if (summary.unknownUnits > 0) parts.push(`${summary.unknownUnits} uncertain`);
    if (summary.unprotectedUnits > 0) parts.push(`${summary.unprotectedUnits} without a test path`);
    this.#item.text = `$(shield) SmartTest: ${parts.length > 0 ? parts.join(" · ") : "no symbols"}`;
    const problems = this.#state.settingProblems(folder);
    this.#item.tooltip = [
      `${summary.testFiles} distinct test file(s) reach this file.`,
      analysis.truncated
        ? "Analysis was hidden because the file exceeds smarttest.maxUnitsPerFile."
        : "",
      ...problems,
      "Cached results are never reported as passed. Click for details.",
    ]
      .filter(Boolean)
      .join("\n");
    this.#item.show();
  }

  #activeFolder(): vscode.WorkspaceFolder | undefined {
    const document = vscode.window.activeTextEditor?.document;
    if (!document) return undefined;
    return this.#state.folderFor(document.uri);
  }

  dispose(): void {
    this.#item.dispose();
  }
}
