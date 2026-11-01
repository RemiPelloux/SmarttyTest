/**
 * @smarttest/source-parser — language-neutral analysis model shared by language adapters.
 */
import type { FileAnalysis, SourceRange, SymbolRecord } from "@smarttest/shared";

export type {
  Analyzer,
  FileAnalysis,
  ImportBinding,
  ImportKind,
  ImportRecord,
  ModuleResolver,
  ResolveResult,
  SymbolRecord,
} from "@smarttest/shared";

/** Top-level units are the granularity of propagation (a class, function, variable…). */
export function topLevelSymbols(analysis: FileAnalysis): SymbolRecord[] {
  return analysis.symbols.filter((s) => !s.parent);
}

/**
 * Unit a changed symbol propagates from. Methods and accessors are their own units ("C.m");
 * constructors and properties change every instance, so they make the whole class the unit.
 */
export function unitOf(symbol: SymbolRecord): string {
  if (!symbol.parent) return symbol.qualifiedName;
  return symbol.kind === "method" && symbol.name !== "constructor"
    ? `${symbol.parent}.${symbol.name}`
    : symbol.parent;
}

/** Every file-level name a symbol mentions: references, member-use owners and escapes. */
export function namesUsedBy(symbol: SymbolRecord): string[] {
  return [
    ...new Set([
      ...symbol.refs,
      ...(symbol.escapes ?? []),
      ...(symbol.uses ?? []).map((u) => u.slice(0, u.indexOf("."))),
    ]),
  ];
}

export function rangesOverlap(a: SourceRange, b: SourceRange): boolean {
  return a.start.line <= b.end.line && b.start.line <= a.end.line;
}

export const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/;

/** Files treated as translation catalogs when they only hold data. */
export const LOCALE_PATH = /(^|\/)(locales?|i18n|lang|langs|translations|messages)\//;
