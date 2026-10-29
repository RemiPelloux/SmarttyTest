import { analyzeSource } from "@smarttest/language-typescript";
import { describe, expect, it } from "vitest";
import { diffFile } from "./index.js";

const base = `import { dep } from "./dep";
export class AuthService {
  validateToken(t: string): boolean {
    return dep(t);
  }
  other() { return 1; }
}
export function helper(a: number) { return a + 1; }
`;

function diff(after: string) {
  return diffFile({
    path: "a.ts",
    before: analyzeSource("a.ts", base),
    after: analyzeSource("a.ts", after),
    beforeText: base,
    afterText: after,
  });
}

describe("semantic diff", () => {
  it("classifies comment-only changes as trivial", () => {
    const d = diff(base.replace("return dep(t);", "// why\n    return dep(t);"));
    expect(d.trivialOnly).toBe(true);
    expect(d.changes[0]?.kind).toBe("comment-only");
    expect(d.units).toEqual([]);
  });

  it("classifies formatting changes as trivial", () => {
    const d = diff(base.replace("return a + 1;", "return a+1;"));
    expect(d.changes.map((c) => c.kind)).toEqual(["formatting"]);
  });

  it("attributes method changes to the method unit", () => {
    const d = diff(base.replace("return dep(t);", "return !dep(t);"));
    expect(d.units).toEqual(["AuthService.validateToken"]);
    expect(d.changes.find((c) => c.symbolId === "a.ts#AuthService.validateToken")?.kind).toBe(
      "implementation",
    );
  });

  it("makes field and constructor changes class-level", () => {
    const d = diff(base.replace("other() { return 1; }", "other() { return 1; }\n  limit = 3;"));
    expect(d.units).toEqual(["AuthService"]);
  });

  it("detects exported signature changes", () => {
    const d = diff(base.replace("helper(a: number)", "helper(a: number, b = 2)"));
    expect(d.changes.find((c) => c.symbolId === "a.ts#helper")?.kind).toBe("exported-api");
    expect(d.units).toEqual(["helper"]);
  });

  it("treats module-level code changes as whole-file", () => {
    const d = diff(`${base}\nconsole.log("boot");\n`);
    expect(d.units).toEqual(["*"]);
  });

  it("is conservative without a previous version", () => {
    const d = diffFile({ path: "a.ts", after: analyzeSource("a.ts", base) });
    expect(d.units).toEqual(["*"]);
    expect(d.changes[0]?.kind).toBe("unclassifiable");
  });
});
