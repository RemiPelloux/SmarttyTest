/**
 * Persisted dependency graph (`.smarttest/state/graph.json`). The graph is a cache of what
 * `new DependencyGraph(analyses, isTest, options)` builds: it is used only when it provably
 * describes the current analyses, and on any doubt the graph is rebuilt (never trade correctness
 * for speed; an invalid store must not reduce selection).
 *
 * The file is two lines: a header (JSON) and the serialized graph. The header records
 *  - the SmartTest version, the store and graph formats, a hash of the configuration and of the
 *    graph options (framework routes, end-to-end specs);
 *  - a hash of every file's module resolution (resolved, external, missing and unresolved imports,
 *    dynamic-import targets), which also fixes the set of analysed files;
 *  - for every file, its content hash with the analyzer version, and a hash of its surface (what
 *    other files see of it: imports, exports, declarations);
 *  - the SHA-256 of the graph line, so a damaged file is never half-used.
 * A file whose content changed while its surface did not is patched into the restored graph
 * (the same incremental patch watch mode uses); anything else means a full rebuild.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DependencyGraph, GRAPH_FORMAT, type GraphOptions } from "@smarttest/dependency-graph";
import { readStateFileSync, sha256, VERSION, writeStateFile } from "@smarttest/shared";
import type { FileAnalysis } from "@smarttest/source-parser";

/**
 * The stored graph has no valid MAC under this machine's state key: written on another machine,
 * under another key (a new `SMARTTEST_STATE_KEY`, a recreated per-user key) or by an earlier
 * version. Routine, not damage: it is rebuilt.
 */
export const FOREIGN_STATE = "state from another machine or an earlier version: rebuilt";

/** Version of the header layout and of the keys below. */
export const GRAPH_STORE_VERSION = 1;
/** A patched graph is written back once more files than this differ from the stored one. */
export const PATCHED_FILES_BEFORE_SAVE = 32;

interface Header {
  store: number;
  format: number;
  version: string;
  config: string;
  options: string;
  resolution: string;
  /** path → [content hash + analyzer version, surface hash] */
  files: Record<string, [string, string]>;
  body: string;
}

export type GraphLoad =
  | { status: "loaded"; graph: DependencyGraph }
  | { status: "patched"; graph: DependencyGraph; changed: string[] }
  | { status: "missing" | "stale" | "structural" | "corrupt"; reason: string };

/** What other files see of a file: a change here is structural (no patch). */
export function surfaceOf(a: FileAnalysis): string {
  return JSON.stringify([
    a.importsHash,
    a.localExports,
    a.symbols.map((y) => [y.qualifiedName, y.kind, y.exportNames, y.parent ?? "", y.extends ?? ""]),
    a.catalogKeys ? Object.keys(a.catalogKeys) : [],
  ]);
}

const contentKey = (a: FileAnalysis) => `${a.hash}:${a.analyzerVersion}`;

/** Hash of everything module resolution contributed to the analyses, in path order. */
function resolutionHash(files: ReadonlyMap<string, FileAnalysis>): string {
  // Lines joined by "\n", hashed one file at a time (computed on every warm run).
  const hash = createHash("sha256");
  let first = true;
  for (const path of [...files.keys()].sort()) {
    const a = files.get(path) as FileAnalysis;
    let text = first ? path : `\n${path}`;
    first = false;
    for (const i of a.imports)
      text += `\n${i.kind}\u0001${i.specifier}\u0001${i.resolved ?? ""}\u0001${i.external ? 1 : 0}\u0001${i.missing ? 1 : 0}\u0001${i.unresolved ?? ""}`;
    if (a.dynamicTargets?.length) text += `\n>${a.dynamicTargets.join("\u0001")}`;
    if (a.dynamicUnmatched?.length) text += `\n?${a.dynamicUnmatched.join("\u0001")}`;
    hash.update(`${text}\n\u0000`);
  }
  return hash.digest("hex");
}

export class GraphStore {
  readonly path: string;
  private readonly config: string;
  private readonly options: string;

  constructor(
    storeDir: string,
    config: unknown,
    private readonly graphOptions: GraphOptions,
  ) {
    this.path = join(storeDir, "state", "graph.json");
    // Report output (`reports.formats`, `reports.outputDir`) never shapes the graph, and hook runs
    // rewrite `reports.outputDir` for their temporary checkout: keying on it would make hook runs
    // and normal runs invalidate each other's stored graph. Everything else stays in the key.
    const keyed =
      config && typeof config === "object" && !Array.isArray(config)
        ? { ...config, reports: undefined } // JSON.stringify drops it
        : config;
    this.config = sha256(JSON.stringify(keyed) ?? "");
    this.options = sha256(
      JSON.stringify([graphOptions.routes ?? [], [...(graphOptions.e2eTests ?? [])].sort()]),
    );
  }

