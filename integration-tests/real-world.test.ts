import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { benchmarkHistory, benchmarkMarkdown, SmartTest } from "@smarttest/core";
import { describe, expect, it } from "vitest";
import { edit, git, materialize } from "./helpers.js";

describe("node:test projects", () => {
  it("detects node --test, honours its directory argument and selects at symbol level", async () => {
    const dir = await materialize("node-test-esm", { git: true });
    const st = await SmartTest.open({ root: dir });
    const { tests } = await st.discoverTests((await st.loadIndex()).index);
    // "node --test test/" runs the default patterns inside test/: helpers are not tests.
    expect(tests).toEqual(["test/cart.test.js", "test/slug.test.js"]);
    await edit(dir, "src/money.js", "Math.round(n * 100) / 100", "Math.round(n * 100) / 10");
    const out = await st.run({ formats: ["json"] });
    expect(out.report.decision.selectedTests.map((t) => t.filePath)).toEqual(["test/cart.test.js"]);
    expect(out.report.executions[0]?.status).toBe("failed");
    expect(out.exitCode).toBe(1);
  }, 60_000);
});

describe("repositories of independent projects", () => {
  it("finds nested projects without a workspace manifest and ignores git-ignored build output", async () => {
    const dir = await materialize("nest-auth-vitest", { git: true });
    // simulate generated output with its own package.json, ignored by git (like .wasp/ or out/)
    await mkdir(join(dir, "generated-out/sdk"), { recursive: true });
    await writeFile(
      join(dir, "generated-out/sdk/package.json"),
      JSON.stringify({ name: "sdk", devDependencies: { vitest: "*" } }),
    );
    await writeFile(join(dir, ".gitignore"), "node_modules\n.smarttest/\ngenerated-out/\n");
    const st = await SmartTest.open({ root: dir });
    const profile = await st.profile();
    expect(profile.workspaces.map((w) => w.dir)).not.toContain("generated-out/sdk");
    expect(profile.runners.map((r) => r.dir)).toEqual([""]);
  }, 60_000);
});

describe("history benchmark", () => {
  it("replays commits, compares full / project-gated / SmartTest and finds no missed failure", async () => {
    const dir = await materialize("nest-auth-vitest", { git: true });
    await edit(dir, "src/modules/catalog/CatalogService.ts", "sum + p.price", "p.price + sum");
    git(dir, "commit", "-qam", "catalog: reorder sum");
    await edit(
      dir,
      "src/shared/validators/EmailValidator.ts",
      "return /",
      "return value.length < 320 && /",
    );
    git(dir, "commit", "-qam", "email: cap length");
    const st = await SmartTest.open({ root: dir });
    const b = await benchmarkHistory(st, { commits: 2 });
    expect(b.commits.map((c) => c.subject)).toEqual(["catalog: reorder sum", "email: cap length"]);
    expect(b.commits[0]?.selectedTests).toBe(1);
    expect(b.commits[1]?.selectedTests).toBe(4);
    expect(b.totals.missed).toBe(0);
    expect(b.totals.smarttestMs).toBeGreaterThan(0);
  }, 180_000);

  // 1.0.2: MiaDock.test.tsx and tournament-pool.test.ts failed only under full-suite load and were
  // counted as misses. A test failing only next to another is load-flaky, never a miss or a pass.
  it("a failure that only happens next to other tests is load-flaky, not a miss", async () => {
    const dir = await materialize("nest-auth-vitest", { git: true });
    // The holder runs with the catalog tests; the fragile test fails when it sees, in its own
    // Vitest run (same parent process), the marker the holder wrote. Alone it passes.
    const marker =
      'const marker = join(dirname(fileURLToPath(import.meta.url)), ".holder-" + process.ppid);';
    const header =
      'import { existsSync, writeFileSync } from "node:fs";\nimport { dirname, join } from "node:path";\nimport { fileURLToPath } from "node:url";\nimport { expect, it } from "vitest";\n';
    await writeFile(
      join(dir, "tests/unit/holder.test.ts"),
      `${header}import { CatalogService } from "../../src/modules/catalog/CatalogService";\n${marker}\nwriteFileSync(marker, "");\nit("holds", () => expect(CatalogService).toBeDefined());\n`,
    );
    await writeFile(
      join(dir, "tests/unit/fragile.test.ts"),
      `${header}${marker}\nit("fails next to the holder", async () => {\n  for (let i = 0; i < 80 && !existsSync(marker); i++) await new Promise((r) => setTimeout(r, 100));\n  expect(existsSync(marker)).toBe(false);\n}, 20_000);\n`,
    );
    await writeFile(join(dir, ".gitignore"), "node_modules\n.smarttest/\n.holder-*\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "holder and fragile tests");
    await edit(dir, "src/modules/catalog/CatalogService.ts", "sum + p.price", "p.price + sum");
    git(dir, "commit", "-qam", "catalog: reorder sum");
    const st = await SmartTest.open({ root: dir });
    const b = await benchmarkHistory(st, { commits: 1 });
    const [c] = b.commits;
    expect(c?.failingInFull).toContain("tests/unit/fragile.test.ts");
    expect(c?.missed).toEqual([]);
    expect(c?.loadFlaky).toEqual(["tests/unit/fragile.test.ts"]);
    expect(b.totals.loadFlaky).toBe(1);
    expect(benchmarkMarkdown(b)).toContain("load-flaky: tests/unit/fragile.test.ts");
  }, 240_000);

  // OpenPro's front end: vitest.config.ts next to vitest.stryker.config.ts made the project-gated
  // baseline count the one Vitest group twice (226 s gated for a 113 s full run).
  it("times a project with two configs of one runner once in the project-gated baseline", async () => {
    const dir = await materialize("nest-auth-vitest", { git: true });
    await writeFile(
      join(dir, "vitest.mutation.config.ts"),
      'import { defineConfig } from "vitest/config";\nexport default defineConfig({ test: { include: ["tests/never/**/*.test.ts"] } });\n',
    );
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "mutation config");
    await edit(dir, "src/modules/catalog/CatalogService.ts", "sum + p.price", "p.price + sum");
    git(dir, "commit", "-qam", "catalog");
    const st = await SmartTest.open({ root: dir });
    expect((await st.runnerRoots()).filter((r) => r.adapter === "vitest")).toHaveLength(2);
    const b = await benchmarkHistory(st, { commits: 1 });
    const [c] = b.commits;
    expect(c?.projectGatedTests).toBe(c?.totalTests);
    // One group ran; the gated time is that group's time, never more than the whole full run.
    expect(c?.projectGatedMs).toBeLessThanOrEqual(c?.fullMs as number);
    expect(b.totals.missed).toBe(0);
  }, 180_000);
});
