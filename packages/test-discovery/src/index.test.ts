import { matchGlob } from "@smarttest/shared";
import { describe, expect, it } from "vitest";
import {
  assignRunner,
  expandNodePatterns,
  isTestFile,
  nodeStripsTypes,
  testCategory,
} from "./index.js";

describe("test discovery", () => {
  it.each([
    ["src/a.test.ts", true],
    ["src/a.spec.jsx", true],
    ["src/__tests__/a.js", true],
    ["tests/unit/a.test.mts", true],
    ["src/a.ts", false],
    ["src/testing.ts", false],
  ])("%s → %s", (p, expected) => expect(isTestFile(p)).toBe(expected));

  it("honours custom globs", () => {
    expect(isTestFile("checks/a.check.ts", ["**/*.check.ts"])).toBe(true);
    expect(isTestFile("src/a.test.ts", ["**/*.check.ts"])).toBe(false);
  });

  it("infers categories", () => {
    expect(testCategory("tests/integration/db.test.ts")).toBe("integration");
    expect(testCategory("e2e/login.spec.ts")).toBe("e2e");
    expect(testCategory("src/a.test.ts")).toBe("unit");
  });

  it("assigns the deepest runner root", () => {
    const roots = [
      { adapter: "jest" as const, dir: "" },
      {
        adapter: "vitest" as const,
        dir: "packages/web",
        configFile: "packages/web/vitest.config.ts",
      },
    ];
    expect(assignRunner("packages/web/src/a.test.ts", roots)?.adapter).toBe("vitest");
    expect(assignRunner("packages/api/src/a.test.ts", roots)?.adapter).toBe("jest");
  });
});

describe("node --test default patterns", () => {
  const collects = (path: string, patterns: string[] | undefined, stripTypes: boolean) =>
    matchGlob(path, expandNodePatterns(patterns, stripTypes));

  it("a Node that strips types also runs .ts, .mts and .cts files", () => {
    for (const f of ["test/math.ts", "src/math.test.ts", "a-test.mts", "test-a.cts", "x_test.ts"]) {
      expect(collects(f, undefined, true), f).toBe(true);
      expect(collects(f, undefined, false), f).toBe(false);
    }
    expect(collects("test/math.js", undefined, false)).toBe(true);
    // `node --test test/`: the defaults inside the directory.
    expect(collects("test/x.test.ts", ["test/"], true)).toBe(true);
    expect(collects("test/x.test.ts", ["test/"], false)).toBe(false);
    expect(collects("src/math.ts", undefined, true)).toBe(false);
  });

  it("follows the Node that runs the tests (this process: adapters launch process.execPath)", () => {
    const strips = typeof (process.features as { typescript?: unknown }).typescript === "string";
    expect(nodeStripsTypes()).toBe(strips);
    expect(collects("test/math.ts", undefined, nodeStripsTypes())).toBe(strips);
  });
});
