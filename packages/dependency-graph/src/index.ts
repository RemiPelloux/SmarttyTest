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
import { type RouteDef, routeMatches, routeUnder } from "./routes.js";

export { nextRoutes, type RouteDef, routeMatches, routeUnder } from "./routes.js";

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

export interface GraphOptions {
  /** Routes from framework conventions (see routes.ts). */
  routes?: readonly RouteDef[];
  /** Test files run by end-to-end runners (Playwright, Cypress). */
  e2eTests?: ReadonlySet<string>;
  /** Edges and unresolved relationships from plugin edge providers (Plugin SDK v1). */
  provided?: ProvidedGraphInput;
}

/** Plugin edge-provider output, already validated and made project-relative by the caller. */
export interface ProvidedGraphInput {
  edges: readonly {
    from: string;
    to: string;
    kind: GraphEdge["kind"];
    confidence: Confidence;
    provider: string;
  }[];
  /** Files holding relationships a provider could not resolve: they become uncertainty. */
  unresolved: readonly { file: string; reason: string }[];
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

/** Version of `serialize()` output; bump on any change to it or to how the graph is built. */
export const GRAPH_FORMAT = 2;

interface SerializedGraph {
  format: number;
  deps: number[];
  fileDependents: number[];
  moduleDependents: number[];
  reexporters: number[];
  forward: number[];
  factoryMocks: number[];
  uncertainty: [string, string[]][];
  deletedFiles: string[];
  resourceKeys: string[];
  assetReads: [string, string][];
  waspOps: [string, [string, string, string][]][];
  edgeCount: number;
  /** [file, member edges it contributed]* */
  memberEdges: number[];
  edgeKinds: [string, string, string][];
  strings: string[];
}

/** Set by `DependencyGraph.restore` for the constructor call it makes. */
let restoring: SerializedGraph | undefined;

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
  /** Files reaching uncertainty → how many uncertain files they reach (computed on first use). */
  private reachingUncertainty: Map<string, number> | undefined;
  private importersByFile: Map<string, string[]> | undefined;
  readonly uncertainty = new Map<string, string[]>();
  readonly deletedFiles = new Set<string>();
  private edgeCount = 0;
  /** Member-level edges per contributing file (patches subtract what they remove). */
  private memberEdges = new Map<string, number>();
  private resourceKeys = new Set<string>();
  private assetReads: { pattern: string; from: string }[] = [];
  /** Files a test replaces with a factory mock (`vi.mock("./m", () => …)`): never loaded there. */
  private factoryMocks = new Map<string, Set<string>>();
  private waspOps = new Map<string, Map<string, { file: string; unit: string }>>();
  /** Test-named files no runner collects that other files import: helpers, walked through. */
  private helpers = new Set<string>();
  /** Files a runner collects, whatever their name (`test/math.js`, `checks/a.ts`, `*.setup.js`). */
  private collected = new Set<string>();

  constructor(
    private readonly files: ReadonlyMap<string, FileAnalysis>,
    private readonly isTest: (path: string) => boolean,
    private readonly options: GraphOptions = {},
  ) {
    const restore = restoring;
    restoring = undefined;
    if (restore) {
      this.restore(restore);
      return;
    }
    this.build();
    this.linkRoutes();
    this.linkProvided();
  }

  /**
   * Plugin edges: `from` depends on the whole of `to`. They only add dependents (a provider can
   * never remove an edge), and what a provider could not resolve is uncertainty.
   */
  private linkProvided(): void {
    const p = this.options.provided;
    if (!p) return;
    for (const e of p.edges) {
      if (e.from === e.to) continue;
      let fwd = this.forward.get(e.from);
      if (!fwd) {
        fwd = new Set();
        this.forward.set(e.from, fwd);
      }
      fwd.add(e.to);
      this.addFileDep(e.to, {
        from: key(e.from, WHOLE),
        kind: e.kind,
        provenance: "plugin",
        confidence: e.confidence,
      });
    }
    for (const u of p.unresolved)
      this.uncertainty.set(u.file, [...(this.uncertainty.get(u.file) ?? []), u.reason]);
  }

  /** Whether plugin edge providers contributed edges or uncertainty. */
  private get hasProvided(): boolean {
    const p = this.options.provided;
    return !!p && (p.edges.length > 0 || p.unresolved.length > 0);
  }

