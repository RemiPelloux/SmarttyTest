/**
 * @smarttest/source-parser — language-neutral analysis model shared by language adapters.
 */
import type { SourceRange, SymbolKind } from "@smarttest/shared";

export type ImportKind =
  | "named"
  | "namespace"
  | "side-effect"
  | "require"
  | "dynamic"
  | "mock"
  | "reexport"
  | "reexport-all";

export interface ImportBinding {
  /** Exported name in the target module ("default", "*" for namespaces). */
  imported: string;
  /** Local name in the importing module (for re-exports: the exported alias). */
  local: string;
}

export interface ImportRecord {
  specifier: string;
  kind: ImportKind;
  bindings: ImportBinding[];
  typeOnly: boolean;
  line: number;
  /** Project-relative POSIX path when the import resolves inside the project. */
  resolved?: string;
  /** True when the import targets a package / builtin outside the project. */
  external?: boolean;
  /** Present when resolution failed for an import that should be internal. */
  unresolved?: string;
  /** The resolved target used to exist but was deleted. */
  missing?: boolean;
}

export interface SymbolRecord {
  /** `<file>#<qualifiedName>` */
  id: string;
  name: string;
  qualifiedName: string;
  kind: SymbolKind;
  /** Names under which the symbol is exported directly ("default" for default exports). */
  exportNames: string[];
  parent?: string;
  range: SourceRange;
  signature: string;
  tokenHash: string;
  textHash: string;
  /** Identifiers referenced inside the declaration. */
  refs: string[];
  decorators: string[];
  visibility?: "public" | "protected" | "private";
  extends?: string;
  implements?: string[];
}

export interface FileAnalysis {
  path: string;
  hash: string;
  language: "typescript" | "javascript";
  moduleKind: "esm" | "cjs" | "unknown";
  imports: ImportRecord[];
  symbols: SymbolRecord[];
  localExports: { exported: string; local: string }[];
  topLevelRefs: string[];
  topLevelHash: string;
  importsHash: string;
  /** Descriptions of non-literal dynamic imports/requires — sources of uncertainty. */
  dynamicUnresolved: string[];
  /** Computed import paths evaluated statically (relative to the file's dir; may contain *). */
  dynamicHints?: { pattern: string; line: number; expr: string }[];
  /** Derived at resolution time: project files the hints point to. */
  dynamicTargets?: string[];
  /** Derived at resolution time: hints that matched no project file (still uncertainty). */
  dynamicUnmatched?: string[];
  parseErrors: number;
  analyzerVersion: string;
}

export interface Analyzer {
  readonly id: string;
  readonly version: string;
  supports(path: string): boolean;
  analyze(path: string, content: string): FileAnalysis;
}

export interface ResolveResult {
  resolved?: string;
  external?: boolean;
  reason?: string;
}

export interface ModuleResolver {
  resolve(fromFile: string, specifier: string): ResolveResult;
}

/** Top-level units are the granularity of propagation (a class, function, variable…). */
export function topLevelSymbols(analysis: FileAnalysis): SymbolRecord[] {
  return analysis.symbols.filter((s) => !s.parent);
}

export function unitOf(symbol: SymbolRecord): string {
  return symbol.parent ?? symbol.qualifiedName;
}

export function rangesOverlap(a: SourceRange, b: SourceRange): boolean {
  return a.start.line <= b.end.line && b.start.line <= a.end.line;
}

export const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/;
