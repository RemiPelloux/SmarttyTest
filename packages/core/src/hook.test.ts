import { describe, expect, it } from "vitest";
import { normalizeProject, onlyDeletions, planChecks, unknownCheckProjects } from "./hook.js";

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
