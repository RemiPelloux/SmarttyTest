/**
 * @smarttest/test-discovery — normalized, static test discovery and runner assignment.
 */
import { matchGlob } from "@smarttest/shared";

export type AdapterId = "vitest" | "jest";

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
}

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