  /** Restores (and patches) the persisted graph for these analyses, or says why it cannot. */
  load(files: ReadonlyMap<string, FileAnalysis>, isTest: (path: string) => boolean): GraphLoad {
    if (!existsSync(this.path)) return { status: "missing", reason: "no stored graph" };
    // The checks below are all against public data (content hashes): only the MAC proves this
    // machine (or a CI job holding its key) wrote the graph. A planted graph could drop edges.
    const text = readStateFileSync(this.path);
    if (text === undefined) return { status: "corrupt", reason: FOREIGN_STATE };
    const nl = text.indexOf("\n");
    let header: Header;
    try {
      header = JSON.parse(nl < 0 ? text : text.slice(0, nl)) as Header;
    } catch {
      return { status: "corrupt", reason: "unreadable header" };
    }
    if (!header || typeof header !== "object" || typeof header.files !== "object")
      return { status: "corrupt", reason: "unreadable header" };
    if (header.store !== GRAPH_STORE_VERSION || header.format !== GRAPH_FORMAT)
      return { status: "stale", reason: "graph format changed" };
    if (header.version !== VERSION) return { status: "stale", reason: "SmartTest version changed" };
    if (header.config !== this.config) return { status: "stale", reason: "configuration changed" };
    if (header.options !== this.options)
      return { status: "stale", reason: "routes or end-to-end specs changed" };
    if (Object.keys(header.files).length !== files.size)
      return { status: "structural", reason: "files added or removed" };
    const changed: string[] = [];
    for (const [path, a] of files) {
      const stored = header.files[path];
      if (!Array.isArray(stored)) return { status: "structural", reason: "files added or removed" };
      if (stored[0] === contentKey(a)) continue;
      if (stored[1] !== sha256(surfaceOf(a)))
        return {
          status: "structural",
          reason: `${path}: imports, exports or declarations changed`,
        };
      changed.push(path);
    }
    if (header.resolution !== resolutionHash(files))
      return { status: "structural", reason: "module resolution changed" };
    const body = nl < 0 ? "" : text.slice(nl + 1);
    if (sha256(body) !== header.body) return { status: "corrupt", reason: "checksum mismatch" };
    const graph = DependencyGraph.restore(files, isTest, this.graphOptions, body);
    if (!graph) return { status: "corrupt", reason: "unreadable graph" };
    if (!changed.length) return { status: "loaded", graph };
    if (!graph.patch(changed)) return { status: "structural", reason: "change cannot be patched" };
    this.patchedFrom = header;
    return { status: "patched", graph, changed };
  }

  /** Header of the stored graph a patch started from (its surfaces and resolution still hold). */
  private patchedFrom: Header | undefined;

  /**
   * Whether a graph obtained this way is worth writing. A patched graph is cheap to patch again
   * from the stored one, so it is rewritten only once many files differ from it.
   */
  static shouldSave(load: GraphLoad): boolean {
    if (load.status === "loaded") return false;
    if (load.status === "patched") return load.changed.length > PATCHED_FILES_BEFORE_SAVE;
    return true;
  }

  /** Persists a graph built (or patched) from exactly these analyses. Atomic. */
  async save(graph: DependencyGraph, files: ReadonlyMap<string, FileAnalysis>): Promise<void> {
    const body = graph.serialize();
    const entries: Record<string, [string, string]> = {};
    const base = this.patchedFrom;
    if (base) {
      // Patched: only contents changed; surfaces and resolution were verified unchanged.
      for (const [path, a] of files) {
        const stored = base.files[path] as [string, string];
        entries[path] = stored[0] === contentKey(a) ? stored : [contentKey(a), stored[1]];
      }
    } else for (const [path, a] of files) entries[path] = [contentKey(a), sha256(surfaceOf(a))];
    const header: Header = {
      store: GRAPH_STORE_VERSION,
      format: GRAPH_FORMAT,
      version: VERSION,
      config: this.config,
      options: this.options,
      resolution: base ? base.resolution : resolutionHash(files),
      files: entries,
      body: sha256(body),
    };
    await writeStateFile(this.path, `${JSON.stringify(header)}\n${body}`);
  }
}
