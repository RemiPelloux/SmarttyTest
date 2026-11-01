import { describe, expect, it } from "vitest";
import {
  describeScope,
  normalizeProject,
  onlyDeletions,
  outsideHookScope,
  planChecks,
  scopeIsEmpty,
  unknownCheckProjects,
} from "./hook.js";

describe("hook scope", () => {
  const selected = [
    { file: "src/a.test.ts", adapter: "vitest" },
    { file: "e2e/login.spec.ts", adapter: "playwright" },
    { file: "e2e/helpers.test.ts", adapter: "vitest" },
    { file: "orphan.test.ts", adapter: undefined },
  ];

  it("removes nothing without a scope", () => {
    expect(scopeIsEmpty(undefined)).toBe(true);
    expect(scopeIsEmpty({ exclude: [] })).toBe(true);
    expect(outsideHookScope(selected, { exclude: [] })).toEqual([]);
    expect(describeScope({ exclude: [] })).toEqual([]);
  });

  it("leaves other runners' tests to CI with the rule that removed them", () => {
    expect(outsideHookScope(selected, { runners: ["vitest"] })).toEqual([
      { file: "e2e/login.spec.ts", adapter: "playwright", rule: "hook.runners [vitest]" },
    ]);
  });

  it("never leaves a test without a runner out of the hook through `runners`", () => {
    // The normal path reports it (no runner collects it); a scope must not hide it.
    expect(
      outsideHookScope(selected, { runners: ["vitest"] }).some((l) => l.file === "orphan.test.ts"),
    ).toBe(false);
  });

  it("leaves excluded files to CI whatever their runner", () => {
    expect(outsideHookScope(selected, { exclude: ["e2e/**"] })).toEqual([
      { file: "e2e/login.spec.ts", adapter: "playwright", rule: 'hook.exclude "e2e/**"' },
      { file: "e2e/helpers.test.ts", adapter: "vitest", rule: 'hook.exclude "e2e/**"' },
    ]);
    expect(describeScope({ runners: ["vitest", "jest"], exclude: ["e2e/**"] })).toEqual([
      "hook.runners [vitest, jest]",
      'hook.exclude ["e2e/**"]',
    ]);
  });
});

describe("project checks", () => {
  it("matches a check scoped to a project however its directory is written", () => {
    for (const dir of ["packages/app", "packages/app/", "./packages/app", ".\\packages\\app"]) {
      const planned = planChecks(
        [{ name: "types", run: "tsc", projects: [dir] }],
        "pre-commit",
        [{ path: "packages/app/src/a.ts" }],
        ["", "packages/app/"],
      );
      expect(planned, dir).toEqual([{ name: "types", project: "packages/app", command: "tsc" }]);
    }
    expect(normalizeProject("./")).toBe("");
    expect(normalizeProject(".")).toBe("");
  });

  it("reports a check whose project is unknown instead of dropping it silently", () => {
    const checks = [
      { name: "types", run: "tsc", projects: ["./packages/app/", "packages/nope"] },
      { name: "build", run: "make", projects: ["packages/gone"], stage: "pre-push" as const },
    ];
    const warnings = unknownCheckProjects(checks, "pre-commit", ["", "packages/app"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"packages/nope"');
  });

  it("never lets a changed file be read as an option", () => {
    const [planned] = planChecks(
      [{ name: "lint", run: "eslint {files}" }],
      "pre-commit",
      [{ path: "--rulesdir=x.js" }, { path: "src/it's.ts" }],
      [""],
    );
    expect(planned?.command).toBe("eslint './--rulesdir=x.js' './src/it'\\''s.ts'");
  });
});

describe("pre-push refs", () => {
  const ref = (localSha: string) => ({
    localRef: "(delete)",
    localSha,
    remoteRef: "refs/heads/x",
    remoteSha: "1".repeat(40),
  });

  it("recognises a push that only deletes remote refs", () => {
    expect(onlyDeletions([ref("0".repeat(40))])).toBe(true);
    expect(onlyDeletions([ref("0".repeat(40)), ref("2".repeat(40))])).toBe(false);
    expect(onlyDeletions([])).toBe(false);
  });
});
