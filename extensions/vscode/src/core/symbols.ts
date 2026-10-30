/**
 * Pure mapping between SmartTest graph units (`src/a.ts#Class.method`) and the
 * document symbols VS Code reports. Ranges are zero-based, as VS Code's are.
 * A unit the provider does not show gets no CodeLens: no range, no claim.
 */
import type { GraphDump } from "./contracts.js";
import { sameProjectPath, toPosix } from "./paths.js";

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

/**
 * Graph nodes for one file. `graph --format json` is the only contract that
 * lists symbols with their units, so it is the source of truth for "does this
 * unit exist at all?" — `explain` alone cannot distinguish an unknown unit from
 * a known unit with no tests.
 */
export function unitsForFile(
  graph: GraphDump,
  file: string,
  platform: NodeJS.Platform = process.platform,
): GraphUnit[] {
  const target = toPosix(file);
  const units: GraphUnit[] = [];
  for (const node of graph.nodes) {
    const nodeFile = node.filePath ?? node.id.split("#")[0] ?? "";
    if (!sameProjectPath(nodeFile, target, platform)) continue;
    const kind = unitKind(node.kind);
    if (!kind) continue;
    const hash = node.id.indexOf("#");
    if (hash < 0) continue;
    const qualifiedName = node.id.slice(hash + 1);
    if (!qualifiedName) continue;
    units.push({ id: node.id, qualifiedName, kind });
  }
  return units.filter((unit, index) => units.findIndex((u) => u.id === unit.id) === index);
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
    if (!symbol.children?.length) continue;
    collect(symbol.children, isContainer(symbol.kind) ? chain : parents, out);
  }
}

/**
 * Matches units to the first document symbol with the same qualified name.
 * Overloads share a name; the first declaration is used (one lens, not N).
 */
export function matchUnitsToSymbols(
  units: readonly GraphUnit[],
  symbols: readonly DocumentSymbolNode[],
): UnitBinding[] {
  const candidates: Candidate[] = [];
  collect(symbols, [], candidates);
  const bindings: UnitBinding[] = [];
  for (const unit of units) {
    const match = candidates.find((candidate) => candidate.qualifiedName === unit.qualifiedName);
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
