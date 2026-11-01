/**
 * @smarttest/symbol-index — persistent, incremental index of file analyses (spec §9.5).
 * Parsing is cached by content hash; module resolution is recomputed every update (cheap and
 * always consistent with added/removed files).
 */

import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import type { SourceRange } from "@smarttest/shared";
import {
  exists,
  matchGlob,
  readStateJson,
  removeStateFile,
  sha256,
  writeStateFile,
} from "@smarttest/shared";
import type {
  Analyzer,
  FileAnalysis,
  ModuleResolver,
  SymbolRecord,
} from "@smarttest/source-parser";
import { rangesOverlap, topLevelSymbols } from "@smarttest/source-parser";

export const INDEX_SCHEMA_VERSION = 2;
/** Source code (a graph node when indexed), as opposed to assets an import can also name. */
const CODE = /\.(?:[cm]?[jt]sx?)$/;

interface IndexFile {
  schemaVersion: number;
  /** Identifies this full write; a delta applies only to the base it names. */
  baseId?: string;
  contextKey?: string;
  stats?: Record<string, [number, number]>;
  files: Record<string, FileAnalysis>;
}

/**
 * Changes since the full index (`index.json`) was written, in `index-delta.json`: a run that
 * re-parses a few files writes these entries instead of the whole index. `null` = removed.
 */
interface IndexDelta {
  schemaVersion: number;
  baseId: string;
  stats: Record<string, [number, number] | null>;
  files: Record<string, FileAnalysis | null>;
}

/** A delta grows up to this many paths (or 2% of the files) before the full index is rewritten. */
const DELTA_MAX_PATHS = 64;

export interface UpdateStats {
  files: number;
  parsed: number;
  reused: number;
  removed: number;
  /** Every file was resolved again (resolution context or file set changed). */
  resolvedAll?: boolean;
  durationMs: number;
}

export interface UpdateOptions {
  root: string;
  files: readonly string[];
  analyzers: readonly Analyzer[];
  resolver: ModuleResolver;
  /** Fingerprint of everything that influences module resolution (tsconfig, package.json…). */
  contextKey?: string;
  /** Optional content overrides (e.g. "before" versions). */
  read?: (path: string) => Promise<string>;
  /**
   * Parses many files at once (worker threads). Used when at least `parallelThreshold` files need
   * parsing; analyses must be identical to the analyzers' own.
   */
  parseMany?: (jobs: { path: string; content: string }[]) => Promise<FileAnalysis[] | undefined>;
  parallelThreshold?: number;
  /**
   * `root` is a temporary checkout of `mirror.root` whose content differs only in `differs`
   * (root-relative). Stats are taken from the mirror for the other files, so a checkout with
   * fresh mtimes neither re-reads every file nor overwrites the mirror's recorded stats.
   */
  mirror?: { root: string; differs: ReadonlySet<string> };
}

export class SymbolIndex {
  private files = new Map<string, FileAnalysis>();
  private fileStats = new Map<string, [number, number]>();
  private contextKey: string | undefined;
  private dirty = false;
  /** Everything must be rewritten (resolution of every file may have changed). */
  private fullyDirty = false;
  /** Paths whose analysis or stats changed since the full index was written (delta entries). */
  private changedPaths = new Set<string>();
  private baseId: string | undefined;
  private warnings: string[] = [];

  private constructor(private readonly storePath: string | undefined) {}

  private get deltaPath(): string | undefined {
    return this.storePath?.replace(/index\.json$/, "index-delta.json");
  }

  private touch(path: string): void {
    this.changedPaths.add(path);
    this.dirty = true;
  }

  static inMemory(): SymbolIndex {
    return new SymbolIndex(undefined);
  }

