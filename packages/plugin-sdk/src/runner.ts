import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import type { TestExecution, TestStatus } from "@smarttest/shared";

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
    const rel = toPosix(relative(projectRoot, file.name));
    const assertions = file.assertionResults ?? [];
    if (
      !assertions.length ||
      (file.status === "failed" && file.message && !assertions.some((a) => a.status === "failed"))
    ) {
      if (file.status === "failed" || file.message) {
        out.push({
          testId: `${rel}::(suite)`,
          status: "failed",
          durationMs: Math.max(0, (file.endTime ?? 0) - (file.startTime ?? 0)),
          attempts: 1,
          error: { message: (file.message ?? "Test suite failed to run").slice(0, 4000) },
        });
      }
    }
    for (const a of assertions) {
      const name = a.fullName ?? [...(a.ancestorTitles ?? []), a.title ?? ""].join(" ").trim();
      const exec: TestExecution = {
        testId: `${rel}::${name}`,
        status: mapStatus(a.status),
        durationMs: a.duration ?? 0,
        attempts: 1,
      };
      if (a.failureMessages?.length)
        exec.error = { message: a.failureMessages.join("\n").slice(0, 4000) };
      out.push(exec);
    }
  }
  return out;
}

export function fileOfTestId(testId: string): string {
  const i = testId.indexOf("::");
  return i === -1 ? testId : testId.slice(0, i);
}
