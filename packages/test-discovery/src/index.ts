/**
 * @smarttest/test-discovery — normalized, static test discovery and runner assignment.
 */
import { matchGlob } from "@smarttest/shared";

export type AdapterId = "vitest" | "jest" | "node";

/** Union of Vitest and Jest default test patterns. */
const DEFAULT_TEST_FILE = /(?:^|\/)(?:__tests__\/.+|[^/]+\.(?:test|spec))\.[cm]?[jt]sx?$/;
const TEST_FILE_IN_TESTS_DIR = /(?:^|\/)__tests__\/[^/]+\.[cm]?[jt]sx?$/;

export function isTestFile(path: string, match?: readonly string[]): boolean {
  if (match?.length) return matchGlob(path, match);
  return DEFAULT_TEST_FILE.test(path) || TEST_FILE_IN_TESTS_DIR.test(path);
}

export function discoverTestFiles(files: readonly string[], match?: readonly string[]): string[] {
  return files.filter((f) => isTestFile(f, match));
}

export type TestCategory = "unit" | "integration" | "e2e";

/** Infers a test category from path conventions. */
export function testCategory(path: string): TestCategory {
  if (/(?:^|\/)(?:e2e|end-to-end)(?:\/|\.)/i.test(path)) return "e2e";
  if (/(?:^|\/|\.)(?:integration|int)(?:\/|\.)/i.test(path)) return "integration";
  return "unit";
}

export interface RunnerRoot {
  adapter: AdapterId;
  /** Project-relative POSIX directory ("" = project root). */
  dir: string;
  configFile?: string;
  /** Explicit test patterns (node --test <patterns>). */
  patterns?: string[];
}

/**
 * Expands `node --test` arguments the way Node does: a glob stays a glob, a directory means
 * "the default patterns inside it", a file path is that file.
 */
export function expandNodePatterns(patterns: readonly string[] | undefined): string[] {
  if (!patterns?.length) return NODE_TEST_DEFAULTS;
  return patterns.flatMap((p) => {
    if (/\.[cm]?[jt]s$/.test(p) || /\*\.\{?[cm]?[jt]s/.test(p)) return [p];
    // A directory, or a glob that matches directories ("packages/*/test/"): Node searches them.
    const dir = p.replace(/\/$/, "");
    const inDir = NODE_TEST_DEFAULTS.map((d) => `${dir}/${d}`);
    return /[*?{[]/.test(p) && !p.endsWith("/") ? [p, ...inDir] : inDir;
  });
}

/** Node's built-in runner default patterns (node --test without arguments). */
export const NODE_TEST_DEFAULTS = [
  "**/*.test.{js,cjs,mjs}",
  "**/*-test.{js,cjs,mjs}",
  "**/*_test.{js,cjs,mjs}",
  "**/test-*.{js,cjs,mjs}",
  "**/test.{js,cjs,mjs}",
  "**/test/**/*.{js,cjs,mjs}",
];

/** Assigns a test file to the deepest runner root that contains it. */
export function assignRunner(
  testFile: string,
  roots: readonly RunnerRoot[],
  preferred?: readonly AdapterId[],
): RunnerRoot | undefined {
  let best: RunnerRoot | undefined;
  for (const root of roots) {
    const inside = root.dir === "" || testFile === root.dir || testFile.startsWith(`${root.dir}/`);
    if (!inside) continue;
    if (!best || root.dir.length > best.dir.length) best = root;
    else if (root.dir.length === best.dir.length) {
      const rank = (r: RunnerRoot) => {
        const i = preferred?.indexOf(r.adapter) ?? -1;
        return i === -1 ? (r.configFile ? 50 : 100) : i;
      };
      if (rank(root) < rank(best)) best = root;
    }
  }
  return best;
}
