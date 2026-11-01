import type { ChangeAnalysisInput } from "@smarttest/vcs-core";
import { describe, expect, it } from "vitest";
import {
  normalizeScopePath,
  nothingInScope,
  restrictChanges,
  scopeWarnings,
  unchangedScopeDecision,
} from "./scope.js";

const input = (paths: { path: string; previousPath?: string }[]): ChangeAnalysisInput => ({
  description: "git · HEAD…working tree",
  readBefore: async () => undefined,
  changeSet: {
    provider: "git",
    completeness: "complete",
    warnings: [],
    changes: paths.map((p) => ({ type: p.previousPath ? "renamed" : "modified", ...p })),
  },
});

describe("--only scope", () => {
  it("normalises project-relative paths and refuses paths outside the project", () => {
    expect(normalizeScopePath("./src/a.ts")).toBe("src/a.ts");
    expect(normalizeScopePath("src\\util\\")).toBe("src/util");
    for (const bad of ["", ".", "..", "../x.ts", "/etc/passwd", "C:/x.ts"])
      expect(() => normalizeScopePath(bad), bad).toThrow(/not a path inside the project/);
  });

  it("keeps the matching changes, by file, directory or previous path", () => {
    const { input: scoped, scope } = restrictChanges(
      input([
        { path: "src/a.ts" },
        { path: "src/ab.ts" },
        { path: "lib/b.ts" },
        { path: "src/new.ts", previousPath: "old/c.ts" },
      ]),
      ["src/a.ts", "old/c.ts", "docs"],
    );
    expect(scoped.changeSet.changes.map((c) => c.path)).toEqual(["src/a.ts", "src/new.ts"]);
    expect(scoped.description).toBe("git · HEAD…working tree · only src/a.ts, old/c.ts, docs");
    expect(scope).toEqual({
      paths: ["src/a.ts", "old/c.ts", "docs"],
      matched: ["src/a.ts", "src/new.ts"],
      unchanged: ["docs"],
      excluded: ["src/ab.ts", "lib/b.ts"],
    });
    expect(restrictChanges(input([{ path: "src/a.ts" }]), ["src/"]).scope.matched).toEqual([
      "src/a.ts",
    ]);
  });

  it("warns about unchanged paths and left-out changes, and never claims no change without a baseline", () => {
    const scope = { paths: ["a.ts"], matched: [], unchanged: ["a.ts"], excluded: ["b.ts"] };
    const warnings = scopeWarnings(scope, "complete");
    expect(warnings[0]).toContain("a.ts has no change");
    expect(warnings[1]).toContain("1 other changed file(s) were not considered (b.ts)");
    expect(scopeWarnings(scope, "unknown")[0]).toContain("cannot tell whether a.ts changed");
    expect(nothingInScope(scope, "complete")).toBe(true);
    expect(nothingInScope(scope, "partial")).toBe(true);
    // No baseline: the engine's full-suite fallback stays.
    expect(nothingInScope(scope, "unknown")).toBe(false);
    expect(nothingInScope({ ...scope, matched: ["a.ts"], unchanged: [] }, "complete")).toBe(false);
  });

  it("skips every test, with the reason, when nothing in scope changed", () => {
    const scope = { paths: ["a.ts"], matched: [], unchanged: ["a.ts"], excluded: [] };
    const decision = unchangedScopeDecision(["t/a.test.ts", "t/b.test.ts"], scope, "safe");
    expect(decision.selectedTests).toEqual([]);
    expect(decision.skippedTests).toEqual([
      { testId: "t/a.test.ts", filePath: "t/a.test.ts", reasons: ["no change in a.ts (--only)"] },
      { testId: "t/b.test.ts", filePath: "t/b.test.ts", reasons: ["no change in a.ts (--only)"] },
    ]);
    expect(decision).toMatchObject({ safetyMode: "safe", fallbackApplied: false });
  });
});
