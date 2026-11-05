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
  readStateFile,
  readStateJson,
  removeStateFile,
  sha256,
  writeStateChunks,
  writeStateFile,
} from "@smarttest/shared";
import type {
  Analyzer,
  FileAnalysis,
  ModuleResolver,
  SymbolRecord,
} from "@smarttest/source-parser";
import { rangesOverlap, topLevelSymbols } from "@smarttest/source-parser";

/**
 * 3: the full index is a header line (the analyses without their lazily read fields, see
 * `LAZY_FIELDS`) followed by those fields, one JSON object per file at offsets the header records.
 * 2: one JSON document; still read, and written in the current layout by the next save.
 */
export const INDEX_SCHEMA_VERSION = 3;
const LEGACY_SCHEMA_VERSION = 2;
/** Source code (a graph node when indexed), as opposed to assets an import can also name. */
const CODE = /\.(?:[cm]?[jt]sx?)$/;

interface IndexFile {
  schemaVersion: number;
  /** Identifies this full write; a delta applies only to the base it names. */
  baseId?: string;
  contextKey?: string;
  stats?: Record<string, [number, number]>;
  /**
   * The listed files that have no analysis (assets, files no analyzer supports, unreadable
   * files): with the analysed files, the file set the stored resolutions were computed against.
   */
  others?: string[];
  files: Record<string, FileAnalysis>;
}

/** Header line of a full index (schema 3). */
interface IndexHeader extends Omit<IndexFile, "files"> {
  /**
   * Each analysis without its lazy fields; a lazy field it has is kept in its place with the
   * placeholder 0, so a loaded analysis has the same keys, in the same order, as the one saved.
   */
  files: Record<string, Record<string, unknown>>;
  /** path → [start, end) of its lazy fields' JSON object, in the text after the header line. */
  parts: Record<string, [number, number]>;
}

/**
 * Fields of an analysis that few readers need on a typical run (the symbols of the files a change
 * reaches, the top-level uses of a changed file): stored apart from the header and parsed for a
 * file the first time one of them is read. Together they are most of the index.
 */
const LAZY_FIELDS = [
  "symbols",
  "topLevelRefs",
  "topLevelUses",
  "topLevelEscapes",
  "topLevelResources",
  "assetReads",
  "catalogKeys",
] as const;
const LAZY = new Set<string>(LAZY_FIELDS);

/** Where the lazy fields of a loaded analysis are, until one of them is first read. */
interface LazyPart {
  text: string;
  start: number;
  end: number;
}
const lazyParts = new WeakMap<object, LazyPart>();

/** Replaces the accessors of `a` by the values its stored part holds. */
function materialize(a: object): void {
  const part = lazyParts.get(a);
  if (!part) throw new Error("symbol index: a lazy field without its stored part");
  lazyParts.delete(a);
  const values = JSON.parse(part.text.slice(part.start, part.end)) as Record<string, unknown>;
  for (const field of LAZY_FIELDS)
    if (Object.getOwnPropertyDescriptor(a, field)?.get)
      Object.defineProperty(a, field, {
        value: values[field],
        writable: true,
        enumerable: true,
        configurable: true,
      });
}

/** One accessor per lazy field, shared by every analysis (no closure per file). */
const LAZY_ACCESSORS = new Map<string, PropertyDescriptor>(
  LAZY_FIELDS.map((field) => [
    field,
    {
      get(this: Record<string, unknown>) {
        materialize(this);
        return this[field];
      },
      set(this: Record<string, unknown>, value: unknown) {
        materialize(this);
        this[field] = value;
      },
      enumerable: true,
      configurable: true,
    },
  ]),
);

/** Whether `p` can be the [start, end) of a stored part in `text`, whose body starts at `base`. */
const isPart = (text: string, base: number, p: unknown): p is [number, number] =>
  Array.isArray(p) &&
  p.length === 2 &&
  Number.isInteger(p[0]) &&
  Number.isInteger(p[1]) &&
  p[0] >= 0 &&
  p[1] > p[0] &&
  base + p[1] <= text.length &&
  text.charCodeAt(base + p[0]) === 123 && // {
  text.charCodeAt(base + p[1] - 1) === 125; // }

/**
 * The analyses of a schema-3 index, their lazy fields left in `text` until read; undefined when
 * the text is not a complete index of that layout.
 */
