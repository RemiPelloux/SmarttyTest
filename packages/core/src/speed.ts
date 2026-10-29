/**
 * 0.8.0 speed: test history (flaky analytics, fail-fast ordering), sharding by duration, and the
 * validated result cache.
 */
import { join } from "node:path";
import { readJson, sha256, type TestExecution, writeJson } from "@smarttest/shared";

// ── History ─────────────────────────────────────────────────────────────────────────────────

export interface TestHistory {
  /** Last statuses, oldest first: P passed, F failed, K flaky, T timed out. At most 30. */
  recent: string;
  runs: number;
  failures: number;
  flaky: number;
  lastFailureAt?: string;
}

export interface HistoryStore {
  version: 1;
  tests: Record<string, TestHistory>;
}

const CODE: Partial<Record<TestExecution["status"], string>> = {
  passed: "P",
  failed: "F",
  flaky: "K",
  "timed-out": "T",
};

export async function loadHistory(storeDir: string): Promise<HistoryStore> {
  const s = await readJson<HistoryStore>(join(storeDir, "state", "history.json"));
  return s?.version === 1 ? s : { version: 1, tests: {} };
}

export async function saveHistory(storeDir: string, store: HistoryStore): Promise<void> {
  await writeJson(join(storeDir, "state", "history.json"), store);
}

/** Records one run's executions (cached results are not new evidence and are not recorded). */
export function recordRun(
  store: HistoryStore,
  executions: readonly TestExecution[],
  at = new Date().toISOString(),
): void {
  for (const e of executions) {
    const c = CODE[e.status];
    if (!c) continue;
    const h = store.tests[e.testId] ?? { recent: "", runs: 0, failures: 0, flaky: 0 };
    store.tests[e.testId] = h;
    h.recent = `${h.recent}${c}`.slice(-30);
    h.runs++;
    if (c === "F" || c === "T") {
      h.failures++;
      h.lastFailureAt = at;
    }
    if (c === "K") h.flaky++;
  }
}

export interface FlakyEntry {
  testId: string;
  file: string;
  runs: number;
  /** Runs that passed only after a retry, plus pass/fail flips in the recent history. */
  flakeRate: number;
  failureRate: number;
  recent: string;
}

/** Flip count: P→F or F→P transitions with no code change in between are typical of flaky tests. */
function flips(recent: string): number {
  let n = 0;
  for (let i = 1; i < recent.length; i++) {
    const a = recent[i - 1];
    const b = recent[i];
    if ((a === "P" && (b === "F" || b === "T")) || ((a === "F" || a === "T") && b === "P")) n++;
  }
  return n;
}

export function flakyReport(store: HistoryStore, minRate = 0.05, minRuns = 3): FlakyEntry[] {
  return Object.entries(store.tests)
    .filter(([, h]) => h.runs >= minRuns)
    .map(([testId, h]) => ({
      testId,
      file: testId.slice(0, testId.indexOf("::") > -1 ? testId.indexOf("::") : undefined),
      runs: h.runs,
      flakeRate: Math.min(1, (h.flaky + flips(h.recent) / 2) / h.runs),
      failureRate: h.failures / h.runs,
      recent: h.recent,
    }))
    .filter((e) => e.flakeRate >= minRate)
    .sort((a, b) => b.flakeRate - a.flakeRate || a.testId.localeCompare(b.testId));
}

/** Files whose tests failed recently (last 5 recorded runs), most recent failure first. */
export function recentlyFailingFiles(store: HistoryStore): Map<string, string> {
  const out = new Map<string, string>();
  for (const [id, h] of Object.entries(store.tests)) {
    if (!/[FT]/.test(h.recent.slice(-5)) || !h.lastFailureAt) continue;
    const file = id.slice(0, id.indexOf("::") > -1 ? id.indexOf("::") : undefined);
    const prev = out.get(file);
    if (!prev || prev < h.lastFailureAt) out.set(file, h.lastFailureAt);
  }
  return out;
}

/**
 * Fail-fast order: files that failed recently first (newest failure first), then by graph
 * distance from the change (closest first), then by name.
 */
export function failFastOrder(
  files: readonly string[],
  recentFailures: ReadonlyMap<string, string>,
  depth: (f: string) => number,
): string[] {
  return [...files].sort((a, b) => {
    const fa = recentFailures.get(a) ?? "";
    const fb = recentFailures.get(b) ?? "";
    if (fa !== fb) return fa < fb ? 1 : -1;
    return depth(a) - depth(b) || a.localeCompare(b);
  });
}

// ── Sharding ────────────────────────────────────────────────────────────────────────────────

/**
 * Deterministic split of files into `total` shards balanced by recorded durations (longest
 * first onto the lightest shard). Files without a duration count as the median.
 */
export function shardFiles(
  files: readonly string[],
  durations: Readonly<Record<string, number>>,
  total: number,
): string[][] {
  const known = files
    .map((f) => durations[f])
    .filter((d): d is number => d !== undefined)
    .sort((a, b) => a - b);
  const median = known.length ? (known[Math.floor(known.length / 2)] as number) : 1;
  const cost = (f: string) => durations[f] ?? median;
  const shards = Array.from({ length: total }, () => ({ files: [] as string[], load: 0 }));
  for (const f of [...files].sort((a, b) => cost(b) - cost(a) || a.localeCompare(b))) {
    const lightest = shards.reduce(
      (m, s, i) => (s.load < (shards[m]?.load ?? Number.POSITIVE_INFINITY) ? i : m),
      0,
    );
    const s = shards[lightest] as (typeof shards)[number];
    s.files.push(f);
    s.load += cost(f);
  }
  return shards.map((s) => s.files.sort());
}

export function parseShard(value: string): { index: number; total: number } | undefined {
  const m = /^(\d+)\/(\d+)$/.exec(value.trim());
  if (!m) return undefined;
  const index = Number(m[1]);
  const total = Number(m[2]);
  return total >= 1 && index >= 1 && index <= total ? { index, total } : undefined;
}

// ── Result cache ────────────────────────────────────────────────────────────────────────────

export interface CachedResult {
  key: string;
  at: string;
  durationMs: number;
  tests: TestExecution[];
}

export interface ResultCache {
  version: 1;
  /** Per test file, the most recent passing results (up to three keys, newest first). */
  files: Record<string, CachedResult[]>;
}

export async function loadResultCache(storeDir: string): Promise<ResultCache> {
  const s = await readJson<ResultCache>(join(storeDir, "cache", "results.json"));
  return s?.version === 1 ? s : { version: 1, files: {} };
}

export async function saveResultCache(storeDir: string, cache: ResultCache): Promise<void> {
  await writeJson(join(storeDir, "cache", "results.json"), cache);
}

export function cacheGet(cache: ResultCache, file: string, key: string): CachedResult | undefined {
  return cache.files[file]?.find((r) => r.key === key);
}

export function cachePut(cache: ResultCache, file: string, entry: CachedResult): void {
  const list = (cache.files[file] ?? []).filter((r) => r.key !== entry.key);
  cache.files[file] = [entry, ...list].slice(0, 3);
}

/** Cache key: every input that can change the result, hashed in a stable order. */
export function resultKey(parts: Record<string, string>): string {
  return sha256(
    Object.keys(parts)
      .sort()
      .map((k) => `${k}\u0000${parts[k]}`)
      .join("\u0001"),
  );
}
