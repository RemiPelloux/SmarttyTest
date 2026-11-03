/**
 * `--runner <name>` (S31): only the tests of the named runners are analysed; the others are left
 * out of the analysis, with a warning, never reported as skipped or passed.
 */
import { SmartTest } from "@smarttest/core";
import { describe, expect, it } from "vitest";
import { materialize } from "./helpers.js";

describe("--runner", () => {
  it("keeps the named runner's tests and says how many it left out", async () => {
    const dir = await materialize("next-playwright", { git: true });
    const st = await SmartTest.open({ root: dir });
    const all = await st.analyze({ source: { kind: "uncommitted" } });
    const adapters = new Set([...all.assignment.values()].map((r) => r.adapter));
    expect(adapters).toEqual(new Set(["playwright", "node"]));
    const node = await st.analyze({ source: { kind: "uncommitted" }, runners: ["node"] });
    expect(node.testFiles.length).toBeGreaterThan(0);
    expect(node.testFiles.length).toBeLessThan(all.testFiles.length);
    expect([...node.assignment.values()].every((r) => r.adapter === "node")).toBe(true);
    expect(node.runnerRoots.map((r) => r.adapter)).toEqual(["node"]);
    expect(node.decision.warnings.join("\n")).toContain(
      `${all.testFiles.length - node.testFiles.length} test file(s) of other runners are left out`,
    );
  });

  it("an unknown runner is an error that lists the runners there are", async () => {
    const dir = await materialize("next-playwright", { git: true });
    const st = await SmartTest.open({ root: dir });
    await expect(st.analyze({ runners: ["jest"] })).rejects.toMatchObject({
      code: "ST_RUNNER_UNKNOWN",
      hint: expect.stringContaining("playwright"),
    });
  });
});
