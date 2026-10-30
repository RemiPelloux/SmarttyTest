import { describe, expect, it } from "vitest";
import {
  explainArgs,
  explainTarget,
  graphArgs,
  impactArgs,
  runAffectedArgs,
  scanArgs,
} from "../src/cli/commands.js";

const base = { mode: "balanced", changeSource: "uncommitted" } as const;

describe("CLI argument builders", () => {
  it("uses the public uncommitted, staged and base flags", () => {
    expect(impactArgs(base)).toEqual(["impact", "--uncommitted", "--mode", "balanced", "--json"]);
    expect(impactArgs({ ...base, changeSource: "staged" })).toContain("--staged");
    expect(impactArgs({ ...base, changeSource: "base", baseRef: "origin/main" })).toEqual([
      "impact",
      "--base",
      "origin/main",
      "--mode",
      "balanced",
      "--json",
    ]);
  });

  it("falls back to uncommitted when base mode has no ref, matching the CLI default", () => {
    expect(impactArgs({ ...base, changeSource: "base", baseRef: "  " })).toContain("--uncommitted");
  });

  it("always passes --affected to run", () => {
    expect(runAffectedArgs(base)).toContain("--affected");
    expect(runAffectedArgs(base)).toContain("--json");
  });

  it("builds explain targets and refuses option-looking input", () => {
    expect(explainTarget("src/a.ts")).toBe("src/a.ts#*");
    expect(explainTarget("src/a.ts", "A.run")).toBe("src/a.ts#A.run");
    expect(explainArgs("src/a.ts#A.run")).toEqual(["explain", "src/a.ts#A.run", "--json"]);
    expect(() => explainArgs("--help")).toThrow(/option-looking/);
    expect(() => explainArgs("a\0b")).toThrow(/option-looking/);
  });

  it("uses --format json for graph because --json only prints stats", () => {
    expect(graphArgs()).toEqual(["graph", "--format", "json"]);
    expect(scanArgs()).toEqual(["scan", "--json"]);
  });
});
