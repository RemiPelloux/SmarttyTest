/**
 * 0.8.0 speed: validated result cache, sharding, fail-fast order, parallel groups, flaky history,
 * incremental graph patches, Subversion and Mercurial adapters.
 */
import { execFileSync } from "node:child_process";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { flakyReport, parseShard, SmartTest, shardFiles } from "@smarttest/core";
import { describe, expect, it } from "vitest";
import { failFastOrder, recordRun } from "../packages/core/src/speed.js";
import { edit, FIXTURES, materialize } from "./helpers.js";

const has = (cmd: string, args: string[]) => {
  try {
    execFileSync(cmd, args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
const HG =
  process.env.SMARTTEST_HG ??
  (has("hg", ["--version"])
    ? "hg"
    : has("/tmp/hgvenv/bin/hg", ["--version"])
      ? "/tmp/hgvenv/bin/hg"
      : undefined);

describe("validated result cache", () => {
  it("reuses a pass only while every input is unchanged, and reports it as cached", async () => {
    const dir = await materialize("edges-vitest", { git: true });
    await edit(dir, "src/config.ts", "export function apiUrl", "// note\nexport function apiUrl");
    const first = await (await SmartTest.open({ root: dir })).run({});
    const selected = first.report.decision.selectedTests.map((t) => t.filePath);
    expect(selected.length).toBeGreaterThan(0);
    expect(first.report.summary.cached).toBe(0);

    const second = await (await SmartTest.open({ root: dir })).run({});
    expect(second.report.summary.cached).toBe(
      second.report.executions.flatMap((e) => e.tests).length,
    );
    expect(second.report.executions.every((e) => e.status === "cached-pass")).toBe(true);
    expect(second.report.summary.passed).toBe(0); // cached ≠ passed in this run
    expect(second.integrityIssues).toEqual([]);

    // Any input change invalidates: here the source itself.
    await edit(dir, "src/config.ts", '"none"', '"nothing"');
    const third = await (await SmartTest.open({ root: dir })).run({});
    expect(third.report.summary.cached).toBe(0);
    // …and so does an env file the tests read.
    await (await SmartTest.open({ root: dir })).run({});
    await writeFile(
      join(dir, ".env.test"),
      (await readFile(join(dir, ".env.test"), "utf8")).replace(
        "API_URL=https://api.test",
        "API_URL=https://api.test\n",
      ),
    );
    const fourth = await (await SmartTest.open({ root: dir })).run({ mode: "balanced" });
    expect(fourth.report.executions.some((e) => e.status === "cached-pass")).toBe(false);

    const off = await (await SmartTest.open({ root: dir })).run({ cache: false });
    expect(off.report.summary.cached).toBe(0);
  }, 180_000);
});

describe("sharding, ordering, history", () => {
  it("splits by duration deterministically", () => {
    const files = ["a", "b", "c", "d", "e"];
    const shards = shardFiles(files, { a: 100, b: 90, c: 10, d: 10, e: 10 }, 2);
    expect(shards).toEqual([
      ["a", "d"],
      ["b", "c", "e"],
    ]);
    expect(shards.flat().sort()).toEqual(files);
    expect(parseShard("2/3")).toEqual({ index: 2, total: 3 });
    expect(parseShard("4/3")).toBeUndefined();
  });

  it("orders recent failures first, then by distance from the change", () => {
    const order = failFastOrder(
      ["far", "near", "failed"],
      new Map([["failed", "2026-01-01"]]),
      (f) => (f === "near" ? 1 : 5),
    );
    expect(order).toEqual(["failed", "near", "far"]);
  });

  it("reports tests that flip between pass and fail", () => {
    const store = { version: 1 as const, tests: {} };
    for (const s of ["passed", "failed", "passed", "passed", "failed", "passed"] as const)
      recordRun(store, [{ testId: "a.test.ts::x", status: s, durationMs: 1, attempts: 1 }]);
    for (let i = 0; i < 6; i++)
      recordRun(store, [{ testId: "b.test.ts::y", status: "passed", durationMs: 1, attempts: 1 }]);
    const r = flakyReport(store);
    expect(r.map((e) => e.testId)).toEqual(["a.test.ts::x"]);
    expect(r[0]?.recent).toBe("PFPPFP");
  });

  it("runs only its shard", async () => {
    const dir = await materialize("edges-vitest", { git: true });
    // Every shard of a CI matrix sees the same recorded durations.
    const st = await SmartTest.open({ root: dir });
    await st.run({ all: true });
    const durations = await readFile(join(st.storeDir, "state/durations.json"), "utf8");
    const one = await (await SmartTest.open({ root: dir })).run({
      all: true,
      shard: { index: 1, total: 2 },
    });
    await writeFile(join(st.storeDir, "state/durations.json"), durations);
    const two = await (await SmartTest.open({ root: dir })).run({
      all: true,
      shard: { index: 2, total: 2 },
    });
    const a = one.report.executions.map((e) => e.file);
    const b = two.report.executions.map((e) => e.file);
    expect([...a, ...b].sort()).toEqual(one.analysis.testFiles);
    expect(a.filter((f) => b.includes(f))).toEqual([]);
    expect(one.report.warnings.join(" ")).toMatch(/Shard 1\/2/);
  }, 180_000);
});

describe("incremental graph (watch)", () => {
  it("patches the graph for a body change and selects exactly what a rebuild selects", async () => {
    const dir = await materialize("nest-auth-vitest", { git: true });
    const warm = await SmartTest.open({ root: dir });
    warm.keepWarm = true;
    await warm.analyze();
    expect(warm.lastGraphBuild).toBe("built");
    await edit(
      dir,
      "src/modules/auth/AuthService.ts",
      "return this.tokens.verify(token);",
      "return token.length > 0;",
    );
    const patched = await warm.analyze();
    expect(warm.lastGraphBuild).toBe("patched");
    const cold = await (await SmartTest.open({ root: dir })).analyze();
    const sel = (a: typeof cold) => a.decision.selectedTests.map((t) => t.filePath);
    expect(sel(patched)).toEqual(sel(cold));
    // The patched graph no longer links validateToken to TokenManager.verify.
    expect(
      patched.graph.why(
        "src/modules/auth/TokenManager.ts#TokenManager.verify",
        "test/routes/ProtectedRoutes.test.ts",
      ),
    ).toBeUndefined();
    // An export change is structural: rebuilt.
    await edit(
      dir,
      "src/modules/auth/AuthService.ts",
      "export class AuthService",
      "export class AuthService2 {}\nexport class AuthService",
    );
    await warm.analyze();
    expect(warm.lastGraphBuild).toBe("built");
  }, 120_000);
});

describe("Subversion and Mercurial", () => {
  it("svn: working copy changes with line ranges and BASE content", async () => {
    if (!has("svn", ["--version"])) return;
    const repo = await mkdtemp(join(tmpdir(), "st-svnrepo-"));
    const wc = await mkdtemp(join(tmpdir(), "st-svnwc-"));
    execFileSync("svnadmin", ["create", repo]);
    execFileSync("svn", ["checkout", "-q", `file://${repo}`, wc]);
    await cp(join(FIXTURES, "node-test-esm"), wc, {
      recursive: true,
      filter: (p) => !p.includes("node_modules"),
    });
    execFileSync("svn", ["add", "-q", "--force", "."], { cwd: wc });
    execFileSync("svn", ["commit", "-q", "-m", "init"], { cwd: wc });
    await edit(wc, "src/money.js", "Math.round", "Math.floor");
    const st = await SmartTest.open({ root: wc });
    expect(await st.provider()).toBe("svn");
    const a = await st.analyze();
    expect(a.input.changeSet.changes).toEqual([
      {
        type: "modified",
        path: "src/money.js",
        changedRanges: [
          { start: { line: 1, column: 0 }, end: { line: 1, column: Number.MAX_SAFE_INTEGER } },
        ],
      },
    ]);
    expect(a.decision.selectedTests.map((t) => t.filePath)).toEqual(["test/cart.test.js"]);
    expect(await a.input.readBefore("src/money.js")).toContain("Math.round");
  }, 60_000);

  it("hg: working directory and revision changes", async () => {
    if (!HG) return;
    const dir = await mkdtemp(join(tmpdir(), "st-hg-"));
    await cp(join(FIXTURES, "node-test-esm"), dir, {
      recursive: true,
      filter: (p) => !p.includes("node_modules"),
    });
    const hg = (...args: string[]) =>
      execFileSync(HG, args, { cwd: dir, env: { ...process.env, HGUSER: "t <t@t>" } });
    hg("init");
    hg("addremove", "-q");
    hg("commit", "-m", "init");
    await edit(dir, "src/slug.js", "toLowerCase()", "toLowerCase().trim()");
    const prevPath = process.env.PATH;
    process.env.PATH = `${join(HG, "..")}:${prevPath}`;
    try {
      const st = await SmartTest.open({ root: dir });
      expect(await st.provider()).toBe("hg");
      const a = await st.analyze();
      expect(a.input.changeSet.changes.map((c) => [c.type, c.path])).toEqual([
        ["modified", "src/slug.js"],
      ]);
      expect(a.input.changeSet.changes[0]?.changedRanges?.length).toBe(1);
      expect(a.decision.selectedTests.map((t) => t.filePath)).toEqual(["test/slug.test.js"]);
      hg("commit", "-m", "trim");
      const b = await (await SmartTest.open({ root: dir })).analyze({
        source: { kind: "base", ref: ".^", direct: true },
      });
      expect(b.input.changeSet.changes.map((c) => c.path)).toEqual(["src/slug.js"]);
    } finally {
      process.env.PATH = prevPath;
    }
  }, 60_000);
});
