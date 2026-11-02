/**
 * @smarttest/test-discovery — normalized, static test discovery and runner assignment.
 */
import { matchGlob } from "@smarttest/shared";

export type AdapterId = "vitest" | "jest" | "node" | "playwright" | "cypress" | "angular";

/** Union of Vitest and Jest default test patterns. */
const DEFAULT_TEST_FILE = /(?:^|\/)(?:__tests__\/.+|[^/]+\.(?:test|spec|cy))\.[cm]?[jt]sx?$/;
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
  /** Angular CLI project (`ng test <project>`). */
  project?: string;
}

/**
 * Expands `node --test` arguments the way Node does: a glob stays a glob, a directory means
 * "the default patterns inside it", a file path is that file. `stripTypes`: whether that Node
 * runs TypeScript (see `nodeStripsTypes`).
 */
export function expandNodePatterns(
  patterns: readonly string[] | undefined,
  stripTypes: boolean = nodeStripsTypes(),
): string[] {
  const defaults = nodeTestDefaults(stripTypes);
  if (!patterns?.length) return defaults;
  return patterns.flatMap((p) => {
    if (/\.[cm]?[jt]s$/.test(p) || /\*\.\{?[cm]?[jt]s/.test(p)) return [p];
    // A directory, or a glob that matches directories ("packages/*/test/"): Node searches them.
    const dir = p.replace(/\/$/, "");
    const inDir = defaults.map((d) => `${dir}/${d}`);
    return /[*?{[]/.test(p) && !p.endsWith("/") ? [p, ...inDir] : inDir;
  });
}

/** Node's built-in runner default patterns for JavaScript (node --test without arguments). */
export const NODE_TEST_DEFAULTS = [
  "**/*.test.{js,cjs,mjs}",
  "**/*-test.{js,cjs,mjs}",
  "**/*_test.{js,cjs,mjs}",
  "**/test-*.{js,cjs,mjs}",
  "**/test.{js,cjs,mjs}",
  "**/test/**/*.{js,cjs,mjs}",
];

/**
 * Node's default patterns. A Node that strips types (22.18+, 23.6+, or an older one run with
 * `--experimental-strip-types`) also runs the same names in `.ts`, `.mts` and `.cts`.
 */
export function nodeTestDefaults(stripTypes: boolean): string[] {
  if (!stripTypes) return NODE_TEST_DEFAULTS;
  return NODE_TEST_DEFAULTS.map((p) => p.replace("{js,cjs,mjs}", "{js,cjs,mjs,ts,cts,mts}"));
}

/**
 * Whether the Node that runs `node --test` strips TypeScript types. The adapter launches this
 * process's own executable (`process.execPath`) with its environment (`NODE_OPTIONS` included),
 * so this process's `process.features.typescript` answers it ("strip"/"transform", or false when
 * disabled with `--no-experimental-strip-types`). Before 22.10 the feature flag did not exist and
 * types were never stripped by default.
 */
export function nodeStripsTypes(): boolean {
  const ts = (process.features as { typescript?: unknown }).typescript;
  return typeof ts === "string" && ts !== "";
}

/** Assigns a test file to the deepest runner root that contains it. */
/**
 * Which of two runners in one directory owns a file both collect (lower wins): the order given in
 * `adapters`, then the runner the `test` script starts, then a runner with a config file. A Jest
 * set up with a config keeps its specs when the Vitest the Angular CLI installed stays in the
 * dependencies.
 */
export function runnerPreference(
  root: RunnerRoot,
  testScript: string,
  adapters: readonly AdapterId[] = [],
): number {
  const configured = adapters.indexOf(root.adapter);
  if (configured !== -1) return configured;
  const starts =
    root.adapter === "angular"
      ? /\bng\s+test\b/.test(testScript)
      : root.adapter === "node"
        ? /\bnode\b[^&|;]*\s--test\b/.test(testScript)
        : new RegExp(`\\b${root.adapter}\\b`).test(testScript);
  return 100 + (starts ? 0 : root.configFile ? 1 : 2);
}

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
