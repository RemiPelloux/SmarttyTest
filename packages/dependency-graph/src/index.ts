/**
 * @smarttest/dependency-graph — hybrid dependency graph with provenance and confidence (spec §10).
 *
 * Granularity: top-level units (class, function, variable…). Edges point from a dependent unit to
 * what it depends on. A unit of "*" means "the whole file"; dependents registered on a file mean
 * "depends on any part of that file" (namespace, side-effect, require, mocks).
 */
import type { Confidence, GraphEdge, GraphNode, Provenance } from "@smarttest/shared";
import type { FileAnalysis } from "@smarttest/source-parser";
import { topLevelSymbols } from "@smarttest/source-parser";

export const WHOLE = "*";

export interface Seed {
  file: string;
  units: string[]; // ["*"] = whole file
}

export interface TestHit {
  test: string;
  /** Human-readable path from a changed unit to the test. */
  path: string[];
  depth: number;
  confidence: Confidence;
}

export interface TraversalResult {
  tests: Map<string, TestHit>;
  affectedFiles: Set<string>;
  affectedUnits: Set<string>;
}

interface Dep {
  /** dependent key: "file#unit" */
  from: string;
  kind: GraphEdge["kind"];
  provenance: Provenance;
  confidence: Confidence;
}

const key = (file: string, unit: string) => `${file}#${unit}`;
const splitKey = (k: string): [string, string] => {
  const i = k.lastIndexOf("#");
  return [k.slice(0, i), k.slice(i + 1)];
};

export class DependencyGraph {
  /** target unit key -> dependents */
  private unitDependents = new Map<string, Dep[]>();
  /** target file -> dependents on any part of it */
  private fileDependents = new Map<string, Dep[]>();
  /** file -> unit -> same-file units that reference it */
  private intra = new Map<string, Map<string, Set<string>>>();
  /** file -> units referenced by module-level code */
  private topLevelUsed = new Map<string, Set<string>>();
  /** target file -> files that re-export from it */
  private reexporters = new Map<string, Set<string>>();
  /** file -> resolved internal import targets */
  private forward = new Map<string, Set<string>>();
  private forwardClosure = new Map<string, Set<string>>();
  readonly uncertainty = new Map<string, string[]>();
  readonly deletedFiles = new Set<string>();
  private edgeCount = 0;

  constructor(
    private readonly files: ReadonlyMap<string, FileAnalysis>,
    private readonly isTest: (path: string) => boolean,
  ) {
    this.build();
  }

  private addUnitDep(target: string, dep: Dep): void {
    const list = this.unitDependents.get(target) ?? [];
    list.push(dep);
    this.unitDependents.set(target, list);
    this.edgeCount++;
  }

  private addFileDep(target: string, dep: Dep): void {
    const list = this.fileDependents.get(target) ?? [];
    list.push(dep);
    this.fileDependents.set(target, list);
    this.edgeCount++;
  }

  private exportCache = new Map<string, Map<string, string>>();

  /** Directly exported names of a file → defining top-level unit (cached). */
  private exportsOf(file: string, a: FileAnalysis): Map<string, string> {
    let m = this.exportCache.get(file);
    if (!m) {
      m = new Map();
      for (const s of a.symbols)
        if (!s.parent) for (const n of s.exportNames) m.set(n, s.qualifiedName);
      this.exportCache.set(file, m);
    }
    return m;
  }

