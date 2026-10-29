/**
 * @smarttest/dependency-graph — dependency graph with provenance and confidence (spec §10).
 *
 * Node keys:
 *   file#X          a top-level symbol (function, variable, class as a whole)
 *   file#C.m        a class member (method, accessor, property)
 *   file#C.@init    construction of C (constructor, field initializers, heritage)
 *   file#*          the whole file (module-level code, side-effect imports, tests)
 *   @resource#k:v   a non-code resource: "env:NAME", "model:Name", "i18n:key" (`*` = any key)
 *
 * An edge points from a dependent key to what it depends on. Member-level edges come from the
 * analyzer's member uses; anything less precise (escapes, unknown members, non-class targets)
 * falls back to the class or symbol as a whole. Dependents registered on `file#C` (imprecise users
 * of C) are affected by any change to any member of C.
 */
import type { Confidence, GraphEdge, GraphNode, Provenance } from "@smarttest/shared";
import { matchGlob } from "@smarttest/shared";
import type { FileAnalysis, SymbolRecord } from "@smarttest/source-parser";
import { topLevelSymbols } from "@smarttest/source-parser";

export const WHOLE = "*";
const ANY = "@any";
const INIT = "@init";
export const RESOURCE = "@resource";
/** Framework modules whose exports are the project's own operations (Wasp). */
const WASP_OPERATION_MODULES = new Set(["wasp/client/operations", "wasp/server/operations"]);

/**
 * Whether a translation key read in code (`t("nav.about")`, `t("auth:login")`, `t(`nav.${x}`)`)
 * is affected by a changed catalog key ("auth.login.title"). Readers of a parent object or a
 * plural/context variant (`item` for `item_one`) match too.
 */
export function i18nKeyMatches(reader: string, changed: string): boolean {
  const r = reader.replace(":", ".");
  const candidates = [changed];
  const dot = changed.indexOf(".");
  if (dot > 0) candidates.push(changed.slice(dot + 1)); // without namespace
  if (r.endsWith("*")) return candidates.some((c) => c.startsWith(r.slice(0, -1)));
  return candidates.some((c) => c === r || c.startsWith(`${r}.`) || c.startsWith(`${r}_`));
}

export interface Seed {
  file: string;
  /** Units: "*" (whole file), "X" (top-level symbol / whole class), "C.m" (member). */
  units: string[];
  /** The change alters what the file exports (names, signatures), not only behaviour. */
  signature?: boolean;
  /** Follow only symbol references out of this file (data catalogs read through resource keys). */
  referencesOnly?: boolean;
}

export interface TestHit {
  test: string;
  /** Human-readable path from a changed unit to the test. */
  path: string[];
  depth: number;
  /** Lowest confidence along the path. */
  confidence: Confidence;
}

export interface TraversalResult {
  tests: Map<string, TestHit>;
  affectedFiles: Set<string>;
  affectedUnits: Set<string>;
  /** Path (labels) from the seeds to a reached file, if reached. */
  pathTo(file: string): string[] | undefined;
}

interface Dep {
  from: string;
  kind: GraphEdge["kind"];
  provenance: Provenance;
  confidence: Confidence;
}

type LocalTarget = { file: string; unit: string } | { file: string; namespace: true };

const key = (file: string, unit: string) => `${file}#${unit}`;
const splitKey = (k: string): [string, string] => {
  const i = k.indexOf("#");
  return [k.slice(0, i), k.slice(i + 1)];
};
const RANK: Confidence[] = ["high", "medium", "low", "unknown"];
const weakest = (a: Confidence, b: Confidence): Confidence =>
  RANK.indexOf(a) >= RANK.indexOf(b) ? a : b;

