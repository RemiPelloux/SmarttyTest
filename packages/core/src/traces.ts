/**
 * Runtime traces (observed execution). Each test file is run on its own with NODE_V8_COVERAGE;
 * the functions it executed are stored per project file, with the content hash of every file it
 * loaded. A trace is used only while all those hashes still match the code it is compared against.
 */
import { readdir, readFile, rm } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { readStateFile, removeStateFile, sha256, writeStateChunks } from "@smarttest/shared";
import type { FileAnalysis } from "@smarttest/source-parser";

/**
 * 2: traces record the environment variables their files read (`env`, `envAny`).
 * 3: stored compact, with shared tables of paths, hashes and function-name lists (`TraceFile`);
 * older stores are not read, so traces are recorded again.
 */
export const TRACE_STORE_VERSION = 3;

export interface TestTrace {
  /** ISO time of collection. */
  at: string;
  status: "passed" | "failed";
  /** Content hash of every project file the test loaded (the test included). */
  fileHashes: Record<string, string>;
  /**
   * Environment variables the loaded files read, with a hash of their value when traced (see
   * `envValueHash`). With another value, the same code can take another path: the trace is stale.
   */
  env?: Record<string, string>;
  /** A loaded file reads `process.env` with keys that can't be listed: never fresh. */
  envAny?: boolean;
  /** Per loaded file: names of functions that ran ("" = module code). */
  executed: Record<string, string[]>;
  /** Per loaded file: names of all functions V8 saw (to detect names that do not map). */
  known: Record<string, string[]>;
}

export interface TraceStore {
  version: number;
  /** Runtime and dependency fingerprint the traces were collected under. */
  env: string;
  tests: Record<string, TestTrace>;
}

interface V8Coverage {
  result: {
    url: string;
    functions: { functionName: string; ranges: { count: number }[] }[];
  }[];
}

/** Reads a NODE_V8_COVERAGE directory into per-file executed/known function names. */
export async function readV8Coverage(
  dir: string,
  root: string,
): Promise<{ executed: Map<string, Set<string>>; known: Map<string, Set<string>> }> {
  const executed = new Map<string, Set<string>>();
  const known = new Map<string, Set<string>>();
  const files = await readdir(dir).catch(() => [] as string[]);
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    let cov: V8Coverage;
    try {
      cov = JSON.parse(await readFile(join(dir, f), "utf8")) as V8Coverage;
    } catch {
      continue;
    }
    for (const script of cov.result ?? []) {
      if (!script.url.startsWith("file://")) continue;
      let abs: string;
      try {
        abs = fileURLToPath(script.url.split("?")[0] as string);
      } catch {
        continue;
      }
      const rel = relative(root, abs).split(sep).join("/");
      if (rel.startsWith("..") || rel.includes("node_modules/") || rel.startsWith(".smarttest/"))
        continue;
      const ex = executed.get(rel) ?? new Set<string>();
      const kn = known.get(rel) ?? new Set<string>();
      for (const fn of script.functions) {
        const name = fn.functionName.replace(/^(get|set) /, "");
        kn.add(name);
        if ((fn.ranges[0]?.count ?? 0) > 0) ex.add(name);
      }
      executed.set(rel, ex);
      known.set(rel, kn);
    }
  }
  return { executed, known };
}

/**
 * How `traces.json` is stored. A thousand tests loading the same few hundred files repeated every
 * path, hash and function list per test (99 MB of JSON for 1,000 tests × 300 files, close to the
 * longest string V8 can hold at 3,000 × 500). Each is stored once in a table here; a test lists
 * index pairs: `h` [file, hash]…, `x` (executed) and `k` (known) [file, names]….
 */
interface TraceFile {
  version: number;
  env: string;
  files: string[];
  hashes: string[];
  names: string[][];
  tests: Record<
    string,
    {
      at: string;
      status: "passed" | "failed";
      env?: Record<string, string>;
      envAny?: boolean;
      h: number[];
      x: number[];
      k: number[];
    }
  >;
}

class Table<T> {
  readonly items: T[] = [];
  private readonly ids = new Map<string, number>();
  constructor(private readonly key: (item: T) => string) {}
  id(item: T): number {
    const k = this.key(item);
    let id = this.ids.get(k);
    if (id === undefined) {
      id = this.items.length;
      this.items.push(item);
      this.ids.set(k, id);
    }
    return id;
  }
}

