/**
 * Pure mapping between SmartTest graph units (`src/a.ts#Class.method`) and the
 * document symbols VS Code reports. Ranges are zero-based, as VS Code's are.
 * A unit the provider does not show gets no CodeLens: no range, no claim.
 */
import type { GraphDump } from "./contracts.js";
import { stripLeadingDotSlash, toPosix } from "./paths.js";

export type UnitKind = "function" | "method" | "class";

export interface GraphUnit {
  readonly id: string;
  readonly qualifiedName: string;
  readonly kind: UnitKind;
}

export type DocumentSymbolKind =
  | "module"
  | "namespace"
  | "class"
  | "method"
  | "property"
  | "field"
  | "constructor"
  | "interface"
  | "function"
  | "variable"
  | "constant"
  | "other";

export interface SourceRangeLike {
  readonly start: { readonly line: number; readonly character: number };
  readonly end: { readonly line: number; readonly character: number };
}

export interface DocumentSymbolNode {
  readonly name: string;
  readonly kind: DocumentSymbolKind;
  readonly range: SourceRangeLike;
  readonly children?: readonly DocumentSymbolNode[];
}

export interface UnitBinding {
  readonly unit: GraphUnit;
  readonly range: SourceRangeLike;
}

function unitKind(kind: string): UnitKind | undefined {
  if (kind === "function") return "function";
  if (kind === "method") return "method";
  if (kind === "class") return "class";
  return undefined;
}

/** Lookup key that compares like `sameProjectPath` (case-insensitive on Windows). */
export function projectPathKey(path: string, platform: NodeJS.Platform = process.platform): string {
  const normal = stripLeadingDotSlash(toPosix(path));
  return platform === "win32" ? normal.toLowerCase() : normal;
}

/**
 * Graph units grouped by file, built once per graph snapshot. `graph --format
 * json` is the only contract that lists symbols with their units, so it is the
 * source of truth for "does this unit exist at all?" — `explain` alone cannot
 * distinguish an unknown unit from a known unit with no tests.
 */
export function unitsByFile(
  graph: GraphDump,
  platform: NodeJS.Platform = process.platform,
): Map<string, GraphUnit[]> {
  const byFile = new Map<string, GraphUnit[]>();
  const seen = new Set<string>();
  for (const node of graph.nodes) {
    const kind = unitKind(node.kind);
    if (!kind) continue;
    const hash = node.id.indexOf("#");
    if (hash < 0) continue;
    const qualifiedName = node.id.slice(hash + 1);
    if (!qualifiedName) continue;
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    const key = projectPathKey(node.filePath ?? node.id.slice(0, hash), platform);
    let units = byFile.get(key);
    if (!units) {
      units = [];
      byFile.set(key, units);
    }
    units.push({ id: node.id, qualifiedName, kind });
  }
  return byFile;
}

/** Graph units for one file; prefer `unitsByFile` when looking up many files. */
export function unitsForFile(
  graph: GraphDump,
  file: string,
  platform: NodeJS.Platform = process.platform,
): GraphUnit[] {
  return [...(unitsByFile(graph, platform).get(projectPathKey(file, platform)) ?? [])];
}

function isContainer(kind: DocumentSymbolKind): boolean {
  return (
    kind === "class" ||
    kind === "interface" ||
    kind === "namespace" ||
    kind === "module" ||
    kind === "other"
  );
}

interface Candidate {
  readonly qualifiedName: string;
  readonly range: SourceRangeLike;
}

function collect(
  symbols: readonly DocumentSymbolNode[],
  parents: readonly string[],
  out: Candidate[],
): void {
  for (const symbol of symbols) {
    const chain = [...parents, symbol.name];
    // SmartTest qualifies members with their declaring class; containers are
    // part of the name so a method in a namespace still matches if it exists.
    out.push({ qualifiedName: chain.join("."), range: symbol.range });
    // Only containers are descended into. A function's local helpers and an
    // object literal's methods are not graph units; collecting them under their
    // parent's name would bind `helper` or `get` to the wrong declaration.
    if (symbol.children?.length && isContainer(symbol.kind)) collect(symbol.children, chain, out);
  }
}

/**
 * Matches units to the first document symbol with the same qualified name,
 * reached only through containers (classes, namespaces, modules). Overloads
 * share a name; the first declaration is used (one lens, not N).
 */
export function matchUnitsToSymbols(
  units: readonly GraphUnit[],
  symbols: readonly DocumentSymbolNode[],
): UnitBinding[] {
  const candidates: Candidate[] = [];
  collect(symbols, [], candidates);
  const byName = new Map<string, Candidate>();
  for (const candidate of candidates)
    if (!byName.has(candidate.qualifiedName)) byName.set(candidate.qualifiedName, candidate);
  const bindings: UnitBinding[] = [];
  for (const unit of units) {
    const match = byName.get(unit.qualifiedName);
    if (!match) continue;
    bindings.push({ unit, range: match.range });
  }
  return bindings.sort(
    (a, b) =>
      a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character,
  );
}

export function rangeContains(range: SourceRangeLike, line: number, character: number): boolean {
  if (line < range.start.line || line > range.end.line) return false;
  if (line === range.start.line && character < range.start.character) return false;
  if (line === range.end.line && character > range.end.character) return false;
  return true;
}

/** Smallest symbol range containing the cursor, for hover and "explain at cursor". */
export function bindingAtPosition<T extends { readonly range: SourceRangeLike }>(
  bindings: readonly T[],
  line: number,
  character: number,
): T | undefined {
  let best: T | undefined;
  for (const binding of bindings) {
    if (!rangeContains(binding.range, line, character)) continue;
    if (!best) {
      best = binding;
      continue;
    }
    const span = (r: SourceRangeLike) => r.end.line - r.start.line;
    const bestSpan = span(best.range);
    const candidateSpan = span(binding.range);
    if (candidateSpan < bestSpan) best = binding;
    else if (candidateSpan === bestSpan && binding.range.start.line > best.range.start.line)
      best = binding;
  }
  return best;
}
