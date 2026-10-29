/**
 * Runtime traces (observed execution). Each test file is run on its own with NODE_V8_COVERAGE;
 * the functions it executed are stored per project file, with the content hash of every file it
 * loaded. A trace is used only while all those hashes still match the code it is compared against.
 */
import { readdir, readFile, rm } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { readJson, sha256, writeJson } from "@smarttest/shared";
import type { FileAnalysis } from "@smarttest/source-parser";

export const TRACE_STORE_VERSION = 1;

export interface TestTrace {
  /** ISO time of collection. */
  at: string;
  status: "passed" | "failed";
  /** Content hash of every project file the test loaded (the test included). */
  fileHashes: Record<string, string>;
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

export async function loadTraces(storeDir: string): Promise<TraceStore | undefined> {
  const s = await readJson<TraceStore>(join(storeDir, "state", "traces.json"));
  return s?.version === TRACE_STORE_VERSION ? s : undefined;
}

export async function saveTraces(storeDir: string, store: TraceStore): Promise<void> {
  await writeJson(join(storeDir, "state", "traces.json"), store);
}

export async function hashFile(root: string, file: string): Promise<string | undefined> {
  try {
    return sha256(await readFile(join(root, file), "utf8"));
  } catch {
    return undefined;
  }
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
    let fresh = !!t && this.store?.env === this.currentEnv && t.status === "passed";
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
