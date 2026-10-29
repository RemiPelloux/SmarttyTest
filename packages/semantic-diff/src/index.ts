/**
 * @smarttest/semantic-diff — classifies changes per symbol, with confidence (spec §9.4).
 * Anything that can't be classified is "unclassifiable" and treated as a whole-file change.
 */
import type { SemanticChange, SemanticChangeKind, SourceRange } from "@smarttest/shared";
import type { FileAnalysis, SymbolRecord } from "@smarttest/source-parser";
import { rangesOverlap, topLevelSymbols, unitOf } from "@smarttest/source-parser";

export const WHOLE_FILE = "*";

export interface FileSemanticDiff {
  path: string;
  changes: SemanticChange[];
  /** Top-level units affected (qualified names), or ["*"] for the whole file. */
  units: string[];
  /** True when every change is comment-only/formatting (may be skipped in FAST mode only). */
  trivialOnly: boolean;
  confidence: "high" | "medium" | "low";
}

const TRIVIAL: SemanticChangeKind[] = ["comment-only", "formatting"];

function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "").replace(/\s+/g, "");
}

function whole(
  path: string,
  kind: SemanticChangeKind,
  confidence: "high" | "medium" | "low",
  notes: string,
): FileSemanticDiff {
  return {
    path,
    changes: [{ filePath: path, kind, confidence, notes }],
    units: [WHOLE_FILE],
    trivialOnly: false,
    confidence,
  };
}

export interface DiffInput {
  path: string;
  before?: FileAnalysis;
  after?: FileAnalysis;
  beforeText?: string;
  afterText?: string;
  ranges?: readonly SourceRange[];
}

