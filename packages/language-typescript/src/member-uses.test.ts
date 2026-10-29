import { describe, expect, it } from "vitest";
import { analyzeSource } from "./analyze.js";

const sym = (src: string, name: string, path = "a.ts") =>
  analyzeSource(path, src).symbols.find((s) => s.qualifiedName === name);

describe("member-level uses", () => {
  it("resolves members through new, annotations, parameter properties and this.p", () => {
    const src = `import { TokenManager } from "./t";
import { Mailer } from "./m";
export class AuthService {
  constructor(private readonly tokens = new TokenManager(), private mailer: Mailer) {}
  validate(t: string) { return this.tokens.verify(t); }
  notify(m: Mailer) { m.send(); return this.check(); }
  check() { return TokenManager.version; }
}`;
    expect(sym(src, "AuthService.validate")).toMatchObject({
      uses: ["TokenManager.verify"],
      thisUses: ["tokens"],
    });
    expect(sym(src, "AuthService.notify")?.uses).toEqual(["Mailer.send"]);
    expect(sym(src, "AuthService.notify")?.thisUses).toEqual(["check"]);
    expect(sym(src, "AuthService.check")?.uses).toEqual(["TokenManager.version"]);
    expect(sym(src, "AuthService.constructor")?.uses).toEqual(["TokenManager.constructor"]);
    expect(sym(src, "AuthService.constructor")?.escapes ?? []).toEqual([]);
  });

  it("treats values that leave the function as escapes (class level)", () => {
    const src = `import { TokenManager } from "./t";
export function make() { return new TokenManager(); }
export function pass() { const t = new TokenManager(); register(t); }`;
    expect(sym(src, "make")?.escapes).toContain("TokenManager");
    expect(sym(src, "pass")?.escapes).toEqual(expect.arrayContaining(["TokenManager", "register"]));
  });

  it("does not attribute members of an untyped local that shadows a typed module variable", () => {
    const src = `import { A } from "./a";
const svc = new A();
export function f() { const svc = build(); return svc.run(); }
export function g() { return svc.run(); }`;
    expect(sym(src, "f")?.uses ?? []).toEqual([]);
    expect(sym(src, "g")?.uses).toEqual(["A.run"]);
  });

  it("records namespace and CommonJS member access, and CommonJS exports", () => {
    const a = analyzeSource(
      "svc.js",
      `const userService = require("./userService");
const { formatName } = require("./format");
function getUser(id) { return userService.find(id); }
function label(u) { return formatName(u); }
module.exports = { getUser, label };
module.exports.extra = function extra() { return 1; };`,
    );
    expect(a.symbols.find((s) => s.name === "getUser")?.uses).toEqual(["userService.find"]);
    expect(a.symbols.find((s) => s.name === "label")?.escapes).toEqual(["formatName"]);
    expect(a.localExports).toEqual([
      { exported: "getUser", local: "getUser" },
      { exported: "label", local: "label" },
    ]);
    expect(a.symbols.find((s) => s.name === "extra")?.exportNames).toEqual(["extra"]);
    expect(a.topLevelRefs).toEqual([]);
  });

  it("gives classes a shell hash that ignores method bodies", () => {
    const base = "export class C { x = 1; m() { return 1; } }";
    const a = sym(base, "C");
    expect(sym(base.replace("return 1", "return 2"), "C")?.shellHash).toBe(a?.shellHash);
    expect(sym(base.replace("x = 1", "x = 2"), "C")?.shellHash).not.toBe(a?.shellHash);
  });
});
