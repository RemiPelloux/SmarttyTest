// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are source code under test
import { describe, expect, it } from "vitest";
import { analyzeSource } from "./analyze.js";

const src = `
import { TokenManager } from "./TokenManager";
import type { User } from "../users/User";
import * as crypto from "node:crypto";
import "./polyfill";

/** Auth service */
export class AuthService {
  constructor(private readonly tokens: TokenManager) {}
  validateToken(token: string): boolean {
    return this.tokens.verify(token) && crypto.randomUUID().length > 0;
  }
  private secret(): string { return "x"; }
}

export function login(user: User) { return new AuthService(new TokenManager()).validateToken(user.id); }
const helper = () => 1;
export { helper as util };
export default AuthService;
setup(helper);
const lazy = () => import("./lazy");
const dyn = (name: string) => import(name);
`;

describe("analyzeSource", () => {
  const a = analyzeSource("src/auth/AuthService.ts", src);

  it("extracts imports with kinds and bindings", () => {
    const byKind = a.imports.map((i) => [i.kind, i.specifier, i.typeOnly]);
    expect(byKind).toEqual(
      expect.arrayContaining([
        ["named", "./TokenManager", false],
        ["named", "../users/User", true],
        ["namespace", "node:crypto", false],
        ["side-effect", "./polyfill", false],
        ["dynamic", "./lazy", false],
      ]),
    );
    expect(a.dynamicUnresolved).toHaveLength(1);
  });

  it("extracts classes, members, functions and exports", () => {
    const names = a.symbols.map((s) => s.qualifiedName);
    expect(names).toEqual(
      expect.arrayContaining([
        "AuthService",
        "AuthService.validateToken",
        "AuthService.secret",
        "AuthService.constructor",
        "login",
        "helper",
      ]),
    );
    const cls = a.symbols.find((s) => s.qualifiedName === "AuthService");
    expect(cls?.exportNames).toEqual(["AuthService"]);
    expect(a.symbols.find((s) => s.qualifiedName === "AuthService.constructor")?.refs).toContain(
      "TokenManager",
    );
    expect(a.symbols.find((s) => s.qualifiedName === "AuthService.secret")?.visibility).toBe(
      "private",
    );
    expect(a.localExports).toEqual(
      expect.arrayContaining([
        { exported: "util", local: "helper" },
        { exported: "default", local: "AuthService" },
      ]),
    );
    expect(a.topLevelRefs).toContain("helper");
    expect(a.moduleKind).toBe("esm");
  });

  it("produces identical token hashes for comment/whitespace-only edits", () => {
    const b = analyzeSource(
      "src/auth/AuthService.ts",
      src.replace("return this.tokens", "// comment\n    return   this.tokens"),
    );
    const before = a.symbols.find((s) => s.qualifiedName === "AuthService.validateToken");
    const after = b.symbols.find((s) => s.qualifiedName === "AuthService.validateToken");
    expect(after?.tokenHash).toBe(before?.tokenHash);
    expect(after?.textHash).not.toBe(before?.textHash);
  });

  it("detects CommonJS modules", () => {
    const c = analyzeSource(
      "src/x.js",
      "const { a } = require('./a');\nmodule.exports = function x() { return a(); };\n",
    );
    expect(c.moduleKind).toBe("cjs");
    expect(c.imports[0]).toMatchObject({
      kind: "require",
      specifier: "./a",
      bindings: [{ imported: "a", local: "a" }],
    });
  });
});