  /**
   * End-to-end specs reach the pages they visit: a visited URL is linked to the route files that
   * serve it (and their layouts and middleware). A spec whose visits cannot all be matched is
   * uncertain, so it is never ruled out.
   */
  private linkRoutes(): void {
    const routes = this.options.routes ?? [];
    const pages = routes.filter((r) => r.kind === "page" || r.kind === "api");
    const unmatched = new Set<string>();
    for (const v of this.resourceKeys) {
      if (!v.startsWith("route:")) continue;
      const url = v.slice("route:".length);
      if (url === "*") {
        unmatched.add(v);
        continue;
      }
      const hits = pages.filter((p) => routeMatches(url, p.route));
      if (!hits.length) unmatched.add(v);
      for (const p of hits) {
        const dep = {
          from: key(RESOURCE, v),
          kind: "REFERENCES" as const,
          provenance: "static" as const,
          confidence: "medium" as const,
        };
        this.addFileDep(p.file, dep);
        for (const l of routes)
          if ((l.kind === "layout" || l.kind === "middleware") && routeUnder(p.route, l.route))
            this.addFileDep(l.file, dep);
      }
    }
    for (const t of this.options.e2eTests ?? []) {
      const a = this.files.get(t);
      if (!a) continue;
      const visits = [
        ...new Set([
          ...(a.topLevelResources ?? []),
          ...a.symbols.flatMap((s) => s.resources ?? []),
        ]),
      ].filter((r) => r.startsWith("route:"));
      const reasons: string[] = [];
      if (!visits.length && !(this.forward.get(t)?.size ?? 0))
        reasons.push("end-to-end spec with no page visits SmartTest can read and no imports");
      for (const v of visits)
        if (unmatched.has(v))
          reasons.push(
            v === "route:*"
              ? "visits a URL built at run time"
              : `visits ${v.slice(6)}, which no known route serves`,
          );
      if (reasons.length) this.uncertainty.set(t, [...(this.uncertainty.get(t) ?? []), ...reasons]);
    }
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

  /** Targets each file contributed edges to (so a patch touches only those). */
  private contributions = new Map<string, { deps: Set<string>; fileDeps: Set<string> }>();
  /** A restored graph derives `contributions` from its edges on its first patch. */
  private contributionsPending = false;

  private contributed(from: string) {
    const file = from.slice(0, from.indexOf("#"));
    let c = this.contributions.get(file);
    if (!c) {
      c = { deps: new Set(), fileDeps: new Set() };
      this.contributions.set(file, c);
    }
    return c;
  }

  private countMemberEdge(file: string): void {
    this.memberEdges.set(file, (this.memberEdges.get(file) ?? 0) + 1);
  }

  private addDep(target: string, dep: Dep): void {
    const list = this.deps.get(target);
    if (list) list.push(dep);
    else this.deps.set(target, [dep]);
    this.contributed(dep.from).deps.add(target);
    this.edgeCount++;
  }

  private addFileDep(target: string, dep: Dep): void {
    const list = this.fileDependents.get(target);
    if (list) list.push(dep);
    else this.fileDependents.set(target, [dep]);
    this.contributed(dep.from).fileDeps.add(target);
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
            this.countMemberEdge(file);
            for (const c of this.topSymbol(r.file, r.unit)?.instanceOf ?? [])
              this.linkInstance(r.file, c, undefined, dep());
          } else this.addFileDep(t.file, dep("medium"));
        }
        continue;
      }
      if (t.unit === WHOLE) {
        this.addFileDep(t.file, dep("medium"));
        continue;
      }
      const sym = this.topSymbol(t.file, t.unit);
      // A module-level instance (`export const repo = new MemRepo()`): its users reach the
      // members of its class, not only its construction.
      // A name that is neither used through a member nor escapes is only referenced (a type
      // position, or a same-file use already resolved to the class by the analyzer).
      if (sym && sym.kind !== "class" && sym.instanceOf?.length) {
        this.addDep(key(t.file, t.unit), dep());
        if (escaped.has(name) || members?.size) {
          const reached = escaped.has(name) ? undefined : members;
          for (const c of sym.instanceOf) this.linkInstance(t.file, c, reached, dep());
        }
        continue;
      }
      // Members used through an interface or type: linked per member, so a change to an
      // implementation of that member reaches them (see `supertypes`).
      if (sym && isTypeOnly(sym) && !escaped.has(name) && members?.size) {
        this.addDep(key(t.file, t.unit), dep());
        for (const m of members) this.addDep(key(t.file, `${t.unit}.${m}`), dep());
        continue;
      }
      const isClass = sym?.kind === "class";
      if (!isClass || escaped.has(name) || !members?.size) {
        this.addDep(key(t.file, t.unit), dep());
        continue;
      }
      for (const m of members) {
        const mk = this.memberKey(t.file, t.unit, m);
        if (mk) this.countMemberEdge(file);
        this.addDep(mk ?? key(t.file, t.unit), dep());
      }
    }
  }

  /**
   * Links a user of an instance of `cls` (named in `file`) to the members it uses, or to the whole
   * class when `members` is undefined or empty (the instance escapes: any member is reachable).
   */
  private linkInstance(
    file: string,
    cls: string,
    members: ReadonlySet<string> | undefined,
    d: Dep,
  ): void {
    const t = this.localTarget(file, cls);
    if (!t) return;
    if ("namespace" in t || t.unit === WHOLE) {
      this.addFileDep(t.file, { ...d, confidence: "medium" });
      return;
    }
    const sym = this.topSymbol(t.file, t.unit);
    if (!members?.size || !sym) {
      this.addDep(key(t.file, t.unit), d);
      return;
    }
    for (const m of members) {
      const mk =
        sym.kind === "class"
          ? this.memberKey(t.file, t.unit, m)
          : isTypeOnly(sym)
            ? key(t.file, `${t.unit}.${m}`)
            : undefined;
      this.addDep(mk ?? key(t.file, t.unit), d);
    }
  }

  /**
   * Classes and interfaces a class or interface extends or implements, transitively. A call
   * through a receiver typed by one of them may run this type's member.
   */
  private supertypes(
    file: string,
    sym: SymbolRecord,
    seen = new Set<string>(),
  ): { file: string; unit: string }[] {
    const out: { file: string; unit: string }[] = [];
    for (const raw of [sym.extends, ...(sym.implements ?? [])]) {
      const name = raw?.split(/[<(]/)[0]?.trim();
      if (!name || !/^[A-Za-z_$][\w$]*$/.test(name)) continue;
      const t = this.localTarget(file, name);
      if (!t || "namespace" in t || t.unit === WHOLE) continue;
      const k = key(t.file, t.unit);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ file: t.file, unit: t.unit });
      const s = this.topSymbol(t.file, t.unit);
      if (s && (s.kind === "class" || s.kind === "interface"))
        out.push(...this.supertypes(t.file, s, seen));
    }
    return out;
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
    for (const [file, a] of this.files) this.buildFile(file, a);
  }

  /**
   * Incremental update after `changed` files were re-analysed (the `files` map already holds the
   * new analyses): the edges these files contribute are removed and rebuilt. Only valid when what
   * other files see of them is unchanged (imports, exports, declarations); the caller checks
   * that and rebuilds otherwise. Returns false when a patch is not possible here.
   */
  patch(changed: readonly string[]): boolean {
    const set = new Set(changed);
    if (!set.size) return true;
    // Provider output is recomputed for each analysis: the graph is rebuilt with it.
    if (this.hasProvided) return false;
    for (const f of set) {
      const a = this.files.get(f);
      if (!a) return false;
      // End-to-end specs carry uncertainty computed over the whole graph (linkRoutes).
      if (this.options.e2eTests?.has(f)) return false;
      const routeFile = (this.options.routes ?? []).some((r) => r.file === f);
      const visits = [
        ...(a.topLevelResources ?? []),
        ...a.symbols.flatMap((s) => s.resources ?? []),
      ].some((r) => r.startsWith("route:"));
      if (routeFile || visits || /(^|\/)main\.wasp\.(ts|js|mts)$/.test(f)) return false;
    }
    if (this.contributionsPending) {
      this.contributionsPending = false;
      for (const [target, list] of this.deps)
        for (const d of list) this.contributed(d.from).deps.add(target);
      for (const [target, list] of this.fileDependents)
        for (const d of list) this.contributed(d.from).fileDeps.add(target);
    }
    const fromChanged = (from: string) => set.has(from.slice(0, from.indexOf("#")));
    let removed = 0;
    for (const f of set) {
      const c = this.contributions.get(f);
      if (!c) continue;
      for (const target of c.deps) {
        const list = this.deps.get(target) ?? [];
        const kept = list.filter((d) => !fromChanged(d.from));
        removed += list.length - kept.length;
        if (kept.length) this.deps.set(target, kept);
        else this.deps.delete(target);
      }
      for (const target of c.fileDeps) {
        const list = this.fileDependents.get(target) ?? [];
        const kept = list.filter((d) => !fromChanged(d.from));
        removed += list.length - kept.length;
        if (kept.length) this.fileDependents.set(target, kept);
        else this.fileDependents.delete(target);
      }
      this.contributions.delete(f);
      // The modules it loaded before (its forward set also holds Wasp operations, which have no
      // resolved import of their own) and the ones it loads now.
      const loaded = new Set(this.forward.get(f) ?? []);
      for (const imp of this.files.get(f)?.imports ?? [])
        if (imp.resolved) loaded.add(imp.resolved);
      for (const target of loaded) {
        const list = this.moduleDependents.get(target);
        if (list)
          this.moduleDependents.set(
            target,
            list.filter((k) => !fromChanged(k)),
          );
      }
    }
    for (const files of this.reexporters.values()) for (const f of set) files.delete(f);
    this.assetReads = this.assetReads.filter((r) => !fromChanged(r.from));
    for (const f of set) {
      this.forward.delete(f);
      this.memberEdges.delete(f);
      this.factoryMocks.delete(f);
      this.uncertainty.delete(f);
      this.localCache.delete(f);
      this.exportCache.delete(f);
    }
    this.forwardClosure.clear();
    this.reachingUncertainty = undefined;
    this.importersByFile = undefined;
    this.edgeCount -= removed;
    for (const f of set) this.buildFile(f, this.files.get(f) as FileAnalysis);
    return true;
  }

  /** Edges contributed by one file (its imports, references, member uses and resources). */
  private buildFile(file: string, a: FileAnalysis): void {
    const test = this.isTest(file);
    const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/") + 1) : "";
    for (const r of a.assetReads ?? []) {
      const from = key(file, test ? WHOLE : r.unit);
      // `process.cwd()/…`: the runner's directory, one of the directories above the file.
      if (r.pattern.startsWith("@cwd/")) {
        const rest = r.pattern.slice("@cwd/".length);
        const parts = dir.split("/").filter(Boolean);
        for (let i = 0; i <= parts.length; i++) {
          const base = parts.slice(0, i).join("/");
          this.assetReads.push({ pattern: posixNormalize(base ? `${base}/${rest}` : rest), from });
        }
        continue;
      }
      const pattern = posixNormalize(`${dir}${r.pattern}`);
      if (!pattern.startsWith("..")) this.assetReads.push({ pattern, from });
    }
    if (test) {
      const actual = new Set(
        a.imports.filter((i) => i.mock === "actual" || i.mock === "unmock").map((i) => i.resolved),
      );
      const mocked = a.imports
        .filter(
          (i) => i.kind === "mock" && i.mock === "factory" && i.resolved && !actual.has(i.resolved),
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
      // Wasp's generated operations module loads every operation of the app: code an operation
      // runs when it loads reaches this importer, whichever operations it names (found by
      // `smarttest audit --traces` on the edges-vitest fixture).
      if (!imp.resolved && !imp.typeOnly && WASP_OPERATION_MODULES.has(imp.specifier)) {
        const ops = new Set([...(this.waspOperationsFor(file)?.values() ?? [])].map((o) => o.file));
        for (const op of ops) {
          fwd.add(op);
          const list = this.moduleDependents.get(op);
          if (list) list.push(key(file, WHOLE));
          else this.moduleDependents.set(op, [key(file, WHOLE)]);
        }
        continue;
      }
      if (!imp.resolved) continue;
      fwd.add(imp.resolved);
      if (imp.missing) this.deletedFiles.add(imp.resolved);
      if (!imp.typeOnly) {
        const list = this.moduleDependents.get(imp.resolved);
        if (list) list.push(key(file, WHOLE));
        else this.moduleDependents.set(imp.resolved, [key(file, WHOLE)]);
      }
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
    // A test file's own symbols keep their units like any file's: a test can export a helper
    // another test imports, and the walk through it follows the same symbol rules.
    for (const s of a.symbols) {
      const from = key(file, s.parent ? `${s.parent}.${s.name}` : s.qualifiedName);
      this.link(file, from, s.refs, s.uses ?? [], s.escapes ?? [], kind);
      this.linkResources(from, s.resources);
      if (s.parent) {
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
      if (s.kind === "class" && !s.parent && s.extends) {
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

  get stats(): { files: number; edges: number; memberEdges: number; uncertainFiles: number } {
    return {
      files: this.files.size,
      edges: this.edgeCount,
      memberEdges: [...this.memberEdges.values()].reduce((a, b) => a + b, 0),
      uncertainFiles: this.uncertainty.size,
    };
  }

  // ── persistence ─────────────────────────────────────────────────────────────────────────

  /**
   * The built graph as compact JSON (a string table and integer arrays). It describes the graph
   * built from exactly the analyses and options it was built with: the caller keys and validates
   * it (see `DependencyGraph.restore`). Caches (closures, export maps) are not included.
   */
  serialize(): string {
    const ids = new Map<string, number>();
    const strings: string[] = [];
    const id = (k: string) => {
      let i = ids.get(k);
      if (i === undefined) {
        i = strings.length;
        strings.push(k);
        ids.set(k, i);
      }
      return i;
    };
    const codes = new Map<string, number>();
    const edgeKinds: [string, string, string][] = [];
    const code = (d: Dep) => {
      const k = `${d.kind}|${d.provenance}|${d.confidence}`;
      let c = codes.get(k);
      if (c === undefined) {
        c = edgeKinds.length;
        edgeKinds.push([d.kind, d.provenance, d.confidence]);
        codes.set(k, c);
      }
      return c;
    };
    const edges = (m: Map<string, Dep[]>) => {
      const out: number[] = [];
      for (const [target, list] of m) {
        out.push(id(target), list.length);
        for (const d of list) out.push(id(d.from), code(d));
      }
      return out;
    };
    const lists = (m: Map<string, Iterable<string>>) => {
      const out: number[] = [];
      for (const [k, values] of m) {
        const v = [...values];
        out.push(id(k), v.length);
        for (const x of v) out.push(id(x));
      }
      return out;
    };
    const data: SerializedGraph = {
      format: GRAPH_FORMAT,
      deps: edges(this.deps),
      fileDependents: edges(this.fileDependents),
      moduleDependents: lists(this.moduleDependents),
      reexporters: lists(this.reexporters),
      forward: lists(this.forward),
      factoryMocks: lists(this.factoryMocks),
      uncertainty: [...this.uncertainty],
      deletedFiles: [...this.deletedFiles],
      resourceKeys: [...this.resourceKeys],
      assetReads: this.assetReads.map((r) => [r.pattern, r.from]),
      waspOps: [...this.waspOps].map(([dir, ops]) => [
        dir,
        [...ops].map(([name, t]) => [name, t.file, t.unit]),
      ]),
      edgeCount: this.edgeCount,
      memberEdges: [...this.memberEdges].flatMap(([f, n]) => [id(f), n]),
      edgeKinds,
      strings,
    };
    return JSON.stringify(data);
  }

  /**
   * Rebuilds a graph from `serialize()` output for the same analyses and options. Returns
   * undefined when the text is not a complete graph of this format (the caller then builds).
   */
  static restore(
    files: ReadonlyMap<string, FileAnalysis>,
    isTest: (path: string) => boolean,
    options: GraphOptions,
    text: string,
  ): DependencyGraph | undefined {
    let data: SerializedGraph;
    try {
      data = JSON.parse(text) as SerializedGraph;
      if (data?.format !== GRAPH_FORMAT || !Array.isArray(data.strings)) return undefined;
      restoring = data;
      return new DependencyGraph(files, isTest, options);
    } catch {
      return undefined;
    } finally {
      restoring = undefined;
    }
  }

  /** Throws on any malformed part, so a damaged store is never half-used. */
  private restore(data: SerializedGraph): void {
    const { strings } = data;
    const str = (i: unknown): string => {
      const s = strings[i as number];
      if (typeof s !== "string") throw new Error("graph store: bad string reference");
      return s;
    };
    const ints = (a: unknown): number[] => {
      if (!Array.isArray(a)) throw new Error("graph store: bad section");
      return a as number[];
    };
    const kinds = data.edgeKinds.map(([kind, provenance, confidence]) => ({
      kind: kind as GraphEdge["kind"],
      provenance: provenance as Provenance,
      confidence: confidence as Confidence,
    }));
    const edges = (a: unknown, into: Map<string, Dep[]>) => {
      const xs = ints(a);
      for (let i = 0; i < xs.length; ) {
        const target = str(xs[i++]);
        const n = xs[i++] as number;
        if (!Number.isInteger(n) || n < 0 || i + 2 * n > xs.length)
          throw new Error("graph store: bad edge list");
        const list: Dep[] = new Array(n);
        for (let j = 0; j < n; j++) {
          const from = str(xs[i++]);
          const k = kinds[xs[i++] as number];
          if (!k) throw new Error("graph store: bad edge kind");
          list[j] = { from, kind: k.kind, provenance: k.provenance, confidence: k.confidence };
        }
        into.set(target, list);
      }
    };
    const lists = (a: unknown, put: (k: string, values: string[]) => void) => {
      const xs = ints(a);
      for (let i = 0; i < xs.length; ) {
        const k = str(xs[i++]);
        const n = xs[i++] as number;
        if (!Number.isInteger(n) || n < 0 || i + n > xs.length)
          throw new Error("graph store: bad list");
        const values: string[] = new Array(n);
        for (let j = 0; j < n; j++) values[j] = str(xs[i++]);
        put(k, values);
      }
    };
    edges(data.deps, this.deps);
    edges(data.fileDependents, this.fileDependents);
    lists(data.moduleDependents, (k, v) => this.moduleDependents.set(k, v));
    lists(data.reexporters, (k, v) => this.reexporters.set(k, new Set(v)));
    lists(data.forward, (k, v) => this.forward.set(k, new Set(v)));
    lists(data.factoryMocks, (k, v) => this.factoryMocks.set(k, new Set(v)));
    const text = (x: unknown): string => {
      if (typeof x !== "string") throw new Error("graph store: bad string");
      return x;
    };
    for (const [file, reasons] of data.uncertainty)
      this.uncertainty.set(text(file), reasons.map(text));
    for (const f of data.deletedFiles) this.deletedFiles.add(text(f));
    for (const r of data.resourceKeys) this.resourceKeys.add(text(r));
    this.assetReads = data.assetReads.map(([pattern, from]) => ({ pattern, from }));
    for (const [dir, ops] of data.waspOps)
      this.waspOps.set(dir, new Map(ops.map(([name, file, unit]) => [name, { file, unit }])));
    if (!Number.isInteger(data.edgeCount)) throw new Error("graph store: bad counts");
    this.edgeCount = data.edgeCount;
    const members = ints(data.memberEdges);
    for (let i = 0; i < members.length; i += 2) {
      const n = members[i + 1];
      if (!Number.isInteger(n)) throw new Error("graph store: bad counts");
      this.memberEdges.set(str(members[i]), n as number);
    }
    this.contributionsPending = true;
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

  /** Importers of each file: the `forward` edges reversed (computed once). */
  private reverseForward(): Map<string, string[]> {
    if (this.importersByFile) return this.importersByFile;
    const reverse = new Map<string, string[]>();
    for (const [from, tos] of this.forward)
      for (const to of tos) {
        const list = reverse.get(to);
        if (list) list.push(from);
        else reverse.set(to, [from]);
      }
    this.importersByFile = reverse;
    return reverse;
  }

  /**
   * Files whose transitive imports (`dependenciesOf`) include a file matching `matches`, in one
   * backward pass instead of a closure per file. A matching file is in the result only when it
   * also reaches another matching file, or itself through a cycle: callers that select a file
   * matching on its own test that separately.
   */
  filesDependingOn(matches: (file: string) => boolean): Set<string> {
    const reverse = this.reverseForward();
    const out = new Set<string>();
    const queue: string[] = [];
    for (const [file, importers] of reverse) {
      if (!matches(file)) continue;
      for (const i of importers)
        if (!out.has(i)) {
          out.add(i);
          queue.push(i);
        }
    }
    for (let q = 0; q < queue.length; q++)
      for (const i of reverse.get(queue[q] as string) ?? [])
        if (!out.has(i)) {
          out.add(i);
          queue.push(i);
        }
    return out;
  }

  /**
   * For each file reaching uncertainty, how many files with uncertainty it reaches (itself
   * included). One backward pass finds the files reaching any; then each strongly connected
   * component of them, dependencies first (Tarjan), carries the set of uncertain files it reaches
   * as a bit set: its own, and those of the components it imports.
   */
  private uncertaintyCounts(): Map<string, number> {
    if (this.reachingUncertainty) return this.reachingUncertainty;
    const reverse = this.reverseForward();
    const origins = [...this.uncertainty.keys()];
    const reach = new Set<string>(origins);
    const queue = [...origins];
    for (let q = 0; q < queue.length; q++)
      for (const importer of reverse.get(queue[q] as string) ?? [])
        if (!reach.has(importer)) {
          reach.add(importer);
          queue.push(importer);
        }
    const nodes = [...reach];
    const id = new Map(nodes.map((n, i) => [n, i]));
    const succ = nodes.map((n) => {
      const out: number[] = [];
      for (const to of this.forward.get(n) ?? []) {
        const j = id.get(to);
        if (j !== undefined) out.push(j);
      }
      return out;
    });
    const words = Math.ceil(origins.length / 32);
    const bitOf = new Map(origins.map((o, i) => [id.get(o) as number, i]));
    const n = nodes.length;
    const index = new Int32Array(n).fill(-1);
    const low = new Int32Array(n);
    const comp = new Int32Array(n).fill(-1);
    const onStack = new Uint8Array(n);
    const stack: number[] = [];
    const bits: Uint32Array[] = [];
    const counts = new Map<string, number>();
    let next = 0;
    for (let start = 0; start < n; start++) {
      if (index[start] !== -1) continue;
      // Iterative Tarjan: each frame is a node and the position in its successors.
      const frames: [number, number][] = [[start, 0]];
      index[start] = low[start] = next++;
      stack.push(start);
      onStack[start] = 1;
      while (frames.length) {
        const frame = frames[frames.length - 1] as [number, number];
        const v = frame[0];
        const edges = succ[v] as number[];
        if (frame[1] < edges.length) {
          const w = edges[frame[1]++] as number;
          if (index[w] === -1) {
            index[w] = low[w] = next++;
            stack.push(w);
            onStack[w] = 1;
            frames.push([w, 0]);
          } else if (onStack[w]) low[v] = Math.min(low[v] as number, index[w] as number);
          continue;
        }
        frames.pop();
        const parent = frames[frames.length - 1];
        if (parent) low[parent[0]] = Math.min(low[parent[0]] as number, low[v] as number);
        if (low[v] !== index[v]) continue;
        // v roots a component; every component it imports is complete.
        const c = bits.length;
        const set = new Uint32Array(words);
        const members: number[] = [];
        let w: number;
        do {
          w = stack.pop() as number;
          onStack[w] = 0;
          comp[w] = c;
          members.push(w);
        } while (w !== v);
        for (const m of members) {
          const b = bitOf.get(m);
          if (b !== undefined) set[b >>> 5] = (set[b >>> 5] as number) | (1 << (b & 31));
          for (const s of succ[m] as number[]) {
            const other = comp[s] as number;
            if (other === c) continue;
            const from = bits[other] as Uint32Array;
            for (let k = 0; k < words; k++) set[k] = (set[k] as number) | (from[k] as number);
          }
        }
        bits.push(set);
        let count = 0;
        for (let k = 0; k < words; k++) {
          let x = set[k] as number;
          while (x) {
            x &= x - 1;
            count++;
          }
        }
        for (const m of members) counts.set(nodes[m] as string, count);
      }
    }
    this.reachingUncertainty = counts;
    return counts;
  }

  /** How many files with uncertainty a file reaches, itself included. */
  uncertaintyCount(file: string): number {
    return this.uncertainty.size ? (this.uncertaintyCounts().get(file) ?? 0) : 0;
  }

  /**
   * Files (incl. the file itself) with uncertainty reachable from a file, in `dependenciesOf`
   * order. `limit` stops after that many. The walk enters only files that reach uncertainty
   * (a file that does not cannot lead to one), and stops once every uncertain file it reaches is
   * found, so the order matches a walk of the whole closure without building or keeping it.
   */
  uncertaintyReachableFrom(
    file: string,
    limit = Number.POSITIVE_INFINITY,
  ): { file: string; reasons: string[] }[] {
    if (!this.uncertainty.size) return [];
    const counts = this.uncertaintyCounts();
    const want = Math.min(counts.get(file) ?? 0, limit);
    if (want <= 0) return [];
    const out: { file: string; reasons: string[] }[] = [];
    const own = this.uncertainty.get(file);
    if (own) out.push({ file, reasons: own });
    // Same traversal as `dependenciesOf` (stack, same push order), pruned to files reaching
    // uncertainty: a pruned file's imports never reach it either, so the order of the rest holds.
    const seen = new Set<string>();
    const stack = [...(this.forward.get(file) ?? [])];
    while (stack.length && out.length < want) {
      const f = stack.pop() as string;
      if (seen.has(f) || f === file) continue;
      seen.add(f);
      if (!counts.has(f)) continue;
      const u = this.uncertainty.get(f);
      if (u) out.push({ file: f, reasons: u });
      for (const n of this.forward.get(f) ?? []) stack.push(n);
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
    const labels = new Map<string, string>();
    const label = (k: string) => {
      let l = labels.get(k);
      if (l === undefined) {
        const [file, unit] = splitKey(k);
        l =
          file === RESOURCE
            ? unit
            : unit === WHOLE || unit === ANY
              ? file
              : `${file}#${unit.replace(`.${INIT}`, ".constructor")}`;
        labels.set(k, l);
      }
      return l;
    };
    const pathOfKey = (k: string): string[] => {
      // Collected from the reached key back to its seed, then reversed (paths can be long).
      const out: string[] = [];
      let cur: string | undefined = k;
      while (cur !== undefined) {
        const l = label(cur);
        if (out[out.length - 1] !== l) out.push(l);
        cur = parent.get(cur)?.from;
      }
      out.reverse();
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
      const isTest = this.isTestFile(file);
      if (isTest) {
        if (!tests.has(file)) {
          const path = pathOfKey(k);
          // A path ends at the test file, whichever of its units it entered by.
          if (path.length > 1 && path[path.length - 1]?.startsWith(`${file}#`))
            path[path.length - 1] = file;
          const files: string[] = [];
          for (let c = parent.get(k)?.from; c !== undefined; c = parent.get(c)?.from)
            files.push(c.slice(0, c.indexOf("#")));
          tests.set(file, {
            test: file,
            path,
            depth: path.length - 1,
            confidence: parent.get(k)?.confidence ?? "high",
            files,
          });
          if (stopAtFirstTest) break;
        }
        // A test another file imports (a helper exported from a spec, `import { check } from
        // "./shared.test"`) protects its importers too: keep walking, with the same unit rules.
      }
      if (blocked.has(file)) continue;
      if (!isTest) affectedUnits.add(k);
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
        const member = unit.slice(cls.length + 1);
        const sym = a ? this.topSymbol(file, cls) : undefined;
        pushDeps(k, k);
        if (!sym || !isTypeOnly(sym)) pushDeps(key(file, cls), k); // imprecise users of the class
        // Overrides and implementations: a call through a receiver typed by a base class or an
        // interface (`repo: Repo`, `const s: Base = …`) may run this member.
        if (sym && member !== INIT && (sym.kind === "class" || sym.kind === "interface"))
          for (const sup of this.supertypes(file, sym))
            pushDeps(key(sup.file, `${sup.unit}.${member}`), k);
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
          this.isTestFile(splitKey(d.from)[0])
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

  /**
   * What test discovery found. `tests`: the files a runner collects, which are tests whatever
   * their name (Node runs `test/math.js`, a Vitest `include` can name `checks/*.ts`).
   * `helpers`: files named like tests that no runner collects but other files import
   * (`__tests__/render.tsx`); they never run, so a traversal goes through them to the tests that
   * import them.
   */
  setDiscovery(discovery: { tests?: Iterable<string>; helpers?: Iterable<string> }): void {
    this.collected = new Set(discovery.tests ?? []);
    this.helpers = new Set(discovery.helpers ?? []);
  }

  /**
   * A test file, as traversals see it: a file a runner collects, or (where no runner said) a file
   * named like a test, and never a helper.
   */
  isTestFile(path: string): boolean {
    return (this.collected.has(path) || this.isTest(path)) && !this.helpers.has(path);
  }

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
    return [...this.files.keys()].filter((f) => !this.isTestFile(f) && !reached.has(f)).sort();
  }

  /** Nodes and edges for export (JSON/DOT) and visualisation (spec §10.8). */
  toGraph(): { nodes: GraphNode[]; edges: GraphEdge[] } {
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    for (const [file, a] of this.files) {
      nodes.push({
        id: file,
        kind: this.isTestFile(file) ? "test-suite" : "file",
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

/** Interfaces and type aliases (not enums): they have no runtime members of their own. */
function isTypeOnly(s: SymbolRecord): boolean {
  return s.kind === "interface" || (s.kind === "type" && s.signature !== "enum");
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