  /** Loads a persisted index; corrupt or incompatible stores are rebuilt with a warning (ADR-0003). */
  static async load(storeDir: string): Promise<SymbolIndex> {
    const path = join(storeDir, "state", "index.json");
    const idx = new SymbolIndex(path);
    if (await exists(path)) {
      // Authenticated (state.ts): a planted or foreign index reads as corrupt and is rebuilt.
      const data = await readStateJson<IndexFile>(path);
      if (data && data.schemaVersion === INDEX_SCHEMA_VERSION && data.files) {
        for (const [k, v] of Object.entries(data.files)) idx.files.set(k, v);
        for (const [k, v] of Object.entries(data.stats ?? {})) idx.fileStats.set(k, v);
        idx.contextKey = data.contextKey;
        idx.baseId = data.baseId;
        if (data.baseId) await idx.applyDelta(data.baseId);
      } else {
        idx.warnings.push(
          "Local index was corrupt or from an incompatible version — rebuilt from scratch",
        );
      }
    }
    return idx;
  }

  /** Applies the delta written against this base, if any (a delta for another base is ignored). */
  private async applyDelta(baseId: string): Promise<void> {
    const path = this.deltaPath;
    const delta = path ? await readStateJson<IndexDelta>(path) : undefined;
    if (
      !delta ||
      delta.schemaVersion !== INDEX_SCHEMA_VERSION ||
      delta.baseId !== baseId ||
      typeof delta.files !== "object" ||
      typeof delta.stats !== "object"
    )
      return;
    let added = false;
    for (const [k, v] of Object.entries(delta.files)) {
      if (v) {
        if (!this.files.has(k)) added = true;
        this.files.set(k, v);
      } else this.files.delete(k);
      this.changedPaths.add(k);
    }
    for (const [k, v] of Object.entries(delta.stats)) {
      if (v) this.fileStats.set(k, v);
      else this.fileStats.delete(k);
      this.changedPaths.add(k);
    }
    // Same order as a full write.
    if (added) this.files = new Map([...this.files].sort(([a], [b]) => a.localeCompare(b)));
  }

  get loadWarnings(): readonly string[] {
    return this.warnings;
  }

  async save(): Promise<void> {
    if (!this.storePath || !this.dirty) return;
    const deltaPath = this.deltaPath as string;
    if (
      this.baseId &&
      !this.fullyDirty &&
      this.changedPaths.size <= Math.max(DELTA_MAX_PATHS, this.files.size * 0.02)
    ) {
      const delta: IndexDelta = {
        schemaVersion: INDEX_SCHEMA_VERSION,
        baseId: this.baseId,
        stats: {},
        files: {},
      };
      for (const p of [...this.changedPaths].sort()) {
        delta.files[p] = this.files.get(p) ?? null;
        delta.stats[p] = this.fileStats.get(p) ?? null;
      }
      await writeStateFile(deltaPath, JSON.stringify(delta));
      this.dirty = false;
      return;
    }
    const baseId = randomUUID();
    const data: IndexFile = {
      schemaVersion: INDEX_SCHEMA_VERSION,
      baseId,
      ...(this.contextKey ? { contextKey: this.contextKey } : {}),
      stats: Object.fromEntries(this.fileStats),
      files: Object.fromEntries([...this.files].sort(([a], [b]) => a.localeCompare(b))),
    };
    // Compact JSON: the index is a cache, not a document meant for humans.
    await writeStateFile(this.storePath, JSON.stringify(data));
    // The new base makes any delta stale (it names the old base); remove it.
    await removeStateFile(deltaPath);
    this.baseId = baseId;
    this.changedPaths.clear();
    this.fullyDirty = false;
    this.dirty = false;
  }

  get size(): number {
    return this.files.size;
  }

  get(path: string): FileAnalysis | undefined {
    return this.files.get(path);
  }

  entries(): Map<string, FileAnalysis> {
    return this.files;
  }

