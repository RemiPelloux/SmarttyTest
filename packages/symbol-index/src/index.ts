/**
 * @smarttest/symbol-index — persistent, incremental index of file analyses (spec §9.5).
 * Parsing is cached by content hash; module resolution is recomputed every update (cheap and
 * always consistent with added/removed files).
 */
import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SourceRange } from "@smarttest/shared";
import { exists, readJson, sha256, writeFileAtomic } from "@smarttest/shared";
import type {
  Analyzer,
  FileAnalysis,
  ModuleResolver,
  SymbolRecord,
} from "@smarttest/source-parser";
import { rangesOverlap, topLevelSymbols } from "@smarttest/source-parser";

export const INDEX_SCHEMA_VERSION = 2;

interface IndexFile {
  schemaVersion: number;
  contextKey?: string;
  stats?: Record<string, [number, number]>;
  files: Record<string, FileAnalysis>;
}

export interface UpdateStats {
  files: number;
  parsed: number;
  reused: number;
  removed: number;
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
}

export class SymbolIndex {
  private files = new Map<string, FileAnalysis>();
  private fileStats = new Map<string, [number, number]>();
  private contextKey: string | undefined;
  private dirty = false;
  private warnings: string[] = [];

  private constructor(private readonly storePath: string | undefined) {}

  static inMemory(): SymbolIndex {
    return new SymbolIndex(undefined);
  }

  /** Loads a persisted index; corrupt or incompatible stores are rebuilt with a warning (ADR-0003). */
  static async load(storeDir: string): Promise<SymbolIndex> {
    const path = join(storeDir, "state", "index.json");
    const idx = new SymbolIndex(path);
    if (await exists(path)) {
      const data = await readJson<IndexFile>(path);
      if (data && data.schemaVersion === INDEX_SCHEMA_VERSION && data.files) {
        for (const [k, v] of Object.entries(data.files)) idx.files.set(k, v);
        for (const [k, v] of Object.entries(data.stats ?? {})) idx.fileStats.set(k, v);
        idx.contextKey = data.contextKey;
      } else {
        idx.warnings.push(
          "Local index was corrupt or from an incompatible version — rebuilt from scratch",
        );
      }
    }
    return idx;
  }

  get loadWarnings(): readonly string[] {
    return this.warnings;
  }

  async save(): Promise<void> {
    if (!this.storePath || !this.dirty) return;
    const data: IndexFile = {
      schemaVersion: INDEX_SCHEMA_VERSION,
      ...(this.contextKey ? { contextKey: this.contextKey } : {}),
      stats: Object.fromEntries(this.fileStats),
      files: Object.fromEntries([...this.files].sort(([a], [b]) => a.localeCompare(b))),
    };
    // Compact JSON: the index is a cache, not a document meant for humans.
    await writeFileAtomic(this.storePath, JSON.stringify(data));
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
    const oldTargets = new Map<string, Map<string, string>>();
    for (const [path, a] of this.files) {
      const m = new Map<string, string>();
      for (const imp of a.imports)
        if (imp.resolved) m.set(`${imp.kind}|${imp.specifier}`, imp.resolved);
      oldTargets.set(path, m);
    }
    let parsed = 0;
    let reused = 0;
    let removed = 0;
    const changed = new Set<string>();
    let statsChanged = false;
    for (const path of [...this.files.keys()]) {
      if (!wanted.has(path)) {
        this.files.delete(path);
        this.fileStats.delete(path);
        removed++;
      }
    }
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
        } catch {
          this.files.delete(path);
          continue;
        }
        const prev = this.fileStats.get(path);
        if (
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
        this.files.delete(path);
        continue;
      }
      if (st) {
        this.fileStats.set(path, st);
        statsChanged = true;
      }
      const hash = sha256(content);
      if (cached && cached.hash === hash && cached.analyzerVersion === analyzer.version) {
        reused++;
        continue;
      }
      this.files.set(path, analyzer.analyze(path, content));
      changed.add(path);
      parsed++;
    }
    // Resolution pass. Deleted targets stay visible (missing: true) for impact analysis.
    for (const analysis of this.files.values()) {
      if (reuseResolution && !changed.has(analysis.path)) continue;
      const old = oldTargets.get(analysis.path);
      for (const imp of analysis.imports) {
        const oldTarget = old?.get(`${imp.kind}|${imp.specifier}`);
        delete imp.resolved;
        delete imp.external;
        delete imp.unresolved;
        delete imp.missing;
        const res = options.resolver.resolve(analysis.path, imp.specifier);
        if (res.resolved) imp.resolved = res.resolved;
        else if (res.external) imp.external = true;
        else {
          if (oldTarget && !wanted.has(oldTarget)) {
            imp.resolved = oldTarget;
            imp.missing = true;
          }
          imp.unresolved = res.reason ?? "unresolved";
        }
      }
    }
    if (contextKey && contextKey !== this.contextKey) {
      this.contextKey = contextKey;
      this.dirty = true;
    }
    if (parsed || removed || statsChanged) this.dirty = true;
    return {
      files: this.files.size,
      parsed,
      reused,
      removed,
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