/** The store in its stored form, as JSON text in pieces of about `chunkSize` characters. */
export function* encodeTraces(store: TraceStore, chunkSize = 1 << 20): Generator<string> {
  const files = new Table<string>((f) => f);
  const hashes = new Table<string>((h) => h);
  const names = new Table<string[]>((n) => JSON.stringify(n));
  const tests: [string, TraceFile["tests"][string]][] = [];
  const pairs = (rec: Record<string, string[]>) =>
    Object.entries(rec).flatMap(([f, n]) => [files.id(f), names.id(n)]);
  for (const [id, t] of Object.entries(store.tests)) {
    tests.push([
      id,
      {
        at: t.at,
        status: t.status,
        ...(t.env ? { env: t.env } : {}),
        ...(t.envAny ? { envAny: true } : {}),
        h: Object.entries(t.fileHashes).flatMap(([f, h]) => [files.id(f), hashes.id(h)]),
        x: pairs(t.executed),
        k: pairs(t.known),
      },
    ]);
  }
  let buf = `{"version":${JSON.stringify(store.version)},"env":${JSON.stringify(store.env)}`;
  const tables: [string, unknown[]][] = [
    ["files", files.items],
    ["hashes", hashes.items],
    ["names", names.items],
  ];
  for (const [key, items] of tables) {
    buf += `,"${key}":[`;
    for (const [i, item] of items.entries()) {
      buf += `${i ? "," : ""}${JSON.stringify(item)}`;
      if (buf.length >= chunkSize) {
        yield buf;
        buf = "";
      }
    }
    buf += "]";
  }
  buf += ',"tests":{';
  for (const [i, [id, t]] of tests.entries()) {
    buf += `${i ? "," : ""}${JSON.stringify(id)}:${JSON.stringify(t)}`;
    if (buf.length >= chunkSize) {
      yield buf;
      buf = "";
    }
  }
  yield `${buf}}}\n`;
}

/** The stored form back as a store; undefined when it is not a well-formed current store. */
export function decodeTraces(text: string): TraceStore | undefined {
  let raw: TraceFile;
  try {
    raw = JSON.parse(text) as TraceFile;
  } catch {
    return undefined;
  }
  if (
    raw?.version !== TRACE_STORE_VERSION ||
    typeof raw.env !== "string" ||
    !Array.isArray(raw.files) ||
    !Array.isArray(raw.hashes) ||
    !Array.isArray(raw.names) ||
    !raw.tests ||
    typeof raw.tests !== "object"
  )
    return undefined;
  const record = <V>(pairs: unknown, values: readonly V[]): Record<string, V> | undefined => {
    if (!Array.isArray(pairs) || pairs.length % 2) return undefined;
    const out: Record<string, V> = {};
    for (let i = 0; i < pairs.length; i += 2) {
      const file = raw.files[pairs[i] as number];
      const value = values[pairs[i + 1] as number];
      if (typeof file !== "string" || value === undefined) return undefined;
      out[file] = value;
    }
    return out;
  };
  const tests: Record<string, TestTrace> = {};
  for (const [id, t] of Object.entries(raw.tests)) {
    const fileHashes = record(t?.h, raw.hashes);
    const executed = record(t?.x, raw.names);
    const known = record(t?.k, raw.names);
    // A damaged entry is dropped: the test is then untraced, which never rules it out.
    if (!fileHashes || !executed || !known) continue;
    tests[id] = {
      at: t.at,
      status: t.status,
      fileHashes,
      ...(t.env ? { env: t.env } : {}),
      ...(t.envAny ? { envAny: true } : {}),
      executed,
      known,
    };
  }
  return { version: raw.version, env: raw.env, tests };
}

export async function loadTraces(storeDir: string): Promise<TraceStore | undefined> {
  // Authenticated: outside SAFE mode a fresh trace can rule a test out. Unreadable (damaged,
  // forged, from another version, too large to read): no traces, so they rule nothing out.
  const text = await readStateFile(join(storeDir, "state", "traces.json")).catch(() => undefined);
  return text === undefined ? undefined : decodeTraces(text);
}

/**
 * Saves the store compact and in pieces, so no single string has to hold it. A store that still
 * cannot be written is not saved: the error is returned for a warning. The previous file is
 * removed (it no longer says what the tests ran), so the traces are recorded again next time.
 */
