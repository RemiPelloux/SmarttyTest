/**
 * @smarttest/coverage-engine — ingests istanbul coverage with an explicit scope.
 * Full-suite and selected-subset coverage are never merged (spec §16.2).
 */
import { readJson, relPosix } from "@smarttest/shared";

export type CoverageScope = "full" | "selected";

export interface Metric {
  total: number;
  covered: number;
  pct: number;
}

export interface FileCoverage {
  lines: Metric;
  statements: Metric;
  functions: Metric;
  branches: Metric;
}

export interface CoverageReport {
  scope: CoverageScope;
  collectedAt: string;
  runId: string;
  total: FileCoverage;
  files: Record<string, FileCoverage>;
}

interface IstanbulFile {
  path?: string;
  statementMap: Record<string, { start: { line: number }; end: { line: number } }>;
  s: Record<string, number>;
  f: Record<string, number>;
  b: Record<string, number[]>;
}

const metric = (covered: number, total: number): Metric => ({
  total,
  covered,
  pct: total ? Math.round((covered / total) * 10000) / 100 : 100,
});

function fileCoverage(data: IstanbulFile): FileCoverage {
  const s = Object.values(data.s);
  const f = Object.values(data.f);
  const b = Object.values(data.b).flat();
  const lines = new Map<number, boolean>();
  for (const [id, loc] of Object.entries(data.statementMap)) {
    const hit = (data.s[id] ?? 0) > 0;
    lines.set(loc.start.line, (lines.get(loc.start.line) ?? false) || hit);
  }
  return {
    lines: metric([...lines.values()].filter(Boolean).length, lines.size),
    statements: metric(s.filter((n) => n > 0).length, s.length),
    functions: metric(f.filter((n) => n > 0).length, f.length),
    branches: metric(b.filter((n) => n > 0).length, b.length),
  };
}

function sum(files: FileCoverage[]): FileCoverage {
  const add = (k: keyof FileCoverage) =>
    metric(
      files.reduce((a, x) => a + x[k].covered, 0),
      files.reduce((a, x) => a + x[k].total, 0),
    );
  return {
    lines: add("lines"),
    statements: add("statements"),
    functions: add("functions"),
    branches: add("branches"),
  };
}

/** Reads one or more `coverage-final.json` files. Multiple inputs (e.g. several runner roots) are unioned per file. */
export async function ingestIstanbul(
  paths: readonly string[],
  projectRoot: string,
  scope: CoverageScope,
  runId: string,
): Promise<CoverageReport | undefined> {
  const files: Record<string, FileCoverage> = {};
  let found = false;
  for (const p of paths) {
    const data = await readJson<Record<string, IstanbulFile>>(p);
    if (!data) continue;
    found = true;
    for (const [abs, entry] of Object.entries(data)) {
      const rel = relPosix(projectRoot, entry.path ?? abs) ?? abs;
      files[rel] = fileCoverage(entry);
    }
  }
  if (!found) return undefined;
  return {
    scope,
    collectedAt: new Date().toISOString(),
    runId,
    total: sum(Object.values(files)),
    files,
  };
}

export function describeScope(report: CoverageReport): string {
  return report.scope === "full" ? "full suite" : "selected tests only — not project coverage";
}