export function diffFile(input: DiffInput): FileSemanticDiff {
  const { path, before, after } = input;
  if (!after) return whole(path, "exported-api", "high", "file deleted");
  if (!before) {
    if (input.ranges?.length) {
      const hit = topLevelSymbols(after).filter((s) =>
        input.ranges?.some((r) => rangesOverlap(s.range, r)),
      );
      const outside = input.ranges.some(
        (r) => !topLevelSymbols(after).some((s) => rangesOverlap(s.range, r)),
      );
      const units = outside ? [WHOLE_FILE] : hit.map((s) => s.qualifiedName);
      return {
        path,
        changes: hit.map((s) => ({
          symbolId: s.id,
          filePath: path,
          kind: "potential-behavioral" as const,
          confidence: "medium" as const,
          notes: "previous version unavailable — classified from changed lines",
        })),
        units: units.length ? units : [WHOLE_FILE],
        trivialOnly: false,
        confidence: "medium",
      };
    }
    return whole(path, "unclassifiable", "low", "previous version unavailable");
  }
  if (before.hash === after.hash)
    return { path, changes: [], units: [], trivialOnly: true, confidence: "high" };
  if (after.parseErrors > 0) return whole(path, "unclassifiable", "low", "file has syntax errors");
  if (after.moduleKind === "cjs" || before.moduleKind === "cjs")
    return whole(
      path,
      "potential-behavioral",
      "medium",
      "CommonJS module — analysed at file level",
    );

  const changes: SemanticChange[] = [];
  const units = new Set<string>();
  const add = (
    s: SymbolRecord,
    kind: SemanticChangeKind,
    confidence: "high" | "medium" | "low" = "high",
    notes?: string,
  ) => {
    changes.push({ symbolId: s.id, filePath: path, kind, confidence, ...(notes ? { notes } : {}) });
    if (!TRIVIAL.includes(kind)) units.add(unitOf(s));
  };
  const beforeBy = new Map(before.symbols.map((s) => [s.qualifiedName, s]));
  const afterBy = new Map(after.symbols.map((s) => [s.qualifiedName, s]));
  for (const [name, a] of afterBy) {
    const b = beforeBy.get(name);
    if (!b) {
      add(a, a.exportNames.length ? "exported-api" : "implementation", "high", "added");
      continue;
    }
    if (a.textHash === b.textHash && a.exportNames.join() === b.exportNames.join()) continue;
    if (a.tokenHash === b.tokenHash && a.exportNames.join() === b.exportNames.join()) {
      const beforeText = input.beforeText ?? "";
      const afterText = input.afterText ?? "";
      add(a, hasCommentDelta(b, a, beforeText, afterText) ? "comment-only" : "formatting");
      continue;
    }
    if (a.exportNames.join() !== b.exportNames.join()) add(a, "exported-api");
    else if (a.decorators.join() !== b.decorators.join()) add(a, "decorator");
    else if (
      (a.extends ?? "") !== (b.extends ?? "") ||
      (a.implements ?? []).join() !== (b.implements ?? []).join()
    )
      add(a, "inheritance");
    else if (a.kind === "interface" || a.kind === "type") add(a, "interface");
    else if (a.signature !== b.signature)
      add(
        a,
        a.exportNames.length || (a.parent && afterBy.get(a.parent)?.exportNames.length)
          ? "exported-api"
          : "signature",
      );
    else if (a.parent && changes.some((c) => c.symbolId === `${path}#${a.parent}`))
      add(a, "implementation");
    else add(a, "implementation");
  }
  for (const [name, b] of beforeBy) {
    if (!afterBy.has(name)) {
      changes.push({
        symbolId: b.id,
        filePath: path,
        kind: b.exportNames.length ? "exported-api" : "implementation",
        confidence: "high",
        notes: "removed",
      });
      units.add(b.parent && afterBy.has(b.parent) ? b.parent : b.qualifiedName);
    }
  }
  // A class whose only change is inside members: drop the class-level duplicate "implementation"
  // (members already carry the precise kind) but keep the unit.
  const memberChanged = new Set(
    changes
      .filter((c) => c.symbolId && afterBy.get(c.symbolId.split("#")[1] ?? "")?.parent)
      .map((c) => afterBy.get(c.symbolId?.split("#")[1] ?? "")?.parent),
  );
  const filtered = changes.filter(
    (c) =>
      !(
        c.kind === "implementation" &&
        c.symbolId &&
        memberChanged.has(c.symbolId.split("#")[1]) &&
        !c.notes
      ),
  );

  if (before.topLevelHash !== after.topLevelHash) {
    filtered.push({
      filePath: path,
      kind: "potential-behavioral",
      confidence: "medium",
      notes: "module-level code changed",
    });
    units.add(WHOLE_FILE);
  }
  if (before.importsHash !== after.importsHash) {
    const key = (i: FileAnalysis["imports"][number]) =>
      `${i.kind}|${i.specifier}|${i.bindings.map((b) => `${b.imported}>${b.local}`).join(",")}`;
    const beforeKeys = new Set(before.imports.map(key));
    const afterKeys = new Set(after.imports.map(key));
    const changedImports = [
      ...after.imports.filter((i) => !beforeKeys.has(key(i))),
      ...before.imports.filter((i) => !afterKeys.has(key(i))),
    ];
    const locals = new Set(changedImports.flatMap((i) => i.bindings.map((b) => b.local)));
    const sideEffects = changedImports.some(
      (i) =>
        i.kind === "side-effect" ||
        i.kind === "reexport" ||
        i.kind === "reexport-all" ||
        i.kind === "mock",
    );
    filtered.push({
      filePath: path,
      kind: "import",
      confidence: "high",
      notes: changedImports.map((i) => i.specifier).join(", "),
    });
    if (sideEffects || after.topLevelRefs.some((r) => locals.has(r))) units.add(WHOLE_FILE);
    for (const s of topLevelSymbols(after))
      if (s.refs.some((r) => locals.has(r))) units.add(s.qualifiedName);
  }
  const exportKey = (a: FileAnalysis) =>
    a.localExports
      .map((e) => `${e.exported}=${e.local}`)
      .sort()
      .join();
  if (exportKey(before) !== exportKey(after)) {
    filtered.push({
      filePath: path,
      kind: "exported-api",
      confidence: "high",
      notes: "export list changed",
    });
    const changedLocals = new Set(
      [...before.localExports, ...after.localExports].map((e) => e.local),
    );
    for (const l of changedLocals) if (afterBy.has(l) || beforeBy.has(l)) units.add(l);
  }
  if (!filtered.length) {
    // hashes differ but nothing structural found: be conservative
    return whole(path, "unclassifiable", "low", "change could not be attributed to a symbol");
  }
  const trivialOnly = filtered.every((c) => TRIVIAL.includes(c.kind));
  return {
    path,
    changes: filtered,
    units: units.has(WHOLE_FILE) ? [WHOLE_FILE] : [...units].sort(),
    trivialOnly,
    confidence: filtered.some((c) => c.confidence === "low")
      ? "low"
      : filtered.some((c) => c.confidence === "medium")
        ? "medium"
        : "high",
  };
}

function hasCommentDelta(
  b: SymbolRecord,
  a: SymbolRecord,
  beforeText: string,
  afterText: string,
): boolean {
  if (!beforeText || !afterText) return true;
  const slice = (text: string, s: SymbolRecord) =>
    text
      .split("\n")
      .slice(s.range.start.line, s.range.end.line + 1)
      .join("\n");
  const bt = slice(beforeText, b);
  const at = slice(afterText, a);
  return (
    stripComments(bt) === stripComments(at) && bt.replace(/\s+/g, "") !== at.replace(/\s+/g, "")
  );
}