  async update(options: UpdateOptions): Promise<UpdateStats> {
    const started = performance.now();
    const read = options.read ?? ((p: string) => readFile(join(options.root, p), "utf8"));
    const wanted = new Set(options.files);
    // Resolution can be reused only when neither the file set nor the resolution config changed.
    const fileSetKey = sha256(options.files.join("\n"));
    const contextKey = options.contextKey
      ? sha256(`${options.contextKey}|${fileSetKey}`)
      : undefined;
    const reuseResolution = !!contextKey && contextKey === this.contextKey;
    // Previous resolution targets (to keep deleted targets visible), read before re-resolving:
    // from the replaced analysis of a re-parsed file, else from the analysis itself.
    const replaced = new Map<string, FileAnalysis>();
    const targetsOf = (a: FileAnalysis | undefined) => {
      const m = new Map<string, string>();
      for (const imp of a?.imports ?? [])
        if (imp.resolved) m.set(`${imp.kind}|${imp.specifier}`, imp.resolved);
      return m;
    };
    let parsed = 0;
    let reused = 0;
    let removed = 0;
    const changed = new Set<string>();
    let statsChanged = false;
    for (const path of [...this.files.keys()]) {
      if (!wanted.has(path)) {
        this.files.delete(path);
        this.fileStats.delete(path);
        this.touch(path);
        removed++;
      }
    }
    const pending: { path: string; content: string; analyzer: Analyzer }[] = [];
    for (const path of options.files) {
      const analyzer = options.analyzers.find((a) => a.supports(path));
      if (!analyzer) continue;
      const cached = this.files.get(path);
      let st: [number, number] | undefined;
      if (!options.read) {
        try {
          // statSync: thousands of awaited stats cost far more than the syscalls themselves.
          const s = statSync(join(options.root, path));
          st = [s.mtimeMs, s.size];
          if (options.mirror) {
            const m = options.mirror.differs.has(path)
              ? undefined
              : statSync(join(options.mirror.root, path), { throwIfNoEntry: false });
            st = m && m.size === s.size ? [m.mtimeMs, m.size] : undefined;
          }
        } catch {
          if (this.files.delete(path)) this.touch(path);
          continue;
        }
        const prev = this.fileStats.get(path);
        if (!st) {
          // Content differs from the mirror: read it, and never let the mirror's stats vouch for
          // the analysis recorded here.
          if (this.fileStats.delete(path)) {
            statsChanged = true;
            this.touch(path);
          }
        } else if (
          cached &&
          prev &&
          prev[0] === st[0] &&
          prev[1] === st[1] &&
          cached.analyzerVersion === analyzer.version
        ) {
          reused++;
          continue;
        }
      }
      let content: string;
      try {
        content = await read(path);
      } catch {
        if (this.files.delete(path)) this.touch(path);
        continue;
      }
      if (st) {
        this.fileStats.set(path, st);
        statsChanged = true;
        this.touch(path);
      }
      const hash = sha256(content);
      if (cached && cached.hash === hash && cached.analyzerVersion === analyzer.version) {
        reused++;
        continue;
      }
      pending.push({ path, content, analyzer });
    }
    // Parse: in worker threads when there are many files (cold start), in this thread otherwise.
    let parallel: FileAnalysis[] | undefined;
    if (options.parseMany && pending.length >= (options.parallelThreshold ?? 300))
      parallel = await options.parseMany(pending.map(({ path, content }) => ({ path, content })));
    for (const [i, job] of pending.entries()) {
      const previous = this.files.get(job.path);
      if (previous && !replaced.has(job.path)) replaced.set(job.path, previous);
      this.files.set(job.path, parallel?.[i] ?? job.analyzer.analyze(job.path, job.content));
      this.touch(job.path);
      changed.add(job.path);
      parsed++;
    }
    // A non-code file (JSON, SVG, CSS) is not in the file set, so adding or removing one does not
    // change the reuse key: importers of a vanished asset, and imports that did not resolve (the
    // file they name may exist now), are resolved again.
    const assetGone = (target: string) =>
      !CODE.test(target) &&
      !target.split("/").includes("node_modules") &&
      !existsSync(join(options.root, target));
    const recheck = (a: FileAnalysis) =>
      a.imports.some((i) => i.unresolved || (i.resolved && !i.missing && assetGone(i.resolved)));
    // Resolution pass. Deleted targets stay visible (missing: true) for impact analysis.
    for (let analysis of [...this.files.values()]) {
      let before: string | undefined;
      if (reuseResolution && !changed.has(analysis.path)) {
        if (!recheck(analysis)) continue;
        // Resolved into a copy: a long-lived caller compares analyses by identity.
        before = JSON.stringify([
          analysis.imports,
          analysis.dynamicTargets,
          analysis.dynamicUnmatched,
        ]);
        analysis = { ...analysis, imports: analysis.imports.map((i) => ({ ...i })) };
      }
      const old = targetsOf(replaced.get(analysis.path) ?? analysis);
      delete analysis.dynamicTargets;
      delete analysis.dynamicUnmatched;
      if (analysis.dynamicHints?.length) {
        const dir = posix.dirname(analysis.path);
        const targets = new Set<string>();
        const unmatched: string[] = [];
        for (const h of analysis.dynamicHints) {
          const rel = posix.normalize(posix.join(dir === "." ? "" : dir, h.pattern));
          const match = (p: string) =>
            p.includes("*")
              ? options.files.filter((f) => matchGlob(f, p))
              : wanted.has(p)
                ? [p]
                : [];
          let hits = rel.startsWith("..") ? [] : match(rel);
          // An aliased pattern (`import.meta.glob("@/pages/*.ts")`).
          if (!hits.length) {
            const aliased = options.resolver.resolvePattern?.(analysis.path, h.pattern);
            if (aliased) hits = match(aliased);
          }
          if (hits.length) for (const f of hits) targets.add(f);
          else unmatched.push(h.expr);
        }
        if (targets.size) analysis.dynamicTargets = [...targets].sort();
        if (unmatched.length) analysis.dynamicUnmatched = unmatched;
      }
      for (const imp of analysis.imports) {
        const oldTarget = old?.get(`${imp.kind}|${imp.specifier}`);
        delete imp.resolved;
        delete imp.external;
        delete imp.unresolved;
        delete imp.missing;
        const res = options.resolver.resolve(analysis.path, imp.specifier);
        // Code outside the indexed files (a gitignored build, an excluded or generated file) is
        // no graph node: an edge to it would lead nowhere, so the import is uncertainty.
        if (
          res.resolved &&
          CODE.test(res.resolved) &&
          !wanted.has(res.resolved) &&
          !res.resolved.split("/").includes("node_modules")
        ) {
          imp.unresolved = `resolves to "${res.resolved}", which is not an indexed source file`;
          continue;
        }
        if (res.resolved) {
          imp.resolved = res.resolved;
          if (res.uncertain) imp.unresolved = res.uncertain;
        } else if (res.external) imp.external = true;
        else {
          if (oldTarget && !wanted.has(oldTarget)) {
            imp.resolved = oldTarget;
            imp.missing = true;
          }
          imp.unresolved = res.reason ?? "unresolved";
        }
      }
      if (
        before !== undefined &&
        before !==
          JSON.stringify([analysis.imports, analysis.dynamicTargets, analysis.dynamicUnmatched])
      ) {
        this.files.set(analysis.path, analysis);
        this.touch(analysis.path);
      }
    }
    if (contextKey && contextKey !== this.contextKey) {
      this.contextKey = contextKey;
      this.dirty = true;
    }
    // Every file was re-resolved: only a full write records that.
    if (!reuseResolution) this.fullyDirty = true;
    if (parsed || removed || statsChanged) this.dirty = true;
    return {
      files: this.files.size,
      parsed,
      reused,
      removed,
      ...(reuseResolution ? {} : { resolvedAll: true }),
      durationMs: performance.now() - started,
    };
  }

  /** Top-level symbols (units) overlapping the given ranges. */
  symbolsInRanges(path: string, ranges: readonly SourceRange[]): SymbolRecord[] {
    const a = this.files.get(path);
    if (!a) return [];
    return topLevelSymbols(a).filter((s) => ranges.some((r) => rangesOverlap(s.range, r)));
  }

  stats(): {
    files: number;
    symbols: number;
    imports: number;
    unresolved: number;
    dynamic: number;
  } {
    let symbols = 0;
    let imports = 0;
    let unresolved = 0;
    let dynamic = 0;
    for (const a of this.files.values()) {
      symbols += a.symbols.length;
      imports += a.imports.length;
      unresolved += a.imports.filter((i) => i.unresolved && !i.missing).length;
      dynamic += a.dynamicUnresolved.length;
    }
    return { files: this.files.size, symbols, imports, unresolved, dynamic };
  }
}