  /** Resolves an exported name to its defining unit, following re-exports (barrels). */
  resolveExport(
    file: string,
    name: string,
    seen = new Set<string>(),
  ): { file: string; unit: string } | undefined {
    const visitKey = `${file}:${name}`;
    if (seen.has(visitKey)) return undefined;
    seen.add(visitKey);
    const a = this.files.get(file);
    if (!a || a.moduleKind === "cjs") return undefined;
    const direct = this.exportsOf(file, a).get(name);
    if (direct) return { file, unit: direct };
    const local = a.localExports.find((e) => e.exported === name);
    if (local) {
      const sym = topLevelSymbols(a).find((s) => s.qualifiedName === local.local);
      if (sym) return { file, unit: sym.qualifiedName };
      for (const imp of a.imports) {
        const b = imp.bindings.find((x) => x.local === local.local);
        if (b && imp.resolved && b.imported !== "*")
          return (
            this.resolveExport(imp.resolved, b.imported, seen) ?? {
              file: imp.resolved,
              unit: WHOLE,
            }
          );
      }
    }
    for (const imp of a.imports) {
      if (!imp.resolved) continue;
      if (imp.kind === "reexport") {
        const b = imp.bindings.find((x) => x.local === name);
        if (b)
          return b.imported === "*"
            ? { file: imp.resolved, unit: WHOLE }
            : (this.resolveExport(imp.resolved, b.imported, seen) ?? {
                file: imp.resolved,
                unit: WHOLE,
              });
      }
    }
    if (name !== "default") {
      for (const imp of a.imports) {
        if (imp.kind === "reexport-all" && imp.resolved) {
          const r = this.resolveExport(imp.resolved, name, seen);
          if (r) return r;
        }
      }
    }
    return undefined;
  }

  private build(): void {
    for (const [file, a] of this.files) {
      const units = topLevelSymbols(a).map((s) => s.qualifiedName);
      const unitSet = new Set(units);
      const test = this.isTest(file);
      const fwd = new Set<string>();
      this.forward.set(file, fwd);
      const unc: string[] = [...a.dynamicUnresolved.map((d) => `dynamic import/require (${d})`)];
      // local name -> targets
      const localTargets = new Map<
        string,
        { target: string; kind: "unit" | "file"; typeOnly: boolean; confidence: Confidence }[]
      >();
      for (const imp of a.imports) {
        if (imp.unresolved && !imp.missing)
          unc.push(`unresolved import "${imp.specifier}" (${imp.unresolved})`);
        if (!imp.resolved) continue;
        fwd.add(imp.resolved);
        if (imp.missing) this.deletedFiles.add(imp.resolved);
        const prov: Provenance = "static";
        if (imp.kind === "reexport" || imp.kind === "reexport-all") {
          const set = this.reexporters.get(imp.resolved) ?? new Set();
          set.add(file);
          this.reexporters.set(imp.resolved, set);
          continue;
        }
        if (
          imp.kind === "named" ||
          (imp.kind === "require" &&
            imp.bindings.length &&
            imp.bindings.every((b) => b.imported !== "*"))
        ) {
          for (const b of imp.bindings) {
            const r = b.imported === "*" ? undefined : this.resolveExport(imp.resolved, b.imported);
            const entry =
              r && r.unit !== WHOLE
                ? {
                    target: key(r.file, r.unit),
                    kind: "unit" as const,
                    typeOnly: imp.typeOnly,
                    confidence: "high" as Confidence,
                  }
                : {
                    target: r?.file ?? imp.resolved,
                    kind: "file" as const,
                    typeOnly: imp.typeOnly,
                    confidence: (r ? "high" : "medium") as Confidence,
                  };
            const list = localTargets.get(b.local) ?? [];
            list.push(entry);
            localTargets.set(b.local, list);
          }
          continue;
        }
        if (imp.kind === "namespace" || imp.kind === "require") {
          for (const b of imp.bindings) {
            const list = localTargets.get(b.local) ?? [];
            list.push({
              target: imp.resolved,
              kind: "file",
              typeOnly: imp.typeOnly,
              confidence: "high",
            });
            localTargets.set(b.local, list);
          }
          if (imp.bindings.length) continue;
        }
        // side-effect, bare require, dynamic, mock: the whole file depends on the target
        this.addFileDep(imp.resolved, {
          from: key(file, WHOLE),
          kind: imp.kind === "mock" ? "REFERENCES" : "IMPORTS",
          provenance: prov,
          confidence: imp.kind === "dynamic" || imp.kind === "mock" ? "medium" : "high",
        });
      }
      if (unc.length) this.uncertainty.set(file, unc);

      const link = (fromUnit: string, refs: readonly string[]) => {
        for (const r of refs) {
          for (const t of localTargets.get(r) ?? []) {
            const dep: Dep = {
              from: key(file, fromUnit),
              kind: test ? "TESTS" : "REFERENCES",
              provenance: "static",
              confidence: t.confidence,
            };
            if (t.kind === "unit") this.addUnitDep(t.target, dep);
            else this.addFileDep(t.target, dep);
          }
        }
      };
      const intraMap = new Map<string, Set<string>>();
      const memberRefsByParent = new Map<string, string[]>();
      for (const m of a.symbols)
        if (m.parent)
          memberRefsByParent.set(m.parent, [
            ...(memberRefsByParent.get(m.parent) ?? []),
            ...m.refs,
          ]);
      for (const s of topLevelSymbols(a)) {
        const memberRefs = memberRefsByParent.get(s.qualifiedName) ?? [];
        const refs = [...new Set([...s.refs, ...memberRefs])];
        link(test ? WHOLE : s.qualifiedName, refs);
        for (const r of refs) {
          if (r !== s.qualifiedName && unitSet.has(r)) {
            const set = intraMap.get(r) ?? new Set();
            set.add(s.qualifiedName);
            intraMap.set(r, set);
          }
        }
      }
      // Locally re-exported imports: `import { x } from "./y"; export { x }` → this file re-exports y.
      for (const le of a.localExports) {
        for (const imp of a.imports) {
          if (imp.resolved && imp.bindings.some((b) => b.local === le.local)) {
            const set = this.reexporters.get(imp.resolved) ?? new Set();
            set.add(file);
            this.reexporters.set(imp.resolved, set);
          }
        }
      }
      link(WHOLE, a.topLevelRefs);
      this.intra.set(file, intraMap);
      this.topLevelUsed.set(file, new Set(a.topLevelRefs.filter((r) => unitSet.has(r))));
    }
  }

