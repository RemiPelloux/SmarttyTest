/**
 * Fail-safe under faults (S29): a corrupt or half-written state file, a state folder SmartTest
 * cannot write, changes that cannot be read, a failing plugin and a killed runner never end in a
 * smaller selection or a pass. Each case breaks a test first, injects the fault, then runs.
 */
import { chmod, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SmartTest } from "@smarttest/core";
import { describe, expect, it } from "vitest";
import { edit, git, materialize } from "./helpers.js";

const BROKEN = "test/strings.test.ts";

/** Adaptive mode off: under load it may run everything, which would hide a smaller selection. */
const CONFIG = "export default { adaptive: false };\n";

/** ts-lib-vitest after one full run (state written), with `capitalize` broken. */
async function project(config = CONFIG, files: Record<string, string> = {}): Promise<string> {
  const dir = await materialize("ts-lib-vitest", { git: true });
  await writeFile(join(dir, "smarttest.config.mjs"), config);
  for (const [f, text] of Object.entries(files)) await writeFile(join(dir, f), text);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "config");
  const first = await (await SmartTest.open({ root: dir })).run({ all: true, formats: [] });
  expect(first.exitCode).toBe(0);
  await edit(dir, "src/util/strings.ts", "s.charAt(0).toUpperCase()", "s.charAt(0)");
  return dir;
}

async function runAffected(dir: string) {
  const outcome = await (await SmartTest.open({ root: dir })).run({ formats: [], cache: true });
  const report = outcome.report;
  return {
    exitCode: outcome.exitCode,
    selected: report.decision.selectedTests.map((t) => t.filePath).sort(),
    broken: report.executions.find((e) => e.file === BROKEN)?.status,
    warnings: [...report.decision.warnings, ...(report.warnings ?? [])].join("\n"),
  };
}

/** What a change to `capitalize` selects (the tests importing strings.ts). */
const clean = { selected: ["test/labeler.test.ts", BROKEN] };

describe("fail-safe under faults", () => {
  it("the clean run selects and fails the broken test", async () => {
    const r = await runAffected(await project());
    expect(r.broken).toBe("failed");
    expect(r.exitCode).not.toBe(0);
    expect(r.selected).toEqual(clean.selected);
  }, 120_000);

  const corruptions: [string, string, (text: string) => string][] = [];
  for (const file of [
    "state/graph.json",
    "state/index.json",
    "state/discovery.json",
    "state/history.json",
    "state/durations.json",
    "state/timings.json",
    "runs/last-decision.json",
  ]) {
    corruptions.push([file, "garbage", () => "garbage{"]);
    corruptions.push([file, "half-written", (t) => t.slice(0, Math.floor(t.length / 2))]);
    corruptions.push([file, "empty", () => ""]);
  }
  it.each(corruptions)(
    "%s %s: same selection, the failure is reported",
    async (file, _kind, mangle) => {
      const dir = await project();
      const path = join(dir, ".smarttest", file);
      const { readFile } = await import("node:fs/promises");
      await writeFile(path, mangle(await readFile(path, "utf8").catch(() => "")));
      const r = await runAffected(dir);
      expect(r.selected).toEqual(expect.arrayContaining(clean.selected));
      expect(r.broken).toBe("failed");
      expect(r.exitCode).not.toBe(0);
    },
    120_000,
  );

  it("state signatures deleted: same selection", async () => {
    const dir = await project();
    for (const f of ["graph", "index", "discovery"])
      await rm(join(dir, ".smarttest", "state", `${f}.json.mac`), { force: true });
    const r = await runAffected(dir);
    expect(r.selected).toEqual(expect.arrayContaining(clean.selected));
    expect(r.broken).toBe("failed");
  }, 120_000);

  it("a state folder SmartTest cannot write: a temporary one, with a warning", async () => {
    const dir = await project();
    await rm(join(dir, ".smarttest", "state"), { recursive: true });
    await writeFile(join(dir, ".smarttest", "state"), "not a folder");
    const r = await runAffected(dir);
    expect(r.warnings).toContain("cannot be written");
    expect(r.selected).toEqual(expect.arrayContaining(clean.selected));
    expect(r.broken).toBe("failed");
    expect(r.exitCode).not.toBe(0);
  }, 120_000);

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "changes that cannot be read: every test runs, with a warning",
    async () => {
      const dir = await project();
      await chmod(join(dir, "src/util/numbers.ts"), 0o000);
      try {
        const r = await runAffected(dir);
        expect(r.warnings).toContain("The changes could not be read");
        expect(r.selected).toEqual([
          "test/cache.test.ts",
          "test/labeler.test.ts",
          "test/numbers.test.ts",
          BROKEN,
        ]);
        expect(r.broken).toBe("failed");
        expect(r.exitCode).not.toBe(0);
      } finally {
        await chmod(join(dir, "src/util/numbers.ts"), 0o644);
      }
    },
    120_000,
  );

  it("a plugin that fails: every test runs, with a warning", async () => {
    // It fails once boom.flag exists, after the setup's clean run.
    const plugin = `import { existsSync } from "node:fs";
import { join } from "node:path";
export default { apiVersion: 1, name: "boom", edgeProviders: [{ apiVersion: 1, id: "boom",
  getCapabilities: () => ({ fileEdges: true, unresolved: true }),
  provideEdges(ctx) {
    if (existsSync(join(ctx.root, "boom.flag"))) throw new Error("plugin boom");
    return { edges: [], unresolved: [] };
  } }] };
`;
    const dir = await project('export default { adaptive: false, plugins: ["./boom.mjs"] };\n', {
      "boom.mjs": plugin,
    });
    await writeFile(join(dir, "boom.flag"), "");
    const r = await runAffected(dir);
    expect(r.warnings).toContain("plugin boom");
    expect(r.selected.length).toBeGreaterThanOrEqual(4);
    expect(r.broken).toBe("failed");
    expect(r.exitCode).not.toBe(0);
  }, 120_000);

  it("a runner killed in the middle of a file: the run fails", async () => {
    const dir = await materialize("ts-lib-vitest", { git: true });
    await writeFile(
      join(dir, "test/dies.test.ts"),
      'import { it } from "vitest";\nimport { kebab } from "../src/util/strings";\nit("dies", () => { kebab("x"); process.kill(process.pid, "SIGKILL"); });\n',
    );
    const outcome = await (await SmartTest.open({ root: dir })).run({ formats: [] });
    expect(outcome.report.decision.selectedTests.map((t) => t.filePath)).toContain(
      "test/dies.test.ts",
    );
    const dies = outcome.report.executions.find((e) => e.file === "test/dies.test.ts");
    expect(dies?.status).not.toBe("passed");
    expect(outcome.exitCode).not.toBe(0);
  }, 120_000);
});