export class DependencyGraph {
  private deps = new Map<string, Dep[]>();
  private fileDependents = new Map<string, Dep[]>();
  /** Importers affected when a file's module-level code changes (imports run that code). */
  private moduleDependents = new Map<string, string[]>();
  private reexporters = new Map<string, Set<string>>();
  private forward = new Map<string, Set<string>>();
  private forwardClosure = new Map<string, Set<string>>();
  private exportCache = new Map<string, Map<string, string>>();
  private localCache = new Map<string, Map<string, LocalTarget>>();
  private reachingUncertainty: Set<string> | undefined;
  readonly uncertainty = new Map<string, string[]>();
  readonly deletedFiles = new Set<string>();
  private edgeCount = 0;
  private memberEdgeCount = 0;
  private resourceKeys = new Set<string>();
  private assetReads: { pattern: string; from: string }[] = [];
  /** Files a test replaces with a factory mock (`vi.mock("./m", () => …)`): never loaded there. */
  private factoryMocks = new Map<string, Set<string>>();
  private waspOps = new Map<string, Map<string, { file: string; unit: string }>>();

  constructor(
    private readonly files: ReadonlyMap<string, FileAnalysis>,
    private readonly isTest: (path: string) => boolean,
  ) {
    this.build();
  }

  // ── lookups ─────────────────────────────────────────────────────────────────────────────

  private topSymbol(file: string, name: string): SymbolRecord | undefined {
    return this.files.get(file)?.symbols.find((s) => !s.parent && s.qualifiedName === name);
  }

