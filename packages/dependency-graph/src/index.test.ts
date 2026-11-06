import { analyzeSource } from "@smarttest/language-typescript";
import type { FileAnalysis } from "@smarttest/source-parser";
import { describe, expect, it } from "vitest";
import { DependencyGraph, type GraphOptions } from "./index.js";

function graph(
  files: Record<string, string>,
  resolve: Record<string, string>,
  options: GraphOptions = {},
) {
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
  return new DependencyGraph(map, (p) => p.includes(".test."), options);
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

describe("plugin edges", () => {
  const withProvided = () =>
    graph(
      {
        "src/users.ts": "export const findUser = () => 1;\n",
        "src/orders.ts": "export const listOrders = () => 2;\n",
        "test/users.test.ts":
          'import { findUser } from "../src/users";\nit("x", () => findUser());\n',
        "test/orders.test.ts":
          'import { listOrders } from "../src/orders";\nit("x", () => listOrders());\n',
      },
      {
        "test/users.test.ts:../src/users": "src/users.ts",
        "test/orders.test.ts:../src/orders": "src/orders.ts",
      },
      {
        provided: {
          edges: [
            {
              from: "src/users.ts",
              to: "sql/find-user.sql",
              kind: "REFERENCES",
              confidence: "high",
              provider: "sql",
            },
          ],
          unresolved: [{ file: "src/orders.ts", reason: "sql: query(name) is not a literal" }],
        },
      },
    );

  it("a provided edge reaches the tests of its dependent, and only those", () => {
    const g = withProvided();
    const hit = g.dependentsOf([{ file: "sql/find-user.sql", units: ["*"] }]);
    expect([...hit.tests.keys()]).toEqual(["test/users.test.ts"]);
    expect(g.dependenciesOf("test/users.test.ts")).toContain("sql/find-user.sql");
    expect(g.toGraph().edges).toContainEqual(
      expect.objectContaining({
        from: "src/users.ts",
        to: "sql/find-user.sql",
        provenance: "plugin",
      }),
    );
  });

  it("unresolved relationships are uncertainty, and the graph is rebuilt instead of patched", () => {
    const g = withProvided();
    expect(g.uncertaintyReachableFrom("test/orders.test.ts")).toEqual([
      { file: "src/orders.ts", reasons: ["sql: query(name) is not a literal"] },
    ]);
    expect(g.uncertaintyReachableFrom("test/users.test.ts")).toEqual([]);
    expect(g.patch(["src/users.ts"])).toBe(false);
  });
});

describe("DependencyGraph persistence", () => {
  const g = graph(files, resolve);
  const map = (g as unknown as { files: ReadonlyMap<string, FileAnalysis> }).files;
  const isTest = (p: string) => p.includes(".test.");
  const seeds = [{ file: "src/token.ts", units: ["TokenManager.verify"] }];
  const tests = (x: DependencyGraph) => [...x.dependentsOf(seeds).tests.keys()].sort();

  it("restores exactly the graph it serialized", () => {
    const text = g.serialize();
    const restored = DependencyGraph.restore(map, isTest, {}, text);
    expect(restored).toBeDefined();
    expect(restored?.serialize()).toBe(text);
    expect(restored?.stats).toEqual(g.stats);
    expect(tests(restored as DependencyGraph)).toEqual(tests(g));
    expect(tests(g).length).toBeGreaterThan(0);
    expect(restored?.toGraph()).toEqual(g.toGraph());
  });

  it("refuses anything that is not a complete graph of this format", () => {
    const data = JSON.parse(g.serialize()) as Record<string, unknown>;
    const bad = [
      "",
      "{",
      "null",
      JSON.stringify({ ...data, format: 0 }),
      JSON.stringify({ ...data, strings: ["x"] }),
      JSON.stringify({ ...data, deps: [0, 99] }),
      JSON.stringify({ ...data, edgeKinds: [] }),
      JSON.stringify({ ...data, forward: "x" }),
      JSON.stringify({ ...data, edgeCount: "1" }),
    ];
    for (const text of bad)
      expect(DependencyGraph.restore(map, isTest, {}, text), text).toBeUndefined();
  });

  it("patches a restored graph like a built one", () => {
    const restored = DependencyGraph.restore(map, isTest, {}, g.serialize()) as DependencyGraph;
    expect(restored.patch(["src/auth.ts"])).toBe(true);
    expect(tests(restored)).toEqual(tests(g));
    expect(restored.stats).toEqual(g.stats);
  });
});

describe("test files as traversals see them", () => {
  const shared = {
    "src/numbers.ts":
      "export const clamp = (v: number) => Math.min(v, 10);\nexport const double = (v: number) => v * 2;\n",
    "test/shared.test.ts":
      'import { clamp, double } from "../src/numbers";\nexport const checkClamp = (v: number) => clamp(v);\nexport const checkDouble = (v: number) => double(v);\nit("self", () => 1);\n',
    "test/strings.test.ts":
      'import { checkClamp } from "./shared.test";\nit("uses shared", () => checkClamp(12));\n',
    "test/other.test.ts":
      'import { checkDouble } from "./shared.test";\nit("uses double", () => checkDouble(2));\n',
  };
  const sharedResolve = {
    "test/shared.test.ts:../src/numbers": "src/numbers.ts",
    "test/strings.test.ts:./shared.test": "test/shared.test.ts",
    "test/other.test.ts:./shared.test": "test/shared.test.ts",
  };

  it("keeps walking from a test to the tests that import it, at symbol granularity", () => {
    const g = graph(shared, sharedResolve);
    const r = g.dependentsOf([{ file: "src/numbers.ts", units: ["clamp"] }]);
    // checkClamp only: other.test.ts imports checkDouble, which does not use clamp.
    expect([...r.tests.keys()].sort()).toEqual(["test/shared.test.ts", "test/strings.test.ts"]);
    expect(r.tests.get("test/strings.test.ts")?.path).toEqual([
      "src/numbers.ts#clamp",
      "test/shared.test.ts#checkClamp",
      "test/strings.test.ts",
    ]);
    // A path ends at the test file, whichever unit it entered by.
    expect(r.tests.get("test/shared.test.ts")?.path).toEqual([
      "src/numbers.ts#clamp",
      "test/shared.test.ts",
    ]);
    // Test units are not reported as affected source symbols.
    expect([...r.affectedUnits].some((u) => u.startsWith("test/"))).toBe(false);
  });

  it("a test whose own top level reaches the change reaches every importer", () => {
    const g = graph(
      {
        ...shared,
        "test/shared.test.ts":
          'import { clamp, double } from "../src/numbers";\nexport const checkClamp = (v: number) => clamp(v);\nexport const checkDouble = (v: number) => double(v);\nit("self", () => checkClamp(1));\n',
      },
      sharedResolve,
    );
    const r = g.dependentsOf([{ file: "src/numbers.ts", units: ["clamp"] }]);
    // Importing a test runs its top level (it registers tests in the importer): all importers.
    expect([...r.tests.keys()].sort()).toEqual([
      "test/other.test.ts",
      "test/shared.test.ts",
      "test/strings.test.ts",
    ]);
  });

  it("files a runner collects are tests whatever their name; helpers are not", () => {
    const g = graph(
      {
        "src/math.js": "export const add = (a, b) => a + b;\n",
        "test/math.js": 'import { add } from "../src/math.js";\nadd(1, 2);\n',
        "checks/numbers.ts": 'import { add } from "../src/math.js";\nadd(1, 2);\n',
        "lib/__tests__/fixture.test.js":
          'import { add } from "../../src/math.js";\nexport const f = () => add(1, 1);\n',
        "test/uses-fixture.test.js":
          'import { f } from "../lib/__tests__/fixture.test.js";\nf();\n',
      },
      {
        "test/math.js:../src/math.js": "src/math.js",
        "checks/numbers.ts:../src/math.js": "src/math.js",
        "lib/__tests__/fixture.test.js:../../src/math.js": "src/math.js",
        "test/uses-fixture.test.js:../lib/__tests__/fixture.test.js":
          "lib/__tests__/fixture.test.js",
      },
    );
    const seed = [{ file: "src/math.js", units: ["add"] }];
    // Without discovery, names decide: test/math.js and checks/numbers.ts are plain files.
    expect([...g.dependentsOf(seed).tests.keys()].sort()).toEqual([
      "lib/__tests__/fixture.test.js",
      "test/uses-fixture.test.js",
    ]);
    g.setDiscovery({
      tests: ["test/math.js", "checks/numbers.ts", "test/uses-fixture.test.js"],
      helpers: ["lib/__tests__/fixture.test.js"],
    });
    expect(g.isTestFile("test/math.js")).toBe(true);
    expect(g.isTestFile("lib/__tests__/fixture.test.js")).toBe(false);
    expect([...g.dependentsOf(seed).tests.keys()].sort()).toEqual([
      "checks/numbers.ts",
      "test/math.js",
      "test/uses-fixture.test.js",
    ]);
    expect(g.orphans(["test/math.js", "checks/numbers.ts"])).not.toContain("test/math.js");
    const kinds = new Map(g.toGraph().nodes.map((n) => [n.id, n.kind]));
    expect(kinds.get("checks/numbers.ts")).toBe("test-suite");
    expect(kinds.get("lib/__tests__/fixture.test.js")).toBe("file");
  });
});

describe("barrels and re-exports", () => {
  // Two levels of barrels: `export *`, `export { x as y } from`, a default re-export and a
  // namespace re-export, with importers that can and cannot be pinned to a symbol.
  const g = graph(
    {
      "lib/a.ts": "export function a() { return 1; }\nexport const a2 = 2;\n",
      "lib/b.ts": "export function b() { return 2; }\n",
      "lib/c.ts": "export default function c() { return 3; }\n",
      "lib/inner/index.ts":
        'export * from "../a";\nexport { b as bee } from "../b";\nexport { default as cee } from "../c";\n',
      "lib/index.ts":
        'export * from "./inner";\nexport * as ns from "./inner";\nimport * as inner from "./inner";\nexport { inner };\n',
      "useA.test.ts": 'import { a } from "./lib";\nit("x", () => a());\n',
      "useB.test.ts": 'import { bee } from "./lib";\nit("x", () => bee());\n',
      "useC.test.ts": 'import { cee } from "./lib";\nit("x", () => cee());\n',
      "nsA.test.ts": 'import * as lib from "./lib";\nit("x", () => lib.a());\n',
      "nsB.test.ts": 'import { ns } from "./lib";\nit("x", () => ns.bee());\n',
      "localNsB.test.ts": 'import { inner } from "./lib";\nit("x", () => inner.bee());\n',
      "nsDynamic.test.ts":
        'import * as lib from "./lib";\nconst k = "a";\nit("x", () => (lib as any)[k]());\n',
      "nsEscapes.test.ts": 'import { ns } from "./lib";\nit("x", () => Object.keys(ns));\n',
      "sideEffect.test.ts": 'import "./lib";\nit("x", () => 1);\n',
    },
    {
      "lib/inner/index.ts:../a": "lib/a.ts",
      "lib/inner/index.ts:../b": "lib/b.ts",
      "lib/inner/index.ts:../c": "lib/c.ts",
      "lib/index.ts:./inner": "lib/inner/index.ts",
      ...Object.fromEntries(
        [
          "useA",
          "useB",
          "useC",
          "nsA",
          "nsB",
          "localNsB",
          "nsDynamic",
          "nsEscapes",
          "sideEffect",
        ].map((t) => [`${t}.test.ts:./lib`, "lib/index.ts"]),
      ),
    },
  );
  const tests = (file: string, unit: string) =>
    [...g.dependentsOf([{ file, units: [unit] }]).tests.keys()].sort();
  // Importers the analysis cannot pin to a symbol: selected for any change behind the barrel.
  const conservative = ["nsDynamic.test.ts", "nsEscapes.test.ts", "sideEffect.test.ts"];

  it("a symbol change selects only that symbol's importers, through every level", () => {
    expect(tests("lib/a.ts", "a")).toEqual(["nsA.test.ts", "useA.test.ts", ...conservative].sort());
    expect(tests("lib/a.ts", "a2")).toEqual(conservative);
    expect(tests("lib/c.ts", "c")).toEqual(["useC.test.ts", ...conservative].sort());
  });

  it("follows aliases and namespace re-exports to the member read", () => {
    expect(tests("lib/b.ts", "b")).toEqual(
      ["localNsB.test.ts", "nsB.test.ts", "useB.test.ts", ...conservative].sort(),
    );
  });

  it("a change to code run at load reaches every importer of the barrels", () => {
    expect(tests("lib/a.ts", "*")).toHaveLength(9);
  });

  it("seeds a barrel's changed re-exports by what each name resolves to", () => {
    const seeds = g.reexportSeeds("lib/inner/index.ts", ["bee", "gone"]);
    expect(seeds).toEqual([
      { file: "lib/inner/index.ts", units: ["@any"] },
      { file: "lib/b.ts", units: ["b"] },
    ]);
    expect([...g.dependentsOf(seeds).tests.keys()].sort()).toEqual(tests("lib/b.ts", "b"));
  });

  it("keeps a name that resolves nowhere on the barrel itself", () => {
    const g2 = graph(
      {
        "lib/index.ts": 'export * from "./a";\nexport * from "external";\n',
        "lib/a.ts": "export function a() { return 1; }\n",
        "useX.test.ts": 'import { fromExternal } from "./lib";\nit("x", () => fromExternal());\n',
      },
      { "lib/index.ts:./a": "lib/a.ts", "useX.test.ts:./lib": "lib/index.ts" },
    );
    expect([...g2.dependentsOf([{ file: "lib/a.ts", units: ["a"] }]).tests.keys()]).toEqual([
      "useX.test.ts",
    ]);
  });

  it("keeps CommonJS re-exports conservative", () => {
    for (const barrel of [
      'module.exports = { ...require("./a.cjs"), ...require("./b.cjs") };\n',
      'module.exports = require("./b.cjs");\n',
      'Object.assign(module.exports, require("./a.cjs"), require("./b.cjs"));\n',
    ]) {
      const g3 = graph(
        {
          "a.cjs": "function a() { return 1; }\nmodule.exports = { a };\n",
          "b.cjs": "function b() { return 2; }\nmodule.exports = { b };\n",
          "index.cjs": barrel,
          "useA.test.cjs": 'const { a } = require("./index.cjs");\nit("x", () => a());\n',
        },
        {
          "index.cjs:./a.cjs": "a.cjs",
          "index.cjs:./b.cjs": "b.cjs",
          "useA.test.cjs:./index.cjs": "index.cjs",
        },
      );
      expect([...g3.dependentsOf([{ file: "b.cjs", units: ["b"] }]).tests.keys()]).toEqual([
        "useA.test.cjs",
      ]);
    }
  });
});
