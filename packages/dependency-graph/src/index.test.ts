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
      "src/auth.ts#AuthService",
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
});