  private member(file: string, cls: string, name: string): SymbolRecord | undefined {
    return this.files.get(file)?.symbols.find((s) => s.parent === cls && s.name === name);
  }

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
    if (!a) return undefined;
    const direct = this.exportsOf(file, a).get(name);
    if (direct) return { file, unit: direct };
    const local = a.localExports.find((e) => e.exported === name);
    if (local) {
      if (this.topSymbol(file, local.local)) return { file, unit: local.local };
      for (const imp of a.imports) {
        const b = imp.bindings.find((x) => x.local === local.local);
        if (b && imp.resolved && b.imported !== "*")
          return (
            this.resolveExport(imp.resolved, b.imported, seen) ?? {
              file: imp.resolved,
              unit: WHOLE,
            }
          );
        if (b && imp.resolved) return { file: imp.resolved, unit: WHOLE };
      }
    }
    for (const imp of a.imports) {
      if (!imp.resolved || imp.kind !== "reexport") continue;
      const b = imp.bindings.find((x) => x.local === name);
      if (b)
        return b.imported === "*"
          ? { file: imp.resolved, unit: WHOLE }
          : (this.resolveExport(imp.resolved, b.imported, seen) ?? {
              file: imp.resolved,
              unit: WHOLE,
            });
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

  /** What a name means inside a file: a same-file symbol, an imported unit, or a namespace. */
  private localTarget(file: string, name: string): LocalTarget | undefined {
    let cache = this.localCache.get(file);
    if (!cache) {
      cache = new Map();
      const a = this.files.get(file);
      if (a) {
        for (const imp of a.imports) {
          if (!imp.resolved && WASP_OPERATION_MODULES.has(imp.specifier)) {
            const ops = this.waspOperationsFor(file);
            for (const b of imp.bindings) {
              const op = ops?.get(b.imported);
              if (op) cache.set(b.local, op);
            }
            continue;
          }
          if (!imp.resolved || imp.kind === "reexport" || imp.kind === "reexport-all") continue;
          for (const b of imp.bindings) {
            if (b.imported === "*") cache.set(b.local, { file: imp.resolved, namespace: true });
            else {
              const r = this.resolveExport(imp.resolved, b.imported);
              cache.set(b.local, r ?? { file: imp.resolved, unit: WHOLE });
            }
          }
        }
        for (const s of a.symbols)
          if (!s.parent) cache.set(s.qualifiedName, { file, unit: s.qualifiedName });
      }
      this.localCache.set(file, cache);
    }
    return cache.get(name);
  }

  /** Key of `cls.member`, following `extends` for inherited members. */
  private memberKey(
    file: string,
    cls: string,
    member: string,
    seen = new Set<string>(),
  ): string | undefined {
    if (member === "constructor") return key(file, `${cls}.${INIT}`);
    if (seen.has(`${file}:${cls}`)) return undefined;
    seen.add(`${file}:${cls}`);
    if (this.member(file, cls, member)) return key(file, `${cls}.${member}`);
    const base = this.topSymbol(file, cls)?.extends;
    if (!base || !/^[A-Za-z_$][\w$]*$/.test(base)) return undefined;
    const t = this.localTarget(file, base);
    if (!t || "namespace" in t || t.unit === WHOLE) return undefined;
    if (this.topSymbol(t.file, t.unit)?.kind !== "class") return undefined;
    return this.memberKey(t.file, t.unit, member, seen);
  }

  /** Operations declared by the Wasp spec (`main.wasp.ts`) of the app containing a file. */
  private waspOperationsFor(file: string): Map<string, { file: string; unit: string }> | undefined {
    let best: string | undefined;
    for (const dir of this.waspOps.keys())
      if (
        (dir === "" || file.startsWith(`${dir}/`)) &&
        (best === undefined || dir.length > best.length)
      )
        best = dir;
    return best === undefined ? undefined : this.waspOps.get(best);
  }

  private collectWaspSpecs(): void {
    for (const [file, a] of this.files) {
      if (!/(^|\/)main\.wasp\.(ts|js|mts)$/.test(file)) continue;
      const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";
      const ops = new Map<string, { file: string; unit: string }>();
      for (const imp of a.imports) {
        if (!imp.resolved) continue;
        for (const b of imp.bindings) {
          if (b.imported === "*") continue;
          ops.set(
            b.local,
            this.resolveExport(imp.resolved, b.imported) ?? { file: imp.resolved, unit: WHOLE },
          );
        }
      }
      this.waspOps.set(dir, ops);
    }
  }

  // ── build ───────────────────────────────────────────────────────────────────────────────

  private addDep(target: string, dep: Dep): void {
    const list = this.deps.get(target) ?? [];
    list.push(dep);
    this.deps.set(target, list);
    this.edgeCount++;
  }

  private addFileDep(target: string, dep: Dep): void {
    const list = this.fileDependents.get(target) ?? [];
    list.push(dep);
    this.fileDependents.set(target, list);
    this.edgeCount++;
  }

  /** Links one dependent key to everything its references, member uses and escapes reach. */
  private link(
    file: string,
    from: string,
    refs: readonly string[],
    uses: readonly string[],
    escapes: readonly string[],
    kind: GraphEdge["kind"],
  ): void {
    const usesByName = new Map<string, Set<string>>();
    for (const u of uses) {
      const i = u.indexOf(".");
      const n = u.slice(0, i);
      const set = usesByName.get(n) ?? new Set();
      set.add(u.slice(i + 1));
      usesByName.set(n, set);
    }
    const escaped = new Set(escapes);
    const names = new Set([...refs, ...usesByName.keys(), ...escapes]);
    const dep = (confidence: Confidence = "high"): Dep => ({
      from,
      kind,
      provenance: "static",
      confidence,
    });
    for (const name of names) {
      const t = this.localTarget(file, name);
      if (!t) continue;
      if (t.file === file && !("namespace" in t) && key(file, t.unit) === from) continue; // self
      const members = usesByName.get(name);
      if ("namespace" in t) {
        if (escaped.has(name) || !members?.size) {
          this.addFileDep(t.file, dep());
          continue;
        }
        for (const m of members) {
          const r = this.resolveExport(t.file, m);
          if (r && r.unit !== WHOLE) {
            this.addDep(key(r.file, r.unit), dep());
            this.memberEdgeCount++;
          } else this.addFileDep(t.file, dep("medium"));
        }
        continue;
      }
      if (t.unit === WHOLE) {
        this.addFileDep(t.file, dep("medium"));
        continue;
      }
      const isClass = this.topSymbol(t.file, t.unit)?.kind === "class";
      if (!isClass || escaped.has(name) || !members?.size) {
        this.addDep(key(t.file, t.unit), dep());
        continue;
      }
      for (const m of members) {
        const mk = this.memberKey(t.file, t.unit, m);
        if (mk) this.memberEdgeCount++;
        this.addDep(mk ?? key(t.file, t.unit), dep());
      }
    }
  }

  private linkResources(from: string, resources: readonly string[] | undefined): void {
    for (const r of resources ?? []) {
      this.resourceKeys.add(r);
      this.addDep(key(RESOURCE, r), {
        from,
        kind: "REFERENCES",
        provenance: "static",
        confidence: "high",
      });
    }
  }

  private build(): void {
    this.collectWaspSpecs();
    for (const [file, a] of this.files) {
      const test = this.isTest(file);
      const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/") + 1) : "";
      for (const r of a.assetReads ?? []) {
        const pattern = posixNormalize(`${dir}${r.pattern}`);
        if (!pattern.startsWith(".."))
          this.assetReads.push({ pattern, from: key(file, test ? WHOLE : r.unit) });
      }
      if (test) {
        const actual = new Set(
          a.imports
            .filter((i) => i.mock === "actual" || i.mock === "unmock")
            .map((i) => i.resolved),
        );
        const mocked = a.imports
          .filter(
            (i) =>
              i.kind === "mock" && i.mock === "factory" && i.resolved && !actual.has(i.resolved),
          )
          .map((i) => i.resolved as string);
        if (mocked.length) this.factoryMocks.set(file, new Set(mocked));
      }
      const fwd = new Set<string>();
      this.forward.set(file, fwd);
      const unc: string[] = [...a.dynamicUnresolved.map((d) => `dynamic import/require (${d})`)];
      for (const imp of a.imports) {
        if (imp.unresolved && !imp.missing)
          unc.push(`unresolved import "${imp.specifier}" (${imp.unresolved})`);
        if (!imp.resolved) continue;
        fwd.add(imp.resolved);
        if (imp.missing) this.deletedFiles.add(imp.resolved);
        if (!imp.typeOnly)
          this.moduleDependents.set(imp.resolved, [
            ...(this.moduleDependents.get(imp.resolved) ?? []),
            key(file, WHOLE),
          ]);
        if (imp.kind === "reexport" || imp.kind === "reexport-all") {
          const set = this.reexporters.get(imp.resolved) ?? new Set();
          set.add(file);
          this.reexporters.set(imp.resolved, set);
          continue;
        }
        if (imp.bindings.length && imp.kind !== "dynamic" && imp.kind !== "mock") continue; // linked through names
        this.addFileDep(imp.resolved, {
          from: key(file, WHOLE),
          kind: imp.kind === "mock" ? "REFERENCES" : "IMPORTS",
          provenance: "static",
          confidence: imp.kind === "dynamic" || imp.kind === "mock" ? "medium" : "high",
        });
      }
      for (const d of a.dynamicUnmatched ?? [])
        unc.push(`dynamic import matched no project file (${d})`);
      for (const target of a.dynamicTargets ?? []) {
        fwd.add(target);
        this.addFileDep(target, {
          from: key(file, WHOLE),
          kind: "IMPORTS",
          provenance: "static",
          confidence: "medium",
        });
      }
      if (unc.length) this.uncertainty.set(file, unc);

      // Re-exported locals: `import { x } from "./y"; export { x }` makes this file a re-exporter of y.
      for (const le of a.localExports) {
        for (const imp of a.imports) {
          if (imp.resolved && imp.bindings.some((b) => b.local === le.local)) {
            const set = this.reexporters.get(imp.resolved) ?? new Set();
            set.add(file);
            this.reexporters.set(imp.resolved, set);
          }
        }
      }

      const kind: GraphEdge["kind"] = test ? "TESTS" : "REFERENCES";
      for (const s of a.symbols) {
        const from = test
          ? key(file, WHOLE)
          : key(file, s.parent ? `${s.parent}.${s.name}` : s.qualifiedName);
        this.link(file, from, s.refs, s.uses ?? [], s.escapes ?? [], kind);
        this.linkResources(from, s.resources);
        if (s.parent && !test) {
          if (s.thisEscapes)
            this.addDep(key(file, s.parent), {
              from,
              kind: "REFERENCES",
              provenance: "static",
              confidence: "high",
            });
          for (const m of s.thisUses ?? []) {
            const mk = this.memberKey(file, s.parent, m);
            if (mk && mk !== from)
              this.addDep(mk, {
                from,
                kind: "REFERENCES",
                provenance: "static",
                confidence: "high",
              });
          }
          const base = this.topSymbol(file, s.parent)?.extends;
          for (const m of s.superUses ?? []) {
            const t = base ? this.localTarget(file, base) : undefined;
            const mk =
              t && !("namespace" in t) && t.unit !== WHOLE
                ? this.memberKey(t.file, t.unit, m)
                : undefined;
            this.addDep(mk ?? key(file, s.parent), {
              from,
              kind: "REFERENCES",
              provenance: "static",
              confidence: mk ? "high" : "medium",
            });
          }
        }
        if (s.kind === "class" && !s.parent && s.extends && !test) {
          const t = this.localTarget(file, s.extends.split(/[<(]/)[0] as string);
          const target =
            t &&
            !("namespace" in t) &&
            t.unit !== WHOLE &&
            this.topSymbol(t.file, t.unit)?.kind === "class"
              ? key(t.file, `${t.unit}.${INIT}`)
              : undefined;
          if (target)
            this.addDep(target, {
              from: key(file, s.qualifiedName),
              kind: "EXTENDS",
              provenance: "static",
              confidence: "high",
            });
          else if (t && "namespace" in t)
            this.addFileDep(t.file, {
              from: key(file, s.qualifiedName),
              kind: "EXTENDS",
              provenance: "static",
              confidence: "medium",
            });
        }
      }
      // Analyses without member uses (older analyzer) treat every reference as an escape.
      const hasMemberInfo =
        a.topLevelUses !== undefined ||
        a.topLevelEscapes !== undefined ||
        !["ts-1", "ts-2"].includes(a.analyzerVersion);
      this.link(
        file,
        key(file, WHOLE),
        a.topLevelRefs,
        a.topLevelUses ?? [],
        a.topLevelEscapes ?? (hasMemberInfo ? [] : a.topLevelRefs),
        kind,
      );
      this.linkResources(key(file, WHOLE), a.topLevelResources);
    }
  }

  get stats(): { files: number; edges: number; memberEdges: number; uncertainFiles: number } {
    return {
      files: this.files.size,
      edges: this.edgeCount,
      memberEdges: this.memberEdgeCount,
      uncertainFiles: this.uncertainty.size,
    };
  }

  /**
   * Seeds for changed resource keys. Keys nobody reads specifically are returned as `unmatched`
   * (readers of "any key", such as code passing `process.env` around, are still seeded).
   */
  resourceSeeds(
    kind: string,
    keys: readonly string[],
  ): { seed: Seed | undefined; unmatched: string[] } {
    const units = new Set<string>();
    const unmatched: string[] = [];
    const wildcard = `${kind}:*`;
    for (const k of keys) {
      let hit = false;
      for (const r of this.resourceKeys) {
        if (r === wildcard || !r.startsWith(`${kind}:`)) continue;
        const reader = r.slice(kind.length + 1);
        if (kind === "i18n" ? i18nKeyMatches(reader, k) : reader === k) {
          units.add(r);
          hit = true;
        }
      }
      if (!hit) unmatched.push(k);
    }
    if (keys.length && this.resourceKeys.has(wildcard)) units.add(wildcard);
    return {
      seed: units.size ? { file: RESOURCE, units: [...units].sort() } : undefined,
      unmatched,
    };
  }

  /** Units that read a non-source file through `fs` (fixtures, templates, SQL…). */
  assetReaders(path: string): Seed[] {
    const byFile = new Map<string, Set<string>>();
    for (const r of this.assetReads) {
      if (r.pattern === path || (r.pattern.includes("*") && matchGlob(path, r.pattern))) {
        const [file, unit] = splitKey(r.from);
        const set = byFile.get(file) ?? new Set();
        set.add(unit);
        byFile.set(file, set);
      }
    }
    return [...byFile].map(([file, units]) => ({ file, units: [...units] }));
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

  // ── traversal ───────────────────────────────────────────────────────────────────────────

  /**
   * Reverse traversal from changed units to everything that depends on them (cycle-safe BFS).
   * A test that replaces a module with a factory mock never runs that module's code, so paths
   * through it do not count for that test (unless the seed changes the module's signature).
   */
  dependentsOf(seeds: readonly Seed[]): TraversalResult {
    const result = this.traverse(seeds, new Set());
    if (!this.factoryMocks.size) return result;
    const rerun = new Map<string, TraversalResult>();
    for (const [test, hit] of [...result.tests]) {
      const mocked = this.factoryMocks.get(test);
      if (!mocked || !hit.files.some((f) => mocked.has(f))) continue;
      const blocked = new Set(
        [...mocked].filter((m) => !seeds.some((s) => s.file === m && s.signature)),
      );
      if (!hit.files.some((f) => blocked.has(f))) continue;
      const cacheKey = [...blocked].sort().join("|");
      let r = rerun.get(cacheKey);
      if (!r) {
        r = this.traverse(seeds, blocked);
        rerun.set(cacheKey, r);
      }
      const alt = r.tests.get(test);
      if (alt) result.tests.set(test, alt);
      else result.tests.delete(test);
    }
    return result;
  }

  /** Whether any test depends on these seeds (stops at the first one). */
  reachesAnyTest(seeds: readonly Seed[]): boolean {
    return this.traverse(seeds, new Set(), true).tests.size > 0;
  }

  private traverse(
    seeds: readonly Seed[],
    blocked: ReadonlySet<string>,
    stopAtFirstTest = false,
  ): TraversalResult & { tests: Map<string, TestHit & { files: string[] }> } {
    const referencesOnly = new Set(seeds.filter((s) => s.referencesOnly).map((s) => s.file));
    const parent = new Map<string, { from: string | undefined; confidence: Confidence }>();
    const queue: string[] = [];
    let head = 0;
    const push = (k: string, from: string | undefined, confidence: Confidence = "high") => {
      if (parent.has(k)) return;
      const inherited = from ? (parent.get(from)?.confidence ?? "high") : "high";
      parent.set(k, { from, confidence: weakest(inherited, confidence) });
      queue.push(k);
    };
    for (const s of seeds)
      for (const u of s.units.length ? s.units : [WHOLE]) push(key(s.file, u), undefined);

    const tests = new Map<string, TestHit & { files: string[] }>();
    const affectedFiles = new Set<string>();
    const affectedUnits = new Set<string>();
    const label = (k: string) => {
      const [file, unit] = splitKey(k);
      if (file === RESOURCE) return unit;
      return unit === WHOLE || unit === ANY
        ? file
        : `${file}#${unit.replace(`.${INIT}`, ".constructor")}`;
    };
    const pathOfKey = (k: string): string[] => {
      const out: string[] = [];
      let cur: string | undefined = k;
      while (cur !== undefined) {
        const l = label(cur);
        if (out[0] !== l) out.unshift(l);
        cur = parent.get(cur)?.from;
      }
      // "file → file#Unit" is one hop, not two: keep the more precise label.
      if (out.length > 1 && !out[0]?.includes("#") && out[1]?.startsWith(`${out[0]}#`)) out.shift();
      return out;
    };
    const firstKeyOfFile = new Map<string, string>();
    const pushDeps = (target: string, from: string) => {
      for (const d of this.deps.get(target) ?? []) push(d.from, from, d.confidence);
    };

    while (head < queue.length) {
      const k = queue[head++] as string;
      const [file, unit] = splitKey(k);
      affectedFiles.add(file);
      if (!firstKeyOfFile.has(file)) firstKeyOfFile.set(file, k);
      if (this.isTest(file)) {
        if (!tests.has(file)) {
          const path = pathOfKey(k);
          const files: string[] = [];
          for (let c = parent.get(k)?.from; c !== undefined; c = parent.get(c)?.from)
            files.push(splitKey(c)[0]);
          tests.set(file, {
            test: file,
            path,
            depth: path.length - 1,
            confidence: parent.get(k)?.confidence ?? "high",
            files,
          });
          if (stopAtFirstTest) break;
        }
        continue;
      }
      if (blocked.has(file)) continue;
      affectedUnits.add(k);
      const a = this.files.get(file);
      if (file === RESOURCE) {
        pushDeps(k, k);
        continue;
      }
      if (unit === WHOLE) {
        for (const s of a ? topLevelSymbols(a) : []) push(key(file, s.qualifiedName), k);
        pushDeps(k, k);
        if (!referencesOnly.has(file))
          for (const importer of this.moduleDependents.get(file) ?? []) push(importer, k);
      } else if (unit === ANY) {
        // only file-level dependents and re-exporters below
      } else if (unit.includes(".")) {
        const cls = unit.slice(0, unit.indexOf("."));
        pushDeps(k, k);
        pushDeps(key(file, cls), k); // imprecise users of the class
      } else {
        const sym = a ? this.topSymbol(file, unit) : undefined;
        if (sym?.kind === "class" && a) {
          for (const m of a.symbols) if (m.parent === unit) push(key(file, `${unit}.${m.name}`), k);
          push(key(file, `${unit}.${INIT}`), k);
        }
        pushDeps(k, k);
      }
      for (const d of this.fileDependents.get(file) ?? [])
        if (
          !referencesOnly.has(file) ||
          d.confidence === "high" ||
          this.isTest(splitKey(d.from)[0])
        )
          push(d.from, k, d.confidence);
      for (const g of this.reexporters.get(file) ?? []) push(key(g, ANY), k);
    }
    return {
      tests,
      affectedFiles,
      affectedUnits,
      pathTo: (file: string) => {
        const k = firstKeyOfFile.get(file);
        return k ? pathOfKey(k) : undefined;
      },
    };
  }

  // ── queries ─────────────────────────────────────────────────────────────────────────────

  /** Shortest dependency path from a changed unit (`file` or `file#Unit`) to another file. */
  why(from: string, to: string): string[] | undefined {
    const [file, unit] = from.includes("#") ? (from.split("#") as [string, string]) : [from, WHOLE];
    return this.dependentsOf([{ file, units: [unit] }]).pathTo(to.split("#")[0] as string);
  }

  /** Import cycles (strongly connected components with more than one file, or self-imports). */
  cycles(): string[][] {
    let index = 0;
    const idx = new Map<string, number>();
    const low = new Map<string, number>();
    const stack: string[] = [];
    const onStack = new Set<string>();
    const out: string[][] = [];
    const strong = (v: string) => {
      idx.set(v, index);
      low.set(v, index);
      index++;
      stack.push(v);
      onStack.add(v);
      for (const w of this.forward.get(v) ?? []) {
        if (!this.files.has(w)) continue;
        if (!idx.has(w)) {
          strong(w);
          low.set(v, Math.min(low.get(v) as number, low.get(w) as number));
        } else if (onStack.has(w)) low.set(v, Math.min(low.get(v) as number, idx.get(w) as number));
      }
      if (low.get(v) === idx.get(v)) {
        const comp: string[] = [];
        let w: string;
        do {
          w = stack.pop() as string;
          onStack.delete(w);
          comp.push(w);
        } while (w !== v);
        if (comp.length > 1 || this.forward.get(v)?.has(v)) out.push(comp.sort());
      }
    };
    for (const f of [...this.files.keys()].sort()) if (!idx.has(f)) strong(f);
    return out.sort((a, b) => b.length - a.length);
  }

  /** Source files that no test reaches through static dependencies. */
  orphans(testFiles: readonly string[]): string[] {
    const reached = new Set<string>();
    for (const t of testFiles) for (const f of this.dependenciesOf(t)) reached.add(f);
    return [...this.files.keys()].filter((f) => !this.isTest(f) && !reached.has(f)).sort();
  }

  /** Nodes and edges for export (JSON/DOT) and visualisation (spec §10.8). */
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
      for (const s of a.symbols) {
        const id = key(file, s.parent ? `${s.parent}.${s.name}` : s.qualifiedName);
        nodes.push({
          id,
          kind:
            s.kind === "class"
              ? "class"
              : s.kind === "method"
                ? "method"
                : s.kind === "function"
                  ? "function"
                  : "module",
          label: s.qualifiedName,
          filePath: file,
        });
      }
    }
    const clean = (k: string) => k.replace(/#\*$/, "");
    for (const [target, ds] of this.deps)
      for (const d of ds)
        edges.push({
          from: clean(d.from),
          to: target,
          kind: d.kind,
          provenance: d.provenance,
          confidence: d.confidence,
        });
    for (const [target, ds] of this.fileDependents)
      for (const d of ds)
        edges.push({
          from: clean(d.from),
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

function posixNormalize(p: string): string {
  const out: string[] = [];
  for (const part of p.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === ".." && out.length && out[out.length - 1] !== "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}
