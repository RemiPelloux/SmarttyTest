/**
 * 1.2.0 barrel and re-export pruning: a change behind a barrel selects only the importers of the
 * symbol that changed, through any depth of re-exports (`export *`, `export { a as b } from`,
 * `export * as ns`, default re-exports). What the analysis cannot pin to a symbol keeps selecting:
 * a member read by a computed name, a barrel whose loading runs code, a CommonJS barrel, code
 * that runs when a module loads.
 */
import { SmartTest } from "@smarttest/core";
import { describe, expect, it } from "vitest";
import { edit, materialize } from "./helpers.js";

async function selectedAfter(file: string, find: string, replace: string): Promise<string[]> {
  const dir = await materialize("barrels-vitest", { git: true });
  await edit(dir, file, find, replace);
  const a = await (await SmartTest.open({ root: dir })).analyze();
  return a.decision.selectedTests.map((t) => t.filePath).sort();
}

/** Reads a member by a computed name (`shop[name]`): any change behind the barrel selects it. */
const LOOKUP = "test/lookup.test.ts";
/** Every importer of the top-level barrel `src/index.ts`. */
const ALL_SHOP = [
  "test/cart.test.ts",
  "test/count.test.ts",
  "test/discount.test.ts",
  "test/greet.test.ts",
  LOOKUP,
  "test/money.test.ts",
  "test/price.test.ts",
];

describe("barrels-vitest: pruning", () => {
  it("`export *` two levels deep: a change to price selects price's importers only", async () => {
    expect(
      await selectedAfter("src/shop/pricing.ts", "return cents / 100;", "return cents / 10;"),
    ).toEqual([LOOKUP, "test/price.test.ts"]);
  });

  it("a sibling in the same module is not selected", async () => {
    expect(await selectedAfter("src/shop/pricing.ts", "(1 - pct / 100)", "(1 - pct / 10)")).toEqual(
      ["test/discount.test.ts", LOOKUP],
    );
  });

  it("`export { total as cartTotal }`: the alias's importers, not those of `count`", async () => {
    expect(await selectedAfter("src/shop/cart.ts", "sum + n, 0", "sum + n, 1")).toEqual([
      "test/cart.test.ts",
      LOOKUP,
    ]);
  });

  it("`export * as format`: importers reading `format.money`", async () => {
    expect(await selectedAfter("src/format.ts", "`$${", "`€${")).toEqual([
      LOOKUP,
      "test/money.test.ts",
    ]);
  });

  it("`export { default as greet }`", async () => {
    expect(await selectedAfter("src/greet.ts", "Hello", "Hi")).toEqual([
      "test/greet.test.ts",
      LOOKUP,
    ]);
  });

  it("a barrel's renamed re-export selects the importers of that name, not the barrel's", async () => {
    expect(
      await selectedAfter("src/shop/index.ts", "total as cartTotal", "count as cartTotal"),
    ).toEqual(["test/cart.test.ts", "test/count.test.ts", LOOKUP]);
  });
});

describe("barrels-vitest: what stays conservative", () => {
  it("code run when a module behind the barrel loads reaches every importer", async () => {
    expect(
      await selectedAfter(
        "src/shop/pricing.ts",
        "export function discount",
        'if (Date.now() < 0) throw new Error("load-time");\nexport function discount',
      ),
    ).toEqual(ALL_SHOP);
  });

  it("a re-export that loads another module reaches every importer of the barrel", async () => {
    expect(
      await selectedAfter(
        "src/shop/index.ts",
        'export * from "./pricing";',
        'export * from "./pricing";\nexport { greet as hello } from "../greet";',
      ),
    ).toEqual(ALL_SHOP);
  });

  it("a barrel whose loading reads its re-exports selects every importer", async () => {
    expect(await selectedAfter("src/plugins/alpha.ts", '"alpha"', '"ALPHA"')).toEqual([
      "test/alpha.test.ts",
      "test/beta.test.ts",
    ]);
  });

  it("a CommonJS barrel selects every importer", async () => {
    expect(await selectedAfter("src/legacy/two.cjs", "return 2;", "return 3;")).toEqual([
      "test/one.test.ts",
      "test/two.test.ts",
    ]);
  });
});
