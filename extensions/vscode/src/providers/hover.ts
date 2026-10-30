import * as vscode from "vscode";
import { hoverMarkdown } from "../core/hover.js";
import { bindingAtPosition, matchUnitsToSymbols } from "../core/symbols.js";
import type { ExtensionState } from "../state.js";
import { documentSymbols, logError, signalFromToken, toVscodeRange } from "./util.js";

export class SmartTestHoverProvider implements vscode.HoverProvider {
  readonly #state: ExtensionState;

  constructor(state: ExtensionState) {
    this.#state = state;
  }

  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.Hover | undefined> {
    if (!this.#state.trusted) return undefined;
    const folder = this.#state.folderFor(document.uri);
    if (!folder) return undefined;
    if (!this.#state.settingsFor(folder).hoverEnabled) return undefined;
    if (document.uri.scheme !== "file" || document.uri.fsPath.endsWith(".d.ts")) return undefined;

    const { signal, dispose } = signalFromToken(token);
    try {
      const symbols = await documentSymbols(document);
      if (symbols.length === 0) return undefined;
      const analysis = await this.#state.analyzeDocument(document, signal);
      if (!analysis || analysis.truncated) return undefined;
      const bindings = matchUnitsToSymbols(analysis.units, symbols);
      const binding = bindingAtPosition(bindings, position.line, position.character);
      if (!binding) return undefined;
      const protection = analysis.protections.find((p) => p.unitId === binding.unit.id);
      if (!protection) return undefined;
      return new vscode.Hover(
        new vscode.MarkdownString(hoverMarkdown(protection)),
        toVscodeRange(binding.range),
      );
    } catch (error) {
      logError(this.#state.output, "hover", error);
      return undefined;
    } finally {
      dispose();
    }
  }
}
