import { describe, expect, it } from "vitest";
import { applyTokens, targetPath } from "./index.js";

const opts = { directory: "tests", type: "unit" as const };

describe("targetPath", () => {
  it("mirrors the source tree under tests/<type>", () => {
    expect(
      targetPath("src/modules/auth/AuthService.ts", undefined, { ...opts, layout: "mirror" }),
    ).toBe("tests/unit/modules/auth/AuthService.test.ts");
  });
  it("colocates", () => {
    expect(
      targetPath("src/modules/auth/AuthService.ts", undefined, { ...opts, layout: "colocated" }),
    ).toBe("src/modules/auth/AuthService.test.ts");
  });
  it("groups by domain", () => {
    expect(
      targetPath("src/modules/auth/services/AuthService.ts", undefined, {
        ...opts,
        layout: "domain",
      }),
    ).toBe("tests/unit/auth/AuthService.test.ts");
  });
  it("keeps workspace package prefixes", () => {
    expect(
      targetPath("packages/api/src/users/UserService.ts", undefined, { ...opts, layout: "mirror" }),
    ).toBe("packages/api/tests/unit/users/UserService.test.ts");
  });
  it("supports custom naming tokens", () => {
    expect(
      targetPath("src/a/b.tsx", undefined, {
        ...opts,
        layout: "mirror",
        naming: "{FileName}.{Type}.spec.{Extension}",
      }),
    ).toBe("tests/unit/a/b.unit.spec.tsx");
  });
  it("rejects unknown tokens", () => {
    expect(() => applyTokens("{Nope}.ts", { FileName: "x" })).toThrow(/Unknown naming token/);
  });
});
