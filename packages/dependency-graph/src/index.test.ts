import { analyzeSource } from "@smarttest/language-typescript";
import type { FileAnalysis } from "@smarttest/source-parser";
import { describe, expect, it } from "vitest";
import { DependencyGraph } from "./index.js";

function graph(files: Record<string, string>, resolve: Record<string, string>) {
  const map = new Map<string, FileAnalysis>();
  for (const [p, c] of Object.entries(files)) {
    const a = analyzeSource(p, c);
    for (const imp of a.imports) {
      const r = resolve[`${p}:${imp.specifier}`];
      if (r) imp.resolved = r;
      else imp.external = true;
    }
    map.set(p, a);
  }
  return new DependencyGraph(map, (p) => p.includes(".test."));
}

const files = {
  "src/token.ts":
    "export class TokenManager { verify(t: string) { return t.length > 0; } }\nexport const unrelated = 1;\n",
  "src/auth.ts":
    'import { TokenManager } from "./token";\nexport class AuthService { validateToken(t: string) { return new TokenManager().verify(t); } }\n',
  "src/middleware.ts":
    'import { AuthService } from "./index";\nexport function authenticate(t: string) { return new AuthService().validateToken(t); }\n',
  "src/index.ts": 'export * from "./auth";\nexport { unrelated } from "./token";\n',
  "src/catalog.ts":
    'import { unrelated } from "./token";\nexport const catalog = () => unrelated;\n',
  "test/auth.test.ts":
    'import { AuthService } from "../src/auth";\nit("x", () => new AuthService());\n',
  "test/middleware.test.ts":
    'import { authenticate } from "../src/middleware";\nit("x", () => authenticate("t"));\n',
  "test/catalog.test.ts": 'import { catalog } from "../src/catalog";\nit("x", () => catalog());\n',
};
const resolve = {
  "src/auth.ts:./token": "src/token.ts",
  "src/middleware.ts:./index": "src/index.ts",
  "src/index.ts:./auth": "src/auth.ts",
  "src/index.ts:./token": "src/token.ts",
  "src/catalog.ts:./token": "src/token.ts",
  "test/auth.test.ts:../src/auth": "src/auth.ts",
  "test/middleware.test.ts:../src/middleware": "src/middleware.ts",
  "test/catalog.test.ts:../src/catalog": "src/catalog.ts",
};

describe("DependencyGraph", () => {
  const g = graph(files, resolve);

  it("selects direct and transitive tests through barrels, at symbol granularity", () => {
    const r = g.dependentsOf([{ file: "src/token.ts", units: ["TokenManager"] }]);
    expect([...r.tests.keys()].sort()).toEqual(["test/auth.test.ts", "test/middleware.test.ts"]);
    expect(r.tests.get("test/middleware.test.ts")?.path).toEqual([
      "src/token.ts#TokenManager",
      "src/token.ts#TokenManager.verify",
      "src/auth.ts#AuthService.validateToken",
      "src/middleware.ts#authenticate",
      "test/middleware.test.ts",
    ]);
  });

  it("does not select tests for unrelated symbols in the same file", () => {
    const r = g.dependentsOf([{ file: "src/token.ts", units: ["unrelated"] }]);
    expect([...r.tests.keys()]).toEqual(["test/catalog.test.ts"]);
  });

  it("whole-file changes reach every dependent", () => {
    const r = g.dependentsOf([{ file: "src/token.ts", units: ["*"] }]);
    expect(r.tests.size).toBe(3);
  });

  it("is cycle-safe", () => {
    const cyc = graph(
      {
        "a.ts": 'import { b } from "./b";\nexport const a = () => b();\n',
        "b.ts": 'import { a } from "./a";\nexport const b = () => a();\n',
        "a.test.ts": 'import { a } from "./a";\na();\n',
      },
      { "a.ts:./b": "b.ts", "b.ts:./a": "a.ts", "a.test.ts:./a": "a.ts" },
    );
    expect([...cyc.dependentsOf([{ file: "b.ts", units: ["b"] }]).tests.keys()]).toEqual([
      "a.test.ts",
    ]);
  });

  it("propagates at member level, through inheritance and super calls", () => {
    const g2 = graph(
      {
        "src/base.ts": "export class Repo { find() { return 1; } save() { return 2; } }",
        "src/users.ts":
          'import { Repo } from "./base";\nexport class UserRepo extends Repo { save() { return super.save() + 1; } }',
        "src/svc.ts":
          'import { UserRepo } from "./users";\nexport class Svc { constructor(private repo = new UserRepo()) {} get() { return this.repo.find(); } put() { return this.repo.save(); } }',
        "test/get.test.ts": 'import { Svc } from "../src/svc";\nnew Svc().get();',
        "test/put.test.ts": 'import { Svc } from "../src/svc";\nnew Svc().put();',
      },
      {
        "src/users.ts:./base": "src/base.ts",
        "src/svc.ts:./users": "src/users.ts",
        "test/get.test.ts:../src/svc": "src/svc.ts",
        "test/put.test.ts:../src/svc": "src/svc.ts",
      },
    );
    // find is inherited: users of UserRepo.find resolve to Repo.find
    expect([
      ...g2.dependentsOf([{ file: "src/base.ts", units: ["Repo.find"] }]).tests.keys(),
    ]).toEqual(["test/get.test.ts"]);
    // save is overridden and calls super.save: put reaches it, get does not
    expect([
      ...g2.dependentsOf([{ file: "src/base.ts", units: ["Repo.save"] }]).tests.keys(),
    ]).toEqual(["test/put.test.ts"]);
    // constructor/field changes of the base reach every subclass user
    expect(
      [...g2.dependentsOf([{ file: "src/base.ts", units: ["Repo"] }]).tests.keys()].sort(),
    ).toEqual(["test/get.test.ts", "test/put.test.ts"]);
  });

  it("answers why, cycles and orphans", () => {
    expect(g.why("src/token.ts#TokenManager", "test/middleware.test.ts")?.at(-1)).toBe(
      "test/middleware.test.ts",
    );
    const cyc = graph(
      {
        "a.ts": 'import { b } from "./b";\nexport const a = () => b();\n',
        "b.ts": 'import { a } from "./a";\nexport const b = () => a();\n',
        "lone.ts": "export const z = 1;",
      },
      { "a.ts:./b": "b.ts", "b.ts:./a": "a.ts" },
    );
    expect(cyc.cycles()).toEqual([["a.ts", "b.ts"]]);
    expect(g.orphans(["test/auth.test.ts"])).toContain("src/catalog.ts");
  });
});
