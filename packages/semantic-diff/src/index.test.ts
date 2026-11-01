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

describe("module-evaluation code", () => {
  const src = `import { dep } from "./dep";
export const LIMIT = 10;
export const fmt = (s: string) => s.trim();
export const config = { retries: 3, run: () => dep(1), dep };
export const cached = dep(2);
export function upper(s: string) { return s.toUpperCase(); }
export class Plain { static label = "p"; m() { return 1; } }
`;
  const d = (after: string, before = src) =>
    diffFile({
      path: "a.ts",
      before: analyzeSource("a.ts", before),
      after: analyzeSource("a.ts", after),
      beforeText: before,
      afterText: after,
    });

  it("seeds the whole file for a new export whose initializer throws at import", () => {
    const r = d(`${src}export const X = (() => { throw new Error("boom"); })();\n`);
    expect(r.units).toEqual(["*"]);
    expect(r.changes.some((c) => c.notes?.includes("module load"))).toBe(true);
  });

  it("seeds the whole file when an export's initializer starts to run other code", () => {
    expect(d(src.replace("LIMIT = 10", "LIMIT = boom()")).units).toEqual(["*"]);
    expect(d(src.replace("cached = dep(2)", "cached = dep(3)")).units).toEqual(["*"]);
  });

  it("seeds the whole file when module-evaluation code is removed", () => {
    expect(d(src.replace("export const cached = dep(2);\n", "")).units).toEqual(["*"]);
  });

  it("seeds the whole file for static initializers, static blocks and decorators", () => {
    expect(d(src.replace('static label = "p";', "static label = make();")).units).toEqual(["*"]);
    expect(d(src.replace("m() {", "static { boom(); } m() {")).units).toEqual(["*"]);
    expect(d(src.replace("export class Plain", "@sealed\nexport class Plain")).units).toEqual([
      "*",
    ]);
  });

  it("seeds the whole file for top-level statements and side-effect imports", () => {
    expect(d(`${src}dep(4);\n`).units).toEqual(["*"]);
    expect(d(`import "./setup";\n${src}`).units).toEqual(["*"]);
  });

  it("keeps declarations that cannot run code at load member-level", () => {
    expect(d(src.replace("LIMIT = 10", "LIMIT = 11")).units).toEqual(["LIMIT"]);
    expect(d(src.replace("s.trim()", "s.trimEnd()")).units).toEqual(["fmt"]);
    expect(d(src.replace("retries: 3", "retries: 4")).units).toEqual(["config"]);
    expect(d(src.replace("toUpperCase", "toLowerCase")).units).toEqual(["upper"]);
    expect(d(src.replace("return 1;", "return 2;")).units).toEqual(["Plain.m"]);
    expect(d(`${src}export const Z = { a: [1, -2, "x"], f() {} } as const;\n`).units).toEqual([
      "Z",
    ]);
  });

  it("treats a name read before its declaration as code that can throw", () => {
    const before = "export const A = 1;\nexport const B = 2;\n";
    expect(d("export const A = B;\nexport const B = 2;\n", before).units).toEqual(["*"]);
    expect(d("export const A = 1;\nexport const B = A;\n", before).units).toEqual(["B"]);
  });

  it("seeds the whole file for changed lines in load-time code without a previous version", () => {
    const line = src.split("\n").findIndex((l) => l.includes("cached"));
    const r = diffFile({
      path: "a.ts",
      after: analyzeSource("a.ts", src),
      ranges: [{ start: { line, column: 0 }, end: { line, column: 5 } }],
    });
    expect(r.units).toEqual(["*"]);
  });
});
