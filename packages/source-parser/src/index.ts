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
  /** For `vi.mock` / `jest.mock` family calls. */
  mock?: "factory" | "auto" | "actual" | "unmock";
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
  /** "Name.member" uses (member-level precision); see language-typescript/member-uses. */
  uses?: string[];
  /** Names referenced as a whole (class-level / unit-level dependency). */
  escapes?: string[];
  /** Members reached through this. and super. (class members only). */
  thisUses?: string[];
  superUses?: string[];
  /** Methods: `this` leaves the method (fluent APIs), so callers can reach any member. */
  thisEscapes?: boolean;
  /** Classes: token hash of the class with method/constructor bodies removed. */
  shellHash?: string;
  /** Non-code resources read: "env:NAME", "env:*", "model:Name", "i18n:key". */
  resources?: string[];
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
  /** Member-level uses and escapes of module-level code. */
  topLevelUses?: string[];
  topLevelEscapes?: string[];
  topLevelResources?: string[];
  topLevelHash: string;
  importsHash: string;
  /** Descriptions of non-literal dynamic imports/requires — sources of uncertainty. */
  dynamicUnresolved: string[];
  /** Computed import paths evaluated statically (relative to the file's dir; may contain *). */
  dynamicHints?: { pattern: string; line: number; expr: string }[];
  /** Files read through fs with a path built from the file's location (relative to its directory). */
  assetReads?: { pattern: string; line: number; unit: string }[];
  /** Translation catalogs: flattened key path → value hash. */
  catalogKeys?: Record<string, string>;
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
