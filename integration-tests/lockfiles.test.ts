/**
 * Lockfile and manifest changes select by package (S31): the code importing a package whose
 * resolved entry changed, or a package depending on it; everything when a test tool, a package no
 * analysed file imports, or a lockfile setting changed.
 */
import { SmartTest } from "@smarttest/core";
import { describe, expect, it } from "vitest";
import { edit, materialize } from "./helpers.js";

async function selectionAfter(
  changes: [file: string, find: string, replace: string][],
): Promise<{ selected: string[]; reasons: string[] }> {
  const dir = await materialize("lockfile-packages", { git: true });
  for (const [file, find, replace] of changes) await edit(dir, file, find, replace);
  const a = await (await SmartTest.open({ root: dir })).analyze();
  return {
    selected: a.decision.selectedTests.map((t) => t.filePath).sort(),
    reasons: a.decision.selectedTests.flatMap((t) => t.reasons.map((r) => r.message)),
  };
}

const ALL = ["test/pad.test.ts", "test/price.test.ts", "test/report.test.ts"];

describe("lockfile-packages", () => {
  it("a bumped package selects the tests reaching the code that imports it", async () => {
    const bumped = await selectionAfter([
      ["yarn.lock", 'money-lib@^1.0.0:\n  version "1.0.0"', 'money-lib@^1.0.0:\n  version "1.0.1"'],
    ]);
    expect(bumped.selected).toEqual(["test/price.test.ts"]);
    expect(bumped.reasons.join("\n")).toContain("money-lib, which changed in yarn.lock");
  });

  it("a transitive dependency selects through the package depending on it", async () => {
    const r = await selectionAfter([
      ["yarn.lock", 'tz-data@^1.0.0:\n  version "1.0.0"', 'tz-data@^1.0.0:\n  version "1.1.0"'],
    ]);
    expect(r.selected).toEqual(["test/report.test.ts"]);
  });

  it("package.json and yarn.lock bumped together (a dependency update)", async () => {
    const r = await selectionAfter([
      ["package.json", '"left-pad": "^1.3.0"', '"left-pad": "^1.3.1"'],
      ["yarn.lock", 'left-pad@^1.3.0:\n  version "1.3.0"', 'left-pad@^1.3.1:\n  version "1.3.1"'],
    ]);
    expect(r.selected).toEqual(["test/pad.test.ts"]);
  });

  it("@types packages select the code importing the typed package", async () => {
    const r = await selectionAfter([
      [
        "yarn.lock",
        '"@types/left-pad@^1.2.0":\n  version "1.2.0"',
        '"@types/left-pad@^1.2.0":\n  version "1.2.1"',
      ],
    ]);
    expect(r.selected).toEqual(["test/pad.test.ts"]);
  });

  it("a lint tool or its dependencies select nothing", async () => {
    const r = await selectionAfter([
      ["yarn.lock", 'esquery@^1.5.0:\n  version "1.5.0"', 'esquery@^1.5.0:\n  version "1.6.0"'],
    ]);
    expect(r.selected).toEqual([]);
  });

  it("the test runner, or a dependency of it, selects everything", async () => {
    const r = await selectionAfter([
      ["yarn.lock", 'tinypool@^1.0.0:\n  version "1.0.0"', 'tinypool@^1.0.0:\n  version "1.1.0"'],
    ]);
    expect(r.selected).toEqual(ALL);
    expect(r.reasons.join("\n")).toContain("vitest");
  });

  it("any other package.json field selects everything", async () => {
    const r = await selectionAfter([
      ["package.json", '"test": "vitest run"', '"test": "vitest run --silent"'],
    ]);
    expect(r.selected).toEqual(ALL);
    expect(r.reasons.join("\n")).toContain('"scripts" changed');
  });
});
