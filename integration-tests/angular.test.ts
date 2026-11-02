/**
 * Angular component resources: a template or stylesheet a component loads by path selects that
 * component's tests, and only those (S28).
 */
import { SmartTest } from "@smarttest/core";
import { describe, expect, it } from "vitest";
import { edit, materialize } from "./helpers.js";

async function selectedAfter(file: string, find: string, replace: string): Promise<string[]> {
  const dir = await materialize("angular-vitest", { git: true });
  await edit(dir, file, find, replace);
  const a = await (await SmartTest.open({ root: dir })).analyze();
  return a.decision.selectedTests.map((t) => t.filePath).sort();
}

describe("angular-vitest", () => {
  it("templateUrl: a template change selects its component's specs only", async () => {
    expect(await selectedAfter("src/app/greeting.component.html", "Hello", "Hi")).toEqual([
      "test/greeting.component.spec.ts",
    ]);
  });

  it("styleUrl: a component stylesheet change selects its component's specs only", async () => {
    expect(await selectedAfter("src/app/badge.component.css", "600", "700")).toEqual([
      "test/badge.component.spec.ts",
    ]);
  });

  it("a stylesheet imported by a component stylesheet selects that component's specs", async () => {
    expect(await selectedAfter("src/styles/tokens.css", "#c00", "#0c0")).toEqual([
      "test/greeting.component.spec.ts",
    ]);
  });

  it("services injected into components keep ordinary import edges", async () => {
    expect(await selectedAfter("src/app/format.service.ts", "toFixed(2)", "toFixed(1)")).toEqual([
      "test/price.component.spec.ts",
    ]);
  });
});
