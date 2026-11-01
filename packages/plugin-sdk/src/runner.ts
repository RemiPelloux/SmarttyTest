import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { relPosixReported, type TestExecution, type TestStatus } from "@smarttest/shared";

/** Finds an installed package's bin script by walking up node_modules from `cwd` (no shell shims). */
export function resolvePackageBin(cwd: string, pkg: string, bin: string): string | undefined {
  let dir = cwd;
  for (;;) {
    const manifest = join(dir, "node_modules", pkg, "package.json");
    if (existsSync(manifest)) {
      try {
        const m = JSON.parse(readFileSync(manifest, "utf8")) as {
          bin?: string | Record<string, string>;
        };
        const rel = typeof m.bin === "string" ? m.bin : m.bin?.[bin];
        if (rel) return join(dirname(manifest), rel);
      } catch {
        /* keep walking */
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

interface JestLikeAssertion {
  ancestorTitles?: string[];
  title?: string;
  fullName?: string;
  status?: string;
  duration?: number | null;
  failureMessages?: string[];
}

interface JestLikeFile {
  name: string;
  status?: string;
  message?: string;
  startTime?: number;
  endTime?: number;
  assertionResults?: JestLikeAssertion[];
}

export interface JestLikeReport {
  testResults?: JestLikeFile[];
  /** False when the run failed (Jest, Vitest). Vitest leaves it true for an unhandled error. */
  success?: boolean;
  /** Jest: an error that stopped the run itself, outside any file. */
  runExecError?: { message?: string };
}

const toPosix = (p: string) => p.split(sep).join("/");

function mapStatus(s: string | undefined): TestStatus {
  switch (s) {
    case "passed":
      return "passed";
    case "failed":
      return "failed";
    case "todo":
    case "pending":
      return "pending";
    case "skipped":
    case "disabled":
      return "skipped";
    default:
      return "failed";
  }
}

/**
 * Parses Jest-compatible JSON reports (Jest `--json`, Vitest `--reporter=json`).
 * Test ids are `<project-relative file>::<full name>`.
 */
export function parseJestLikeReport(report: JestLikeReport, projectRoot: string): TestExecution[] {
  const out: TestExecution[] = [];
  for (const file of report.testResults ?? []) {
    const rel =
      relPosixReported(projectRoot, file.name) ?? toPosix(relative(projectRoot, file.name));
    const assertions = file.assertionResults ?? [];
    // A file the runner marks failed with no failing assertion failed outside its tests: a
    // beforeAll/afterAll hook threw, or the file itself did. Vitest leaves `message` empty for a
    // hook inside a describe block, so the status alone decides.
    const failedOutsideTests =
      file.status === "failed" && !assertions.some((a) => a.status === "failed");
    if (failedOutsideTests || (!assertions.length && file.message)) {
      out.push({
        testId: `${rel}::(suite)`,
        status: "failed",
        durationMs: Math.max(0, (file.endTime ?? 0) - (file.startTime ?? 0)),
        attempts: 1,
        error: {
          message: (
            file.message ||
            (assertions.length
              ? "The file failed outside its tests (a beforeAll/afterAll hook or the file itself threw); the runner's JSON report gave no message"
              : "Test suite failed to run")
          ).slice(0, 4000),
        },
      });
    }
    for (const a of assertions) {
      const name = a.fullName ?? [...(a.ancestorTitles ?? []), a.title ?? ""].join(" ").trim();
      const status = mapStatus(a.status);
      const exec: TestExecution = {
        testId: `${rel}::${name}`,
        status,
        durationMs: a.duration ?? 0,
        attempts: 1,
      };
      if (a.failureMessages?.length)
        exec.error = { message: a.failureMessages.join("\n").slice(0, 4000) };
      // In a file that failed outside its tests, a "skipped" test was most likely not run because
      // a hook failed: never count it as a skip the test asked for (§32.2).
      if (failedOutsideTests && (status === "skipped" || status === "pending")) {
        exec.status = "cancelled";
        exec.error = {
          message:
            "Not run: the file failed outside its tests (for example a beforeAll hook threw)",
        };
      }
      out.push(exec);
    }
  }
  return out;
}

export function fileOfTestId(testId: string): string {
  const i = testId.indexOf("::");
  return i === -1 ? testId : testId.slice(0, i);
}
