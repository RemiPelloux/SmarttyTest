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
    expect(cls?.refs).toContain("TokenManager");
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
