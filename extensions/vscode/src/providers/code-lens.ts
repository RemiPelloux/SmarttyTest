import * as vscode from "vscode";
import type { FileAnalysis } from "../core/analysis.js";
import { lensTitle, type Protection } from "../core/protection.js";
import { matchUnitsToSymbols } from "../core/symbols.js";
import type { ExtensionState } from "../state.js";
import { documentSymbols, logError, signalFromToken } from "./util.js";

export class SmartTestCodeLensProvider implements vscode.CodeLensProvider {
  readonly #state: ExtensionState;
  readonly #onDidChange = new vscode.EventEmitter<void>();

  readonly onDidChangeCodeLenses = this.#onDidChange.event;

  readonly #onAnalysis: ((uri: vscode.Uri, analysis: FileAnalysis) => void) | undefined;

  constructor(
    state: ExtensionState,
    onAnalysis?: (uri: vscode.Uri, analysis: FileAnalysis) => void,
  ) {
    this.#state = state;
    this.#onAnalysis = onAnalysis;
  }

  refresh(): void {
    this.#onDidChange.fire();
  }

  dispose(): void {
    this.#onDidChange.dispose();
  }

  async provideCodeLenses(
    document: vscode.TextDocument,
    token: vscode.CancellationToken,
  ): Promise<vscode.CodeLens[]> {
    if (!this.#state.trusted) return [];
    const folder = this.#state.folderFor(document.uri);
    if (!folder) return [];
    if (!this.#state.settingsFor(folder).codeLensEnabled) return [];
    if (
      document.uri.scheme !== "file" ||
      document.uri.fsPath.endsWith(".d.ts") ||
      document.isUntitled
    )
      return [];

    const { signal, dispose } = signalFromToken(token);
    try {
      const symbols = await documentSymbols(document);
      if (symbols.length === 0) return [];
      const analysis = await this.#state.analyzeDocument(document, signal);
      if (!analysis) return [];
      this.#onAnalysis?.(document.uri, analysis);

      if (analysis.truncated) {
        const count = analysis.units.length;
        return [
          new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), {
            title: `SmartTest: ${count} symbols exceed maxUnitsPerFile — protection hidden`,
            command: "smarttest.showImpact",
            arguments: [document.uri],
            tooltip:
              "SmartTest does not show a partial protection verdict. Raise smarttest.maxUnitsPerFile to analyse this file.",
          }),
        ];
      }

      const protections = new Map(analysis.protections.map((p) => [p.unitId, p]));
      const bindings = matchUnitsToSymbols(
        analysis.units.filter((unit) => unit.kind !== "class"),
        symbols,
      );
      const lenses: vscode.CodeLens[] = [];
      for (const binding of bindings) {
        const protection = protections.get(binding.unit.id);
        if (!protection) continue;
        lenses.push(
          new vscode.CodeLens(
            new vscode.Range(
              binding.range.start.line,
              binding.range.start.character,
              binding.range.start.line,
              binding.range.start.character,
            ),
            {
              title: lensTitle(protection),
              tooltip: protection.reason,
              command: "smarttest.showImpact",
              arguments: [document.uri, binding.unit.id],
            },
          ),
        );
      }
      return lenses;
    } catch (error) {
      logError(this.#state.output, "codeLens", error);
      return [];
    } finally {
      dispose();
    }
  }
}

export function protectionFor(
  analysis: FileAnalysis | undefined,
  unitId: string,
): Protection | undefined {
  return analysis?.protections.find((p) => p.unitId === unitId);
}