export async function saveTraces(storeDir: string, store: TraceStore): Promise<Error | undefined> {
  const path = join(storeDir, "state", "traces.json");
  try {
    await writeStateChunks(path, encodeTraces(store));
    return undefined;
  } catch (error) {
    await removeStateFile(path).catch(() => undefined);
    return error instanceof Error ? error : new Error(String(error));
  }
}

export async function hashFile(root: string, file: string): Promise<string | undefined> {
  try {
    return sha256(await readFile(join(root, file), "utf8"));
  } catch {
    return undefined;
  }
}

/** Hash of an environment variable's value, distinct for an unset variable. */
export function envValueHash(value: string | undefined): string {
  return value === undefined ? "unset" : sha256(`=${value}`).slice(0, 16);
}

/**
 * The environment a trace depends on: the keys its loaded files read, with their current values
 * hashed. `any` when a file reads keys that can't be listed (`process.env[name]`), or when a loaded
 * file was not analysed, so what it reads is unknown.
 */
export function traceEnv(
  loaded: Iterable<string>,
  files: { get(file: string): FileAnalysis | undefined },
  env: NodeJS.ProcessEnv = process.env,
): { env?: Record<string, string>; envAny?: true } {
  const keys = new Set<string>();
  for (const file of loaded) {
    const a = files.get(file);
    if (!a) return { envAny: true };
    for (const r of [
      ...(a.topLevelResources ?? []),
      ...a.symbols.flatMap((s) => s.resources ?? []),
    ]) {
      if (!r.startsWith("env:")) continue;
      if (r === "env:*") return { envAny: true };
      keys.add(r.slice(4));
    }
  }
  if (!keys.size) return {};
  return { env: Object.fromEntries([...keys].sort().map((k) => [k, envValueHash(env[k])])) };
}

export async function cleanDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

/**
 * Read-only view used by the impact engine. A trace is fresh when every file it loaded still has
 * the recorded content at the base of the change being analysed.
 */
export class TraceView {
  private freshCache = new Map<string, boolean>();

  constructor(
    private readonly store: TraceStore | undefined,
    private readonly currentEnv: string,
    /** Content hash of a file at the base of the analysed change, if it exists there. */
    private readonly baseHash: (file: string) => string | undefined,
    private readonly files: ReadonlyMap<string, FileAnalysis>,
    /** The environment the selected tests will run with. */
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  get size(): number {
    return this.store ? Object.keys(this.store.tests).length : 0;
  }

  collectedAt(test: string): string | undefined {
    return this.store?.tests[test]?.at;
  }

  trace(test: string): TestTrace | undefined {
    return this.store?.tests[test];
  }

  isFresh(test: string): boolean {
    const cached = this.freshCache.get(test);
    if (cached !== undefined) return cached;
    const t = this.store?.tests[test];
    let fresh = !!t && this.store?.env === this.currentEnv && t.status === "passed" && !t.envAny;
    // Code that reads an environment variable can run differently with another value.
    if (fresh && t?.env)
      for (const [key, h] of Object.entries(t.env))
        if (envValueHash(this.env[key]) !== h) {
          fresh = false;
          break;
        }
    if (fresh && t)
      for (const [file, h] of Object.entries(t.fileHashes))
        if (this.baseHash(file) !== h) {
          fresh = false;
          break;
        }
    this.freshCache.set(test, fresh);
    return fresh;
  }

  /**
   * Whether the (fresh) trace of a test ran a unit. Units whose name V8 does not report (values,
   * classes as a whole, constructors, anonymous code) count as run whenever their file was loaded.
   */
  executed(test: string, file: string, unit: string): boolean {
    const t = this.store?.tests[test];
    if (!t) return true;
    const ran = t.executed[file];
    if (!ran) return false; // never loaded
    if (unit === "*" || unit.endsWith(".@init")) return true;
    const name = unit.includes(".") ? unit.slice(unit.indexOf(".") + 1) : unit;
    const sym = this.files
      .get(file)
      ?.symbols.find(
        (s) => (unit.includes(".") ? `${s.parent}.${s.name}` : s.qualifiedName) === unit,
      );
    if (!sym || (sym.kind !== "function" && sym.kind !== "method")) return true;
    if (!t.known[file]?.includes(name)) return true; // name not reported: cannot tell
    return ran.includes(name);
  }
}
