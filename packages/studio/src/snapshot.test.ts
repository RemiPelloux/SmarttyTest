import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { benchmarkOf, loadCoverage, loadLastRun, readProjectFile } from "./snapshot.js";

const report = {
  schemaVersion: 1,
  tool: { name: "smarttest", version: "0.9.0" },
  runId: "run_from_latest",
  command: "smarttest run",
  startedAt: "2026-01-01T00:00:00.000Z",
  finishedAt: "2026-01-01T00:00:01.000Z",
  project: { name: "fixture", root: "/tmp/fixture", packageManager: "pnpm", runner: "vitest" },
  mode: "balanced",
  change: { provider: "git", description: "one file", files: [] },
  decision: { selectedTests: [], skippedTests: [], analysisStatus: "complete" },
  executions: [],
  summary: {
    totalTests: 0,
    selected: 0,
    executed: 0,
    skippedBySelection: 0,
    passed: 0,
    failed: 0,
    flaky: 0,
    timedOut: 0,
    cancelled: 0,
    infrastructureErrors: 0,
    skippedByTests: 0,
    cached: 0,
    durationMs: 1000,
  },
  coverage: { scope: "selected", lines: 40, branches: 30, functions: 20, statements: 40, files: 1 },
  timings: {},
  warnings: [],
};

describe("source containment", () => {
  it("refuses external symlinks, including files replaced after an earlier snapshot read", async () => {
    const base = await mkdtemp(join(tmpdir(), "studio-symlink-"));
    const root = join(base, "project");
    try {
      await mkdir(root);
      await writeFile(join(base, "secret.ts"), "private data");
      await symlink(join(base, "secret.ts"), join(root, "external.ts"));
      expect(await readProjectFile(root, "external.ts")).toBeNull();
      await writeFile(join(root, "changed.ts"), "original");
      expect(await readProjectFile(root, "changed.ts")).toBe("original");
      await rm(join(root, "changed.ts"));
      await symlink(join(base, "secret.ts"), join(root, "changed.ts"));
      expect(await readProjectFile(root, "changed.ts")).toBeNull();
      await symlink(base, join(root, "outside"));
      expect(await readProjectFile(root, "outside/secret.ts")).toBeNull();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe("benchmark evidence", () => {
  const totals = {
    commits: 3,
    fullMs: 1000,
    smarttestMs: 400,
    savedVsFullPct: 60,
    missed: 2,
    cacheViolations: 1,
    selectedTests: 4,
    totalTests: 10,
  };
  it("reads core's totals and preserves missed failures and cache violations", () => {
    expect(benchmarkOf({ mode: "safe", commits: [], totals })).toMatchObject({
      commits: 3,
      savedPct: 60,
      missed: 2,
      cacheViolations: 1,
    });
  });
  it("keeps missing measurements unavailable rather than claiming zero misses", () => {
    expect(benchmarkOf({ mode: "safe", commits: 3 })).toBeNull();
    expect(benchmarkOf({ mode: "safe", totals: { ...totals, missed: undefined } })).toBeNull();
    expect(benchmarkOf({ mode: "safe", totals: { ...totals, cacheViolations: null } })).toBeNull();
  });
});

describe("last run", () => {
  it("falls back to runs/latest.json because core never writes reports/last-run.json", async () => {
    const store = await mkdtemp(join(tmpdir(), "studio-last-run-"));
    try {
      await mkdir(join(store, "runs"), { recursive: true });
      await writeFile(join(store, "runs", "latest.json"), JSON.stringify(report), "utf8");
      const run = await loadLastRun(store);
      expect(run?.id).toBe("run_from_latest");
      expect(run?.summary?.totalTests).toBe(0);
      expect(run?.coverage?.scope).toBe("selected");
      expect((await loadCoverage(store))?.summary.lines).toBe(40);
    } finally {
      await rm(store, { recursive: true, force: true });
    }
  });
});
