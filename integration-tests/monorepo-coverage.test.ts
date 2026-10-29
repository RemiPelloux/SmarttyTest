import { SmartTest } from "@smarttest/core";
import { describe, expect, it } from "vitest";
import { edit, materialize } from "./helpers.js";

describe("pnpm-monorepo", () => {
  it("follows workspace imports through exports maps and barrels, at symbol level", async () => {
    const dir = await materialize("pnpm-monorepo", { git: true });
    const st = await SmartTest.open({ root: dir });
    expect((await st.profile()).workspaces.map((w) => w.name).sort()).toEqual([
      "@demo/app",
      "@demo/core-lib",
    ]);
    await edit(dir, "packages/core-lib/src/price.ts", "Math.round(", "Math.round(0 + ");
    const a = await st.analyze();
    expect(a.decision.selectedTests.map((t) => t.filePath).sort()).toEqual([
      "packages/app/test/checkout.test.ts",
      "packages/core-lib/test/price.test.ts",
    ]);
    expect(a.decision.skippedTests.map((t) => t.filePath).sort()).toEqual([
      "packages/app/test/banner.test.ts",
      "packages/core-lib/test/format.test.ts",
    ]);
  }, 60_000);
});

describe("coverage", () => {
  it("labels full-suite coverage as full and selected coverage as selected", async () => {
    const dir = await materialize("nest-auth-vitest", { git: true });
    const st = await SmartTest.open({ root: dir });
    const full = await st.run({ all: true, coverage: true, formats: ["json"] });
    expect(full.report.coverage?.scope).toBe("full");
    expect(full.report.coverage?.lines).toBeGreaterThan(50);
    await edit(dir, "src/modules/catalog/CatalogService.ts", "sum + p.price", "p.price + sum");
    const selected = await (await SmartTest.open({ root: dir })).run({
      coverage: true,
      formats: ["json"],
    });
    expect(selected.report.coverage?.scope).toBe("selected");
    expect(selected.integrityIssues).toEqual([]);
  }, 180_000);
});