  get stats(): { files: number; edges: number; uncertainFiles: number } {
    return { files: this.files.size, edges: this.edgeCount, uncertainFiles: this.uncertainty.size };
  }

  hasFile(file: string): boolean {
    return this.files.has(file) || this.deletedFiles.has(file);
  }

  /** Transitive internal imports of a file (forward). */
  dependenciesOf(file: string): Set<string> {
    const cached = this.forwardClosure.get(file);
    if (cached) return cached;
    const out = new Set<string>();
    const stack = [...(this.forward.get(file) ?? [])];
    while (stack.length) {
      const f = stack.pop() as string;
      if (out.has(f) || f === file) continue;
      out.add(f);
      for (const n of this.forward.get(f) ?? []) stack.push(n);
    }
    this.forwardClosure.set(file, out);
    return out;
  }

  private reachingUncertainty: Set<string> | undefined;

  /** Files whose transitive imports include a file with uncertainty (computed once, reverse BFS). */
  private filesReachingUncertainty(): Set<string> {
    if (this.reachingUncertainty) return this.reachingUncertainty;
    const reverse = new Map<string, string[]>();
    for (const [from, tos] of this.forward)
      for (const to of tos) reverse.set(to, [...(reverse.get(to) ?? []), from]);
    const out = new Set<string>(this.uncertainty.keys());
    const queue = [...out];
    for (let i = 0; i < queue.length; i++) {
      for (const importer of reverse.get(queue[i] as string) ?? []) {
        if (!out.has(importer)) {
          out.add(importer);
          queue.push(importer);
        }
      }
    }
    this.reachingUncertainty = out;
    return out;
  }

  /** Files (incl. the file itself) with uncertainty reachable from a file. */
  uncertaintyReachableFrom(file: string): { file: string; reasons: string[] }[] {
    if (!this.uncertainty.size || !this.filesReachingUncertainty().has(file)) return [];
    const out: { file: string; reasons: string[] }[] = [];
    for (const f of [file, ...this.dependenciesOf(file)]) {
      const u = this.uncertainty.get(f);
      if (u) out.push({ file: f, reasons: u });
    }
    return out;
  }