describe("module-evaluation code (evalHash)", () => {
  const evaluating = (path: string, src: string) =>
    analyzeSource(path, src)
      .symbols.filter((s) => s.evalHash)
      .map((s) => s.qualifiedName);

  it("marks declarations whose evaluation can run code", () => {
    const src = `import { make } from "./m";
export const a = 1, b = [1, { c: "x", d: () => 2 }], e = make;
export const f = make();
export const g = new Map();
export const { h } = { h: 1 };
export const i = \`\${a}\`;
export default make();
export enum Flags { A = 1, B = -2 }
export enum Computed { A = make() }
export namespace Types { export type T = 1; export function f() {} }
export namespace Runtime { export const x = make(); }
declare const ambient: number;
export class Plain extends Base { static n = 1; m() { return make(); } }
export class Static { static s = make(); }
export class Block { static { make(); } }
@dec export class Decorated {}
export class Member { @dec m() {} }
export class Mixed extends mix(Base) {}
`;
    expect(evaluating("a.ts", src).sort()).toEqual(
      [
        "f",
        "g",
        "h",
        "i",
        "default",
        "Computed",
        "Runtime",
        "Static",
        "Block",
        "Decorated",
        "Member",
        "Mixed",
      ].sort(),
    );
  });

  it("marks CommonJS exports whose value runs code", () => {
    const src = `const lib = require("./lib");
exports.a = 1;
exports.b = lib.make();
module.exports.c = function () {};
`;
    expect(evaluating("a.js", src)).toEqual(["b"]);
    expect(
      evaluating("b.js", `module.exports = { a: 1, b: compute(), c() {}, d: () => 1 };\n`),
    ).toEqual(["b"]);
  });
});

describe("token hashes read the parsed tree", () => {
  const hashOf = (path: string, code: string, name: string) =>
    analyzeSource(path, code).symbols.find((s) => s.qualifiedName === name);

  it("sees template text after a substitution", () => {
    const a = hashOf("a.ts", "export const f = (a: string, b: string) => `${a}, ${b}`;\n", "f");
    const b = hashOf("a.ts", "export const f = (a: string, b: string) => `${a},${b}`;\n", "f");
    expect(b?.tokenHash).not.toBe(a?.tokenHash);
    const c = hashOf("a.ts", "export const u = (host: string) => `${host}/a//b`;\n", "u");
    const d = hashOf("a.ts", "export const u = (host: string) => `${host}/a//c`;\n", "u");
    expect(d?.tokenHash).not.toBe(c?.tokenHash);
  });

  it("sees regular expressions and JSX text, and ignores JSDoc", () => {
    const r1 = hashOf("a.ts", "export const re = /a[/*]b/;\n", "re");
    const r2 = hashOf("a.ts", "export const re = /a[/*]c/;\n", "re");
    expect(r2?.tokenHash).not.toBe(r1?.tokenHash);
    const j1 = hashOf("a.tsx", "export const A = () => <p>see http://x.dev/a</p>;\n", "A");
    const j2 = hashOf("a.tsx", "export const A = () => <p>see http://x.dev/b</p>;\n", "A");
    expect(j2?.tokenHash).not.toBe(j1?.tokenHash);
    const j3 = hashOf(
      "a.tsx",
      "export const A = () => (\n  <p>\n    Hello,   world\n  </p>\n);\n",
      "A",
    );
    const j4 = hashOf(
      "a.tsx",
      "export const A = () => (\n  <p>\n      Hello,   world\n</p>\n);\n",
      "A",
    );
    expect(j4?.tokenHash).toBe(j3?.tokenHash);
    const d1 = hashOf("a.ts", "/** one */\nexport function f() { return 1; }\n", "f");
    const d2 = hashOf("a.ts", "/** two */\nexport function f() {\n  return 1;\n}\n", "f");
    expect(d2?.tokenHash).toBe(d1?.tokenHash);
  });

  it("reads JSX structure, attributes and nested code, and ignores its layout", () => {
    const h = (code: string) => hashOf("a.tsx", code, "A")?.tokenHash;
    const base =
      'export const A = ({ x }) => <p title="a">{x ? <b>one, two</b> : `${x}, y`}</p>;\n';
    const relaid =
      'export const A = ({ x }) =>\n  <p\n    title="a"\n  >\n    {x ? <b>one, two</b> : `${x}, y` /* c */}\n  </p>;\n';
    expect(h(relaid)).toBe(h(base));
    for (const [from, to] of [
      ['"a"', '"b"'],
      ["one, two", "one,two"],
      ["`${x}, y`", "`${x},y`"],
      ["x ?", "!x ?"],
      ["<b>", "<i>"],
    ] as const)
      expect(
        h(base.replace(from, to).replace("</b>", to === "<i>" ? "</i>" : "</b>")),
        to,
      ).not.toBe(h(base));
  });

  it("module-level code, evaluation hashes and class shells see template text too", () => {
    const top = (s: string) => analyzeSource("a.ts", s).topLevelHash;
    expect(top("log(`${a}, ${b}`);\n")).not.toBe(top("log(`${a},${b}`);\n"));
    const ev = (s: string) => hashOf("a.ts", s, "x")?.evalHash;
    expect(ev("export const x = make(`${a}, ${b}`);\n")).not.toBe(
      ev("export const x = make(`${a},${b}`);\n"),
    );
    const shell = (s: string) => hashOf("a.ts", s, "C")?.shellHash;
    expect(shell("export class C { static p = `${a}, x`; m() { return `${a}, y`; } }\n")).not.toBe(
      shell("export class C { static p = `${a},x`; m() { return `${a}, y`; } }\n"),
    );
    expect(shell("export class C { m() { return `${a}, y`; } }\n")).toBe(
      shell("export class C { m() { return `${a},z`; } }\n"),
    );
  });
});