function readLazyIndex(
  text: string,
): { header: IndexHeader; files: Map<string, FileAnalysis> } | undefined {
  const nl = text.indexOf("\n");
  if (nl < 0) return undefined;
  let header: IndexHeader;
  try {
    header = JSON.parse(text.slice(0, nl)) as IndexHeader;
  } catch {
    return undefined;
  }
  if (
    !header ||
    header.schemaVersion !== INDEX_SCHEMA_VERSION ||
    !header.files ||
    typeof header.files !== "object" ||
    !header.parts ||
    typeof header.parts !== "object"
  )
    return undefined;
  const base = nl + 1;
  const files = new Map<string, FileAnalysis>();
  for (const [path, a] of Object.entries(header.files)) {
    const p = header.parts[path];
    if (!a || typeof a !== "object" || !isPart(text, base, p)) return undefined;
    let lazy = false;
    for (const key of Object.keys(a))
      if (LAZY.has(key)) {
        Object.defineProperty(a, key, LAZY_ACCESSORS.get(key) as PropertyDescriptor);
        lazy = true;
      }
    if (lazy) lazyParts.set(a, { text, start: base + p[0], end: base + p[1] });
    files.set(path, a as unknown as FileAnalysis);
  }
  return { header, files };
}

/**
 * The pieces of a schema-3 full index: the header line, then each file's lazy fields. A file whose
 * lazy fields were never read is written back from the text it was read from, unparsed.
 */
function lazyIndexChunks(data: IndexFile): string[] {
  const body: string[] = [];
  const files: Record<string, Record<string, unknown>> = {};
  const parts: Record<string, [number, number]> = {};
  let offset = 0;
  for (const [path, a] of Object.entries(data.files)) {
    const stored = lazyParts.get(a);
    const record = a as unknown as Record<string, unknown>;
    const skeleton: Record<string, unknown> = {};
    const values: Record<string, unknown> = {};
    for (const key of Object.keys(a)) {
      if (!LAZY.has(key)) skeleton[key] = record[key];
      else if (stored) skeleton[key] = 0;
      else if (record[key] !== undefined) {
        skeleton[key] = 0;
        values[key] = record[key];
      }
    }
    const part = stored ? stored.text.slice(stored.start, stored.end) : JSON.stringify(values);
    files[path] = skeleton;
    parts[path] = [offset, offset + part.length];
    offset += part.length;
    body.push(part);
  }
  const header: IndexHeader = { ...data, files, parts };
  return [`${JSON.stringify(header)}\n`, ...body];
}

/** Joins many small pieces into fewer large ones for writing. */
function* batched(pieces: readonly string[], size = 1 << 20): Generator<string> {
  let batch: string[] = [];
  let length = 0;
  for (const p of pieces) {
    batch.push(p);
    length += p.length;
    if (length >= size) {
      yield batch.join("");
      batch = [];
      length = 0;
    }
  }
  if (batch.length) yield batch.join("");
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
  /** Replaces the base's `others` when present. */
  others?: string[];
}

/**
 * The name a path segment or specifier segment is looked up by: what precedes its first dot,
 * lower-cased (case-insensitive file systems). `f0.test.ts`, `f0.js` and `F0` share `f0`.
 */
function nameKey(segment: string): string {
  const bare = segment.replace(/^\.+/, "");
  const dot = bare.indexOf(".");
  return (dot < 0 ? bare : bare.slice(0, dot)).toLowerCase();
}

/**
 * Every name an import can reach a file by: its own name and the name of each directory above it
 * (`./a` finds `a/index.ts`, a directory's `package.json` can name any file below it).
 */
function lookupNames(file: string): string[] {
  return file.split("/").map(nameKey);
}

/**
 * Whether a new file (one of `added`, see `lookupNames`) could change what `specifier` resolves
 * to. Conservative: a resolver probes the specifier's own last name (with extensions, as a
 * directory, through `rootDirs`), so a relative import, or an alias that keeps that name
 * (`@lib/*` → `src/*`, `baseUrl`, a package subpath), can only reach a new file of that name.
 * A mapping that does not keep it (an exact alias, a package entry, a package outside the
 * project, a bare one-segment name), or an alias whose first target is not the file it resolved
 * to (an earlier target in its list may now exist), could reach a new file of any name: resolved
 * again. `firstTarget` is the alias's first target, when the resolver can say (`resolvePattern`).
 */