  /** Reverse traversal from changed units to everything that depends on them (cycle-safe BFS). */
  dependentsOf(seeds: readonly Seed[]): TraversalResult {
    const parent = new Map<string, string | undefined>();
    const queue: string[] = [];
    let head = 0;
    const push = (k: string, from: string | undefined) => {
      if (parent.has(k)) return;
      parent.set(k, from);
      queue.push(k);
    };
    for (const s of seeds)
      for (const u of s.units.length ? s.units : [WHOLE]) push(key(s.file, u), undefined);

    const tests = new Map<string, TestHit>();
    const affectedFiles = new Set<string>();
    const affectedUnits = new Set<string>();
    const label = (k: string) => {
      const [file, unit] = splitKey(k);
      return unit === WHOLE || unit === "@any" ? file : `${file}#${unit}`;
    };
    const pathTo = (k: string): string[] => {
      const out: string[] = [];
      let cur: string | undefined = k;
      while (cur !== undefined) {
        const l = label(cur);
        if (out[0] !== l) out.unshift(l);
        cur = parent.get(cur);
      }
      // "file → file#Unit" is one hop, not two: keep the more precise label.
      if (out.length > 1 && !out[0]?.includes("#") && out[1]?.startsWith(`${out[0]}#`)) out.shift();
      return out;
    };

    while (head < queue.length) {
      const k = queue[head++] as string;
      const [file, unit] = splitKey(k);
      affectedFiles.add(file);
      if (this.isTest(file)) {
        if (!tests.has(file)) {
          const path = pathTo(k);
          tests.set(file, { test: file, path, depth: path.length - 1, confidence: "high" });
        }
        continue;
      }
      const a = this.files.get(file);
      let units: string[];
      if (unit === "@any") units = [];
      else if (unit === WHOLE) units = a ? topLevelSymbols(a).map((s) => s.qualifiedName) : [];
      else units = [unit];
      // same-file propagation
      const intra = this.intra.get(file);
      const topUsed = this.topLevelUsed.get(file);
      const expanded = new Set(units);
      const stack = [...units];
      while (stack.length) {
        const u = stack.pop() as string;
        for (const d of intra?.get(u) ?? [])
          if (!expanded.has(d)) {
            expanded.add(d);
            stack.push(d);
          }
      }
      if (unit !== WHOLE && unit !== "@any" && [...expanded].some((u) => topUsed?.has(u)))
        push(key(file, WHOLE), k);
      for (const u of expanded) {
        affectedUnits.add(key(file, u));
        if (u !== unit) push(key(file, u), k);
        for (const d of this.unitDependents.get(key(file, u)) ?? []) push(d.from, key(file, u));
      }
      for (const d of this.fileDependents.get(file) ?? []) push(d.from, k);
      for (const g of this.reexporters.get(file) ?? []) push(key(g, "@any"), k);
    }
    return { tests, affectedFiles, affectedUnits };
  }

  /** Nodes and edges for export (JSON/DOT) and future visualisation (spec §10.8). */
  toGraph(): { nodes: GraphNode[]; edges: GraphEdge[] } {
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    for (const [file, a] of this.files) {
      nodes.push({
        id: file,
        kind: this.isTest(file) ? "test-suite" : "file",
        label: file,
        filePath: file,
      });
      for (const s of topLevelSymbols(a)) {
        nodes.push({
          id: key(file, s.qualifiedName),
          kind: s.kind === "class" ? "class" : s.kind === "function" ? "function" : "module",
          label: s.qualifiedName,
          filePath: file,
        });
      }
    }
    for (const [target, deps] of this.unitDependents)
      for (const d of deps)
        edges.push({
          from: d.from.replace(/#\*$/, ""),
          to: target,
          kind: d.kind,
          provenance: d.provenance,
          confidence: d.confidence,
        });
    for (const [target, deps] of this.fileDependents)
      for (const d of deps)
        edges.push({
          from: d.from.replace(/#\*$/, ""),
          to: target,
          kind: d.kind,
          provenance: d.provenance,
          confidence: d.confidence,
        });
    return { nodes, edges };
  }

  toDot(): string {
    const { nodes, edges } = this.toGraph();
    const q = (s: string) => JSON.stringify(s);
    const lines = [
      "digraph smarttest {",
      "  rankdir=LR;",
      "  node [shape=box, fontname=monospace];",
    ];
    for (const n of nodes)
      lines.push(
        `  ${q(n.id)} [label=${q(n.label)}${n.kind === "test-suite" ? ', style=filled, fillcolor="#34D399"' : ""}];`,
      );
    for (const e of edges) lines.push(`  ${q(e.from)} -> ${q(e.to)} [label=${q(e.kind)}];`);
    lines.push("}");
    return lines.join("\n");
  }
}
