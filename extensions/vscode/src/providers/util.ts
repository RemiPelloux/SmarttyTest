import * as vscode from "vscode";
import { isCancelledError } from "../core/errors.js";
import type { DocumentSymbolKind, DocumentSymbolNode, SourceRangeLike } from "../core/symbols.js";

export interface TokenSignal {
  readonly signal: AbortSignal;
  dispose(): void;
}

export function signalFromToken(token: vscode.CancellationToken): TokenSignal {
  const controller = new AbortController();
  if (token.isCancellationRequested) controller.abort();
  const listener = token.onCancellationRequested(() => controller.abort());
  return { signal: controller.signal, dispose: () => listener.dispose() };
}

export function toSourceRange(range: vscode.Range): SourceRangeLike {
  return {
    start: { line: range.start.line, character: range.start.character },
    end: { line: range.end.line, character: range.end.character },
  };
}

export function toVscodeRange(range: SourceRangeLike): vscode.Range {
  return new vscode.Range(
    range.start.line,
    range.start.character,
    range.end.line,
    range.end.character,
  );
}

function kindOf(kind: vscode.SymbolKind): DocumentSymbolKind {
  switch (kind) {
    case vscode.SymbolKind.Module:
      return "module";
    case vscode.SymbolKind.Namespace:
      return "namespace";
    case vscode.SymbolKind.Class:
      return "class";
    case vscode.SymbolKind.Method:
      return "method";
    case vscode.SymbolKind.Property:
      return "property";
    case vscode.SymbolKind.Field:
      return "field";
    case vscode.SymbolKind.Constructor:
      return "constructor";
    case vscode.SymbolKind.Interface:
      return "interface";
    case vscode.SymbolKind.Function:
      return "function";
    case vscode.SymbolKind.Variable:
      return "variable";
    case vscode.SymbolKind.Constant:
      return "constant";
    default:
      return "other";
  }
}

function isDocumentSymbol(value: unknown): value is vscode.DocumentSymbol {
  return (
    typeof value === "object" && value !== null && "range" in value && "selectionRange" in value
  );
}

function isSymbolInformation(value: unknown): value is vscode.SymbolInformation {
  return typeof value === "object" && value !== null && "location" in value;
}

function fromDocumentSymbol(symbol: vscode.DocumentSymbol): DocumentSymbolNode {
  return {
    name: symbol.name,
    kind: kindOf(symbol.kind),
    range: toSourceRange(symbol.range),
    ...(symbol.children.length > 0 ? { children: symbol.children.map(fromDocumentSymbol) } : {}),
  };
}

/**
 * Document symbols are provided by the language server, not by the CLI. If no
 * provider is registered the extension has no ranges, so it makes no claims.
 */
export async function documentSymbols(
  document: vscode.TextDocument,
): Promise<DocumentSymbolNode[]> {
  const result = await vscode.commands.executeCommand<unknown[]>(
    "vscode.executeDocumentSymbolProvider",
    document.uri,
  );
  if (!Array.isArray(result)) return [];
  const nodes: DocumentSymbolNode[] = [];
  for (const entry of result) {
    if (isDocumentSymbol(entry)) {
      nodes.push(fromDocumentSymbol(entry));
    } else if (isSymbolInformation(entry)) {
      nodes.push({
        name: entry.name,
        kind: kindOf(entry.kind),
        range: toSourceRange(entry.location.range),
      });
    }
  }
  return nodes;
}

export function logError(output: vscode.OutputChannel, context: string, error: unknown): void {
  if (isCancelledError(error)) return;
  const message = error instanceof Error ? error.message : String(error);
  output.appendLine(`[${new Date().toISOString()}] ${context}: ${message}`);
  if (error instanceof Error && error.stack) output.appendLine(error.stack);
}
