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