function mayNameAdded(
  specifier: string,
  resolved: string | undefined,
  added: ReadonlySet<string>,
  firstTarget: () => string | undefined,
): boolean {
  const path = specifier.replace(/[?#].*$/, "").replace(/\/+$/, "");
  const last = path.slice(path.lastIndexOf("/") + 1);
  if (!last || last === "." || last === "..") return true;
  const key = nameKey(last);
  if (added.has(key)) return true;
  if (specifier.startsWith(".") || specifier.startsWith("/")) return false;
  if (!resolved || !path.includes("/")) return true;
  const segs = resolved.split("/");
  const name = nameKey(segs[segs.length - 1] ?? "");
  const kept = name === key || (name === "index" && nameKey(segs[segs.length - 2] ?? "") === key);
  if (!kept) return true;
  const first = firstTarget();
  if (first === undefined) return false;
  const stem = (p: string) => p.replace(/\.[^./]*$/, "").replace(/\/index$/, "");
  return stem(first) !== stem(resolved) && stem(first) !== resolved.replace(/\/index\.[^./]*$/, "");
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
  /** See `IndexFile.others`; undefined when unknown (an index written before it was recorded). */
  private others: string[] | undefined;
  /** `others` differs from the full index's: deltas carry it. */
  private othersInDelta = false;

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

  /**
   * Loads a persisted index; corrupt or incompatible stores are rebuilt with a warning (ADR-0003).
   * The lazy fields of each analysis (`LAZY_FIELDS`) are parsed the first time one is read.
   */
  static async load(storeDir: string): Promise<SymbolIndex> {
    const path = join(storeDir, "state", "index.json");
    const idx = new SymbolIndex(path);
    if (await exists(path)) {
      // Authenticated (state.ts): a planted or foreign index reads as corrupt and is rebuilt.
      const text = await readStateFile(path);
      const lazy = text === undefined ? undefined : readLazyIndex(text);
      let data: Omit<IndexFile, "files"> | undefined;
      if (lazy) {
        idx.files = lazy.files;
        data = lazy.header;
      } else if (text?.startsWith(`{"schemaVersion":${LEGACY_SCHEMA_VERSION},`)) {
        // Schema 2 (one JSON document): read whole, and rewritten in the current layout by the
        // next save.
        let legacy: IndexFile | undefined;
        try {
          legacy = JSON.parse(text) as IndexFile;
        } catch {
          legacy = undefined;
        }
        if (legacy?.files && typeof legacy.files === "object") {
          data = legacy;
          for (const [k, v] of Object.entries(legacy.files)) idx.files.set(k, v);
          idx.dirty = true;
          idx.fullyDirty = true;
        }
      }
      if (data) {
        for (const [k, v] of Object.entries(data.stats ?? {})) idx.fileStats.set(k, v);
        idx.contextKey = data.contextKey;
        idx.baseId = data.baseId;
        if (Array.isArray(data.others)) idx.others = data.others;
        if (data.baseId) await idx.applyDelta(data.baseId, data.schemaVersion);
      } else {
        idx.warnings.push(
          "Local index was corrupt or from an incompatible version — rebuilt from scratch",
        );
      }
    }
    return idx;
  }

  /** Applies the delta written against this base, if any (a delta for another base is ignored). */
  private async applyDelta(baseId: string, schemaVersion: number): Promise<void> {
    const path = this.deltaPath;
    const delta = path ? await readStateJson<IndexDelta>(path) : undefined;
    if (
      !delta ||
      delta.schemaVersion !== schemaVersion ||
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
    if (Array.isArray(delta.others)) {
      this.others = delta.others;
      this.othersInDelta = true;
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
      if (this.othersInDelta && this.others) delta.others = this.others;
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
      ...(this.others ? { others: this.others } : {}),
      files: Object.fromEntries([...this.files].sort(([a], [b]) => a.localeCompare(b))),
    };
    // Compact JSON: the index is a cache, not a document meant for humans.
    await writeStateChunks(this.storePath, batched(lazyIndexChunks(data)));
    // The new base makes any delta stale (it names the old base); remove it.
    await removeStateFile(deltaPath);
    this.baseId = baseId;
    this.changedPaths.clear();
    this.othersInDelta = false;
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
    // Stored resolutions are reused while the resolution config is the same. When files were added
    // or removed, only the imports those files can affect are resolved again (see `redo` below).
    const contextKey = options.contextKey
      ? sha256(`incremental-file-set\u0000${options.contextKey}`)
      : undefined;
    // The file set the stored resolutions were computed against.
    const previousFiles = this.others ? new Set([...this.files.keys(), ...this.others]) : undefined;
    const reuseResolution = !!contextKey && contextKey === this.contextKey && !!previousFiles;
    const addedFiles = previousFiles ? options.files.filter((f) => !previousFiles.has(f)) : [];
    const removedFiles = new Set<string>();
    for (const f of previousFiles ?? []) if (!wanted.has(f)) removedFiles.add(f);
    const fileSetChanged = addedFiles.length > 0 || removedFiles.size > 0;
    const addedNames = new Set(addedFiles.flatMap(lookupNames));
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
    // An import whose stored resolution may no longer hold: one that did not resolve, one whose
    // target is gone, and, when files were added, one whose specifier could name a new file.
    const redo = (from: string, i: FileAnalysis["imports"][number]) =>
      !!i.unresolved ||
      (!!i.resolved && !i.missing && (removedFiles.has(i.resolved) || assetGone(i.resolved))) ||
      (addedFiles.length > 0 &&
        mayNameAdded(i.specifier, i.resolved, addedNames, () =>
          options.resolver.resolvePattern?.(from, i.specifier),
        ));
    // Resolution pass. Deleted targets stay visible (missing: true) for impact analysis.
    for (let analysis of [...this.files.values()]) {
      let before: string | undefined;
      /** Imports to resolve again; undefined: all of them. */
      let only: Set<FileAnalysis["imports"][number]> | undefined;
      if (reuseResolution && !changed.has(analysis.path)) {
        const from = analysis.path;
        const stale = analysis.imports.filter((i) => redo(from, i));
        // A glob (`import.meta.glob`) matches against the file set.
        const globs = fileSetChanged && !!analysis.dynamicHints?.length;
        if (!stale.length && !globs) continue;
        // Resolved into a copy: a long-lived caller compares analyses by identity.
        before = JSON.stringify([
          analysis.imports,
          analysis.dynamicTargets,
          analysis.dynamicUnmatched,
        ]);
        const copies = new Map(analysis.imports.map((i) => [i, { ...i }]));
        only = new Set(stale.map((i) => copies.get(i) as FileAnalysis["imports"][number]));
        analysis = { ...analysis, imports: analysis.imports.map((i) => copies.get(i) ?? i) };
      }
      const old = targetsOf(replaced.get(analysis.path) ?? analysis);
      delete analysis.dynamicTargets;
      delete analysis.dynamicUnmatched;
      if (analysis.dynamicHints?.length) {
        const dir = posix.dirname(analysis.path);
        const targets = new Set<string>();
        const unmatched: string[] = [];
        for (const h of analysis.dynamicHints) {
          // `@root/…`: a glob relative to the project root (a `smarttest-loads:` annotation).
          const rel = h.pattern.startsWith("@root/")
            ? posix.normalize(h.pattern.slice("@root/".length))
            : posix.normalize(posix.join(dir === "." ? "" : dir, h.pattern));
          const literal = (p: string) =>
            p.includes("*")
              ? options.files.filter((f) => matchGlob(f, p))
              : wanted.has(p)
                ? [p]
                : [];
          // `new Worker(new URL("./worker.js", import.meta.url))` names the compiled file; the
          // project holds worker.ts (TypeScript maps .js to .ts for static imports the same way).
          const match = (p: string) => {
            const found = literal(p);
            if (found.length) return found;
            const m = /\.(m|c)?js(x?)$/.exec(p);
            if (!m) return found;
            const base = p.slice(0, m.index);
            const ts = m[1] ? `.${m[1]}ts` : m[2] ? ".tsx" : ".ts";
            return [...literal(`${base}${ts}`), ...(m[1] ? [] : literal(`${base}.tsx`))];
          };
          // A root-absolute pattern (`/src/pages/*.ts`) starts at the Vite root: the resolver's.
          let hits = rel.startsWith("..") || h.pattern.startsWith("/") ? [] : match(rel);
          if (h.pattern.startsWith("@root/")) {
            // Declared by the author: what matches is what it loads, nothing else is guessed.
            for (const f of hits) targets.add(f);
            continue;
          }
          // An aliased or root-absolute pattern (`import.meta.glob("@/pages/*.ts")`).
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
        if (only && !only.has(imp)) continue;
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
    const others = options.files.filter((f) => !this.files.has(f));
    if (
      !this.others ||
      others.length !== this.others.length ||
      others.some((f, i) => f !== this.others?.[i])
    ) {
      this.others = others;
      this.othersInDelta = true;
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
