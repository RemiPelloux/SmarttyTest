import { describe, expect, it } from "vitest";
import { assignRunner, isTestFile, testCategory } from "./index.js";

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
