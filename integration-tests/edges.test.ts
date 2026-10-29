/**
 * 0.4.0 edge types: each targeted change selects only the tests that read what changed.
 */
import { SmartTest } from "@smarttest/core";
import { describe, expect, it } from "vitest";
import { edit, git, materialize } from "./helpers.js";

async function selectedAfter(file: string, find: string, replace: string): Promise<string[]> {
  const dir = await materialize("edges-vitest", { git: true });
  await edit(dir, file, find, replace);
  const a = await (await SmartTest.open({ root: dir })).analyze();
  return a.decision.selectedTests.map((t) => t.filePath).sort();
}

describe("edges-vitest", () => {
  it("environment: one key in .env.test selects its readers only", async () => {
    expect(await selectedAfter(".env.test", "FEATURE=1", "FEATURE=0")).toEqual([
      "tests/feature.test.ts",
    ]);
  });

  it("environment: a key no code reads keeps the mandatory trigger", async () => {
    const s = await selectedAfter(".env.test", "FEATURE=1", "FEATURE=1\nUNUSED=1");
    expect(s.length).toBe(17);
  });

  it("assets: a template read through fs selects its reader", async () => {
    expect(await selectedAfter("templates/welcome.txt", "Welcome", "Hi")).toEqual([
      "tests/welcome.test.ts",
    ]);
  });

  it("translations: one catalog key selects the code that reads it", async () => {
    expect(await selectedAfter("src/locales/en/common.ts", '"Hello"', '"Hi"')).toEqual([
      "tests/greet.test.ts",
    ]);
  });

  it("Wasp: an operation change selects client code calling it through wasp/client/operations", async () => {
    expect(
      await selectedAfter("src/ops/getTotal.ts", "sum + i.price", "sum + i.price * 1"),
    ).toEqual(["tests/cart.test.ts"]);
  });

  it("Prisma: a model change selects the code using that model", async () => {
    expect(
      await selectedAfter("prisma/schema.prisma", "total Int", "total Int\n  note  String?"),
    ).toEqual(["tests/orders.test.ts"]);
  });

  it("Prisma: datasource changes widen to the schema's scope", async () => {
    const s = await selectedAfter("prisma/schema.prisma", '"postgresql"', '"mysql"');
    expect(s).toEqual([]); // prisma/ holds no tests and no code imports from it
  });

  it("snapshots: a snapshot file selects its test", async () => {
    expect(await selectedAfter("tests/__snapshots__/format.test.ts.snap", "HI!", "HEY!")).toEqual([
      "tests/format.test.ts",
    ]);
  });

  it("manual mocks: __mocks__/x selects the users of x", async () => {
    expect(await selectedAfter("src/__mocks__/mailer.ts", "mock sent", "mock mailed")).toEqual([
      "tests/notify.test.ts",
    ]);
  });

  it("mock awareness: a test that replaces a module with a factory skips its implementation changes", async () => {
    expect(await selectedAfter("src/stats.ts", "/ xs.length", "/ Math.max(xs.length, 1)")).toEqual([
      "tests/stats.test.ts",
    ]);
  });

  it("mock awareness: a signature change still selects the mocking test", async () => {
    const s = await selectedAfter(
      "src/stats.ts",
      "export function mean(xs: number[])",
      "export function mean(xs: number[], w = 1)",
    );
    expect(s).toEqual(["tests/report.test.ts", "tests/stats.test.ts"]);
  });

  it("generated code: a generator input stands for its outputs", async () => {
    const dir = await materialize("edges-vitest", { git: true });
    await edit(dir, "codegen/schema.json", '"version": 1', '"version": 2');
    const a = await (await SmartTest.open({ root: dir })).analyze();
    expect(a.decision.selectedTests.map((t) => t.filePath)).toEqual(["tests/version.test.ts"]);
    expect(a.decision.warnings.join("\n")).toContain("rebuild-required");
    git(dir, "status");
  });
});
