/**
 * Line and branch coverage detail, per file, for one coverage run.
 *
 * The summary in `index.ts` answers "how much"; this answers "which lines". Each report keeps the
 * run it came from, its scope and its origin, and every file carries the hash of the text the
 * coverage was measured against, so a reader can refuse to project old line numbers onto a file
 * that has changed since. Reports of different origins (runner istanbul output, browser V8) and
 * different runs are never merged.
 */
import { createHash } from "node:crypto";
import { readdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { readJson, relPosix } from "@smarttest/shared";
import type { CoverageScope } from "./index.js";

export const LINE_COVERAGE_SCHEMA = 1;

/** Where the measurement came from. */
export type LineCoverageOrigin = "istanbul" | "browser-v8";

export interface BranchCoverage {
  /** One-based line the branch starts on. */
  line: number;
  /** istanbul branch type (`if`, `cond-expr`, `binary-expr`, `switch`…) or `block` for V8. */
  type: string;
  /** Hits per arm. An arm with 0 hits never ran in this run. */
  arms: number[];
}

export interface LineCoverageFile {
  /** sha256 of the file's text when the coverage was ingested; null when it could not be read. */
  sha256: string | null;
  /** `[line, hits]` for every line the measurement knows to hold code, one-based, ascending. */
  lines: [number, number][];
  branches: BranchCoverage[];
}

export interface LineCoverageReport {
  schemaVersion: typeof LINE_COVERAGE_SCHEMA;
  origin: LineCoverageOrigin;
  scope: CoverageScope;
  runId: string;
  collectedAt: string;
  files: Record<string, LineCoverageFile>;
  /** Browser scripts that could not be tied to a project file, with the reason. */
  unmapped: { url: string; reason: string }[];
}

interface Loc {
  start: { line: number; column?: number };
  end: { line: number; column?: number };
}

interface IstanbulDetail {
  path?: string;
  statementMap: Record<string, Loc>;
  s: Record<string, number>;
  branchMap?: Record<string, { type?: string; loc?: Loc; locations?: Loc[]; line?: number }>;
  b?: Record<string, number[]>;
}

export const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

async function hashOf(abs: string): Promise<string | null> {
  try {
    return sha256(await readFile(abs, "utf8"));
  } catch {
    return null;
  }
}

function sortedLines(map: Map<number, number>): [number, number][] {
  return [...map.entries()].sort((a, b) => a[0] - b[0]);
}

/** Line hits of one istanbul file entry: the hits of the statements that start on each line. */
export function istanbulLines(entry: IstanbulDetail): {
  lines: Map<number, number>;
  branches: BranchCoverage[];
} {
  const lines = new Map<number, number>();
  for (const [id, loc] of Object.entries(entry.statementMap ?? {})) {
    const line = loc?.start?.line;
    if (!Number.isInteger(line) || line < 1) continue;
    const hits = entry.s?.[id] ?? 0;
    lines.set(line, Math.max(lines.get(line) ?? 0, hits));
  }
  const branches: BranchCoverage[] = [];
  for (const [id, branch] of Object.entries(entry.branchMap ?? {})) {
    const arms = entry.b?.[id];
    if (!Array.isArray(arms)) continue;
    const line =
      branch.loc?.start.line ?? branch.locations?.[0]?.start.line ?? branch.line ?? undefined;
    if (!line || !Number.isInteger(line)) continue;
    branches.push({ line, type: branch.type ?? "branch", arms: arms.map((n) => Number(n) || 0) });
  }
  branches.sort((a, b) => a.line - b.line);
  return { lines, branches };
}

function addBranches(into: BranchCoverage[], more: BranchCoverage[]): BranchCoverage[] {
  // Same run, two runner roots that both loaded the file: arms at the same place add up.
  const key = (b: BranchCoverage) => `${b.line}:${b.type}:${b.arms.length}`;
  const index = new Map(into.map((b, i) => [key(b), i]));
  const out = [...into];
  for (const b of more) {
    const at = index.get(key(b));
    if (at === undefined) {
      index.set(key(b), out.length);
      out.push(b);
    } else {
      const prev = out[at] as BranchCoverage;
      out[at] = { ...prev, arms: prev.arms.map((n, i) => n + (b.arms[i] ?? 0)) };
    }
  }
  return out.sort((a, b) => a.line - b.line);
}

/**
 * Reads the `coverage-final.json` files one run wrote (one per runner root) into line detail.
 * A file loaded by two runner roots of the same run has its hits added; nothing from another run
 * is ever read here.
 */
export async function ingestIstanbulLines(
  paths: readonly string[],
  projectRoot: string,
  scope: CoverageScope,
  runId: string,
): Promise<LineCoverageReport | undefined> {
  const merged = new Map<string, { lines: Map<number, number>; branches: BranchCoverage[] }>();
  let found = false;
  for (const p of paths) {
    const data = await readJson<Record<string, IstanbulDetail>>(p);
    if (!data) continue;
    found = true;
    for (const [abs, entry] of Object.entries(data)) {
      const rel = relPosix(projectRoot, entry.path ?? abs);
      if (!rel || rel.startsWith("../")) continue;
      const detail = istanbulLines(entry);
      const prev = merged.get(rel);
      if (!prev) {
        merged.set(rel, detail);
        continue;
      }
      for (const [line, hits] of detail.lines)
        prev.lines.set(line, (prev.lines.get(line) ?? 0) + hits);
      prev.branches = addBranches(prev.branches, detail.branches);
    }
  }
  if (!found) return undefined;
  const files: Record<string, LineCoverageFile> = {};
  for (const [rel, detail] of [...merged.entries()].sort((a, b) => a[0].localeCompare(b[0])))
    files[rel] = {
      sha256: await hashOf(join(projectRoot, rel)),
      lines: sortedLines(detail.lines),
      branches: detail.branches,
    };
  return {
    schemaVersion: LINE_COVERAGE_SCHEMA,
    origin: "istanbul",
    scope,
    runId,
    collectedAt: new Date().toISOString(),
    files,
    unmapped: [],
  };
}

// ── Browser V8 coverage ──────────────────────────────────────────────────────────────────────

/** One script as Chromium's `page.coverage.stopJSCoverage()` returns it. */
export interface V8ScriptCoverage {
  url: string;
  scriptId?: string;
  source?: string;
  functions: {
    functionName?: string;
    isBlockCoverage?: boolean;
    ranges: { startOffset: number; endOffset: number; count: number }[];
  }[];
}

/** What the Playwright coverage fixture writes per test: the entries of the pages it watched. */
export interface BrowserCoverageDump {
  testFile?: string;
  testId?: string;
  entries: V8ScriptCoverage[];
}

const COMMENT_ONLY = /^\s*(\/\/|\/\*|\*\/|\*(?!\*?\/)|$)/;

/**
 * Line hits from V8 block coverage of `source`. A line's count is the count of the innermost
 * range that contains its first non-blank character. Blank lines and lines that start a comment
 * are not counted as code: V8 has no statement map, so this is a line view of block ranges, not
 * istanbul statement coverage.
 */
export function v8Lines(
  source: string,
  functions: V8ScriptCoverage["functions"],
): { lines: Map<number, number>; branches: BranchCoverage[] } {
  const ranges = functions
    .flatMap((fn) => fn.ranges)
    .filter((r) => r.endOffset > r.startOffset)
    .sort((a, b) => b.endOffset - b.startOffset - (a.endOffset - a.startOffset));
  const counts = new Int32Array(source.length).fill(-1);
  // Paint outer ranges first, inner ranges over them: the innermost range wins.
  for (const r of ranges)
    counts.fill(r.count, Math.max(0, r.startOffset), Math.min(source.length, r.endOffset));
  const lineStarts = [0];
  for (let i = 0; i < source.length; i++) if (source.charCodeAt(i) === 10) lineStarts.push(i + 1);
  const lineOf = (offset: number): number => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((lineStarts[mid] as number) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  const lines = new Map<number, number>();
  for (let n = 0; n < lineStarts.length; n++) {
    const start = lineStarts[n] as number;
    const end = n + 1 < lineStarts.length ? (lineStarts[n + 1] as number) - 1 : source.length;
    const text = source.slice(start, end);
    if (COMMENT_ONLY.test(text)) continue;
    const first = start + (text.length - text.trimStart().length);
    const count = counts[first] ?? -1;
    if (count >= 0) lines.set(n + 1, count);
  }
  // Block ranges (every range after a function's own) are the branch arms V8 measures.
  const branches: BranchCoverage[] = [];
  for (const fn of functions) {
    if (!fn.isBlockCoverage) continue;
    for (const r of fn.ranges.slice(1))
      branches.push({ line: lineOf(r.startOffset), type: "block", arms: [r.count] });
  }
  branches.sort((a, b) => a.line - b.line);
  return { lines, branches };
}

/** Candidate project paths for a script URL, most specific first. */
function candidatesFor(url: string, projectRoot: string): string[] {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [];
  }
  if (parsed.protocol === "file:") return [decodeURIComponent(parsed.pathname)];
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return [];
  let path: string;
  try {
    path = decodeURIComponent(parsed.pathname);
  } catch {
    return [];
  }
  // Vite serves files outside its root as /@fs/<absolute path>.
  if (path.startsWith("/@fs/")) return [path.slice(4)];
  const rel = path.replace(/^\/+/, "");
  if (!rel) return [];
  return [join(projectRoot, rel), join(projectRoot, "public", rel)];
}

async function inside(root: string, abs: string): Promise<string | null> {
  try {
    const [realRoot, realFile] = await Promise.all([realpath(root), realpath(abs)]);
    return realFile.startsWith(`${realRoot}${sep}`) ? realFile : null;
  } catch {
    return null;
  }
}

/**
 * Reads the browser coverage dumps of one run (written by the Playwright fixture) into line
 * detail. A script is tied to a project file only when its URL resolves to a file inside the
 * project and the source the browser ran is byte-for-byte that file: then V8 offsets are offsets
 * in the file. A bundled, transformed or source-mapped script is listed as unmapped with the
 * reason, never guessed onto a file.
 */
export async function ingestBrowserV8(
  dirs: readonly string[],
  projectRoot: string,
  scope: CoverageScope,
  runId: string,
): Promise<LineCoverageReport | undefined> {
  const root = resolve(projectRoot);
  const merged = new Map<
    string,
    { sha: string; lines: Map<number, number>; branches: BranchCoverage[] }
  >();
  const unmapped = new Map<string, string>();
  let found = false;
  for (const dir of dirs) {
    let names: string[];
    try {
      names = (await readdir(dir)).filter((n) => n.endsWith(".json")).sort();
    } catch {
      continue;
    }
    for (const name of names) {
      const dump = await readJson<BrowserCoverageDump>(join(dir, name));
      if (!dump || !Array.isArray(dump.entries)) continue;
      found = true;
      for (const entry of dump.entries) {
        if (!entry?.url || !Array.isArray(entry.functions)) continue;
        if (typeof entry.source !== "string") {
          unmapped.set(entry.url, "the browser did not report the script source");
          continue;
        }
        let file: string | null = null;
        let text: string | null = null;
        for (const candidate of candidatesFor(entry.url, root)) {
          const abs = isAbsolute(candidate) ? candidate : join(root, candidate);
          const real = await inside(root, abs);
          if (!real) continue;
          try {
            text = await readFile(real, "utf8");
            file = real;
            break;
          } catch {
            /* try the next candidate */
          }
        }
        if (!file || text === null) {
          if (!unmapped.has(entry.url))
            unmapped.set(entry.url, "the URL does not resolve to a file in the project");
          continue;
        }
        if (text !== entry.source) {
          unmapped.set(
            entry.url,
            "the browser ran a transformed or bundled script, not the file itself (source maps are not read)",
          );
          continue;
        }
        const rel = relPosix(root, file) ?? file;
        unmapped.delete(entry.url);
        const detail = v8Lines(entry.source, entry.functions);
        const prev = merged.get(rel);
        if (!prev) {
          merged.set(rel, { sha: sha256(text), ...detail });
          continue;
        }
        for (const [line, hits] of detail.lines)
          prev.lines.set(line, (prev.lines.get(line) ?? 0) + hits);
        prev.branches = addBranches(prev.branches, detail.branches);
      }
    }
  }
  if (!found) return undefined;
  const files: Record<string, LineCoverageFile> = {};
  for (const [rel, detail] of [...merged.entries()].sort((a, b) => a[0].localeCompare(b[0])))
    files[rel] = {
      sha256: detail.sha,
      lines: sortedLines(detail.lines),
      branches: detail.branches,
    };
  return {
    schemaVersion: LINE_COVERAGE_SCHEMA,
    origin: "browser-v8",
    scope,
    runId,
    collectedAt: new Date().toISOString(),
    files,
    unmapped: [...unmapped.entries()]
      .map(([url, reason]) => ({ url, reason }))
      .sort((a, b) => a.url.localeCompare(b.url))
      .slice(0, 200),
  };
}
