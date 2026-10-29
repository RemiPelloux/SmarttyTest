import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { benchmarkHistory, SmartTest } from "@smarttest/core";
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
    expect(b.commits[1]?.selectedTests).toBe(5);
    expect(b.totals.missed).toBe(0);
    expect(b.totals.smarttestMs).toBeGreaterThan(0);
  }, 180_000);
});
