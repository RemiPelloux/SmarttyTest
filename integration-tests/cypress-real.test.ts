/**
 * The Cypress adapter against a real Cypress install (fixtures/projects/cypress-e2e).
 *
 * Cypress's ~600 MB binary is not installed by `pnpm install` (pnpm-workspace.yaml#allowBuilds),
 * so these tests run only when SMARTTEST_REAL_CYPRESS=1, which the `cypress (real install)` job in
 * .github/workflows/ci.yml sets after `cypress install`. Locally:
 *   pnpm --dir fixtures/projects/cypress-e2e exec cypress install
 *   SMARTTEST_REAL_CYPRESS=1 pnpm vitest run integration-tests/cypress-real.test.ts
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SmartTest } from "@smarttest/core";
import { describe, expect, it } from "vitest";
import { edit, materialize } from "./helpers.js";

const statuses = (out: Awaited<ReturnType<SmartTest["run"]>>) =>
  Object.fromEntries(
    out.report.executions.flatMap((e) => e.tests.map((t) => [t.testId, t.status] as const)),
  );

describe.runIf(process.env.SMARTTEST_REAL_CYPRESS === "1")("Cypress (real install)", () => {
  it("selects the spec a change reaches and reports its failure, pass and skip", async () => {
    const dir = await materialize("cypress-e2e", { git: true });
    await edit(dir, "src/math.js", "return a + b;", "return a - b;");
    const st = await SmartTest.open({ root: dir });
    expect((await st.profile()).runners.map((r) => r.adapter)).toContain("cypress");
    const out = await st.run({ formats: ["json"] });

    expect(out.report.decision.selectedTests.map((t) => t.filePath)).toEqual([
      "cypress/e2e/math.cy.js",
    ]);
    expect(statuses(out)).toEqual({
      "cypress/e2e/math.cy.js::math adds": "failed",
      "cypress/e2e/math.cy.js::math multiplies": "passed",
      "cypress/e2e/math.cy.js::math divides": "skipped",
    });
    const adds = out.report.executions[0]?.tests.find((t) => t.testId.endsWith("math adds"));
    expect(adds?.error?.message).toContain("expected -1 to equal 5");
    expect(out.report.summary.failed).toBe(1);
    expect(out.report.summary.passed).toBe(1);
    expect(out.exitCode).toBe(1);
  }, 300_000);

  it("passes when the selected spec passes", async () => {
    const dir = await materialize("cypress-e2e", { git: true });
    await edit(dir, "src/strings.js", "text.toUpperCase()", "String(text).toUpperCase()");
    const out = await (await SmartTest.open({ root: dir })).run({ formats: ["json"] });

    expect(out.report.decision.selectedTests.map((t) => t.filePath)).toEqual([
      "cypress/e2e/strings.cy.js",
    ]);
    expect(statuses(out)).toEqual({ "cypress/e2e/strings.cy.js::strings shouts": "passed" });
    expect(out.exitCode).toBe(0);
  }, 300_000);

  it("reports a spec that fails to load as failed, never as passed or missing", async () => {
    const dir = await materialize("cypress-e2e", { git: true });
    await writeFile(
      join(dir, "cypress/e2e/broken.cy.js"),
      'import { nope } from "../../src/missing.js";\n\nit("never runs", () => {\n  expect(nope).to.equal(1);\n});\n',
    );
    const out = await (await SmartTest.open({ root: dir })).run({ formats: ["json"] });

    expect(out.report.decision.selectedTests.map((t) => t.filePath)).toContain(
      "cypress/e2e/broken.cy.js",
    );
    const broken = out.report.executions.find((e) => e.file === "cypress/e2e/broken.cy.js");
    expect(broken?.status).toBe("failed");
    expect(broken?.tests[0]?.error?.message).toMatch(/missing\.js/);
    expect(out.exitCode).toBe(1);
  }, 300_000);
});
