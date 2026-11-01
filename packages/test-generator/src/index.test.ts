import { mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyGeneration, applyTokens, targetPath } from "./index.js";

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

describe("applyGeneration (SR-02)", () => {
  const item = (target: string) => ({
    source: "src/a.ts",
    target,
    status: "create" as const,
    reason: "",
    template: "unit",
    symbols: [],
    content: "test('x', () => {});\n",
  });

  it("refuses targets outside the project or behind a directory link", async () => {
    const base = await mkdtemp(join(tmpdir(), "st-gen-"));
    try {
      const root = join(base, "repo");
      await mkdir(join(root, "src"), { recursive: true });
      await mkdir(join(base, "autostart"));
      await symlink(join(base, "autostart"), join(root, "tests"), "junction");
      await expect(applyGeneration(root, [item("tests/a.test.ts")])).rejects.toMatchObject({
        code: "ST_UNSAFE_PATH",
      });
      await expect(applyGeneration(root, [item("../escape.test.ts")])).rejects.toMatchObject({
        code: "ST_UNSAFE_PATH",
      });
      expect(await readdir(join(base, "autostart"))).toEqual([]);
      expect(await applyGeneration(root, [item("src/a.test.ts")])).toEqual(["src/a.test.ts"]);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
