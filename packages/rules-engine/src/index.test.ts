import { describe, expect, it } from "vitest";
import { RulesEngine } from "./index.js";

const engine = new RulesEngine([
  {
    name: "service-tests",
    match: { class: "*Service" },
    require: ["unit"],
    coverage: { lines: 90 },
    generate: { template: "service" },
  },
  {
    name: "repository-tests",
    match: { class: "*Repository" },
    require: ["unit", "integration"],
    generate: { template: "database" },
  },
  {
    name: "auth-critical",
    match: { path: "src/modules/auth/**" },
    risk: "critical",
    execution: { alwaysRunOnAffected: true, mode: "safe" },
  },
  {
    name: "auth-relaxed",
    match: { path: "src/modules/auth/legacy/**" },
    risk: "low",
    execution: { mode: "fast" },
  },
  { name: "controllers", match: { decorator: "Controller" }, require: ["integration"] },
]);

const sym = (name: string, kind = "class", extra: object = {}) => ({
  name,
  qualifiedName: name,
  kind,
  decorators: [],
  ...extra,
});

describe("RulesEngine", () => {
  it("matches class selectors (and their methods)", () => {
    const p = engine.evaluate({
      path: "src/modules/users/UserService.ts",
      symbol: sym("UserService"),
    });
    expect(p.matched.map((m) => m.rule.name)).toEqual(["service-tests"]);
    expect(p.require).toEqual(["unit"]);
    const m = engine.evaluate({
      path: "src/x.ts",
      symbol: sym("find", "method", {
        parent: "UserRepository",
        qualifiedName: "UserRepository.find",
      }),
    });
    expect(m.require).toEqual(["unit", "integration"]);
  });

  it("never weakens risk or mode with a more specific rule", () => {
    const p = engine.evaluate({ path: "src/modules/auth/legacy/Old.ts" });
    expect(p.risk).toBe("critical");
    expect(p.mode).toBe("safe");
    expect(p.alwaysRunOnAffected).toBe(true);
  });

  it("is deterministic and orders by specificity", () => {
    const p = engine.evaluate({
      path: "src/modules/auth/AuthService.ts",
      symbol: sym("AuthService"),
    });
    expect(p.matched.map((m) => m.rule.name)).toEqual(["auth-critical", "service-tests"]);
  });

  it("matches decorators", () => {
    const p = engine.evaluate({
      path: "src/a.ts",
      symbol: sym("UsersController", "class", { decorators: ["Controller"] }),
    });
    expect(p.require).toContain("integration");
  });

  it("reports conflicting generation targets", () => {
    const e = new RulesEngine([
      { name: "a", match: { class: "*Service" }, generate: { template: "x" } },
      { name: "b", match: { class: "*Service" }, generate: { template: "y" } },
    ]);
    expect(e.validate()).toHaveLength(1);
    const p = e.evaluate({ path: "s.ts", symbol: sym("UserService") });
    expect(() => e.assertNoConflicts(p)).toThrow(/Rule conflict/);
  });
});