describe("mock calls", () => {
  const mocks = (code: string) =>
    analyzeSource("t.test.ts", code)
      .imports.filter((i) => i.kind === "mock")
      .map((i) => `${i.specifier}:${i.mock}`);

  it("doMock is not hoisted: it never hides the file's static imports", () => {
    expect(mocks('vi.doMock("./m", () => ({ f: () => 42 }));\n')).toEqual(["./m:auto"]);
    expect(mocks('jest.doMock("./m", () => ({ f: () => 42 }));\n')).toEqual(["./m:auto"]);
    // A mock nested in a block runs after the static imports.
    expect(mocks('beforeEach(() => { jest.mock("./m", () => ({})); });\n')).toEqual(["./m:auto"]);
    expect(mocks('vi.mock("./m", () => ({ f: vi.fn() }));\n')).toEqual(["./m:factory"]);
  });

  it("recognises the calls that restore the real module", () => {
    expect(
      mocks(
        'vi.doUnmock("./a");\njest.dontMock("./b");\njest.deepUnmock("./c");\nvi.unmock("./d");\n',
      ),
    ).toEqual(["./a:unmock", "./b:unmock", "./c:unmock", "./d:unmock"]);
    expect(mocks('const m = await vi.importMock("./m");\n')).toEqual(["./m:auto"]);
  });

  it("a factory calling a helper or importing may reach the real module", () => {
    expect(mocks('vi.mock("./m", () => makeMock());\n')).toEqual(["./m:actual"]);
    expect(mocks('vi.mock("./m", () => ({ f: (x) => real(x) }));\n')).toEqual(["./m:actual"]);
    expect(mocks('vi.mock("./m", async () => ({ ...(await import("./m-real")) }));\n')).toEqual([
      "./m:actual",
    ]);
    expect(mocks('vi.mock("./m", () => new Fake());\n')).toEqual(["./m:actual"]);
  });

  it("a factory built from the mocking API, builtins and hoisted values stays a pure factory", () => {
    const code = `const mocks = vi.hoisted(() => ({ find: vi.fn() }));
const mockSave = jest.fn();
vi.mock("./a", () => ({ find: mocks.find, all: (...a) => mocks.find(...a) }));
jest.mock("./b", () => ({ save: (x) => mockSave(x), at: () => new Date(0), p: Promise.resolve(1) }));
vi.mock("./c", () => { const local = () => 1; return { f: vi.fn(() => local()) }; });
`;
    expect(mocks(code)).toEqual(["./a:factory", "./b:factory", "./c:factory"]);
    const unsafe = `const mocks = vi.hoisted(async () => await import("./x"));
vi.mock("./a", () => ({ find: () => mocks.find() }));
`;
    expect(mocks(unsafe)).toEqual(["./a:actual"]);
  });
});
