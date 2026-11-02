/**
 * The Angular adapter against a real Angular CLI workspace (fixtures/projects/angular-cli, Angular
 * 22, unit-test builder with Vitest).
 *
 * The fixture is outside the pnpm workspace so the Angular toolchain stays out of every install;
 * these tests run only when SMARTTEST_REAL_ANGULAR=1, which the `angular (real install)` job in
 * .github/workflows/ci.yml sets after `npm ci`. Locally:
 *   npm ci --prefix fixtures/projects/angular-cli
 *   SMARTTEST_REAL_ANGULAR=1 pnpm vitest run integration-tests/angular-real.test.ts
 */
import { SmartTest } from "@smarttest/core";
import { describe, expect, it } from "vitest";
import { edit, materialize } from "./helpers.js";

const statuses = (out: Awaited<ReturnType<SmartTest["run"]>>) =>
  Object.fromEntries(
    out.report.executions.flatMap((e) => e.tests.map((t) => [t.testId, t.status] as const)),
  );

describe.runIf(process.env.SMARTTEST_REAL_ANGULAR === "1")("Angular CLI (real install)", () => {
  it("runs through ng test: the full suite reports what ng test reports", async () => {
    const dir = await materialize("angular-cli", { git: true });
    const st = await SmartTest.open({ root: dir });
    expect((await st.profile()).runners.map((r) => [r.adapter, r.project])).toEqual([
      ["angular", "demo"],
    ]);
    const out = await st.run({ all: true, formats: ["json"] });
    expect(statuses(out)).toEqual({
      "src/app/app.spec.ts::App should create the app": "passed",
      "src/app/app.spec.ts::App should render title": "passed",
      "src/app/badge/badge.spec.ts::Badge shows its label": "passed",
      "src/app/price.spec.ts::Price formats an amount": "passed",
    });
  }, 300_000);

  it("a template change selects its component's spec, which fails", async () => {
    const dir = await materialize("angular-cli", { git: true });
    await edit(dir, "src/app/badge/badge.html", "{{ label }}", "{{ label }}!");
    const out = await (await SmartTest.open({ root: dir })).run({ formats: ["json"] });
    expect(out.report.decision.selectedTests.map((t) => t.filePath)).toEqual([
      "src/app/badge/badge.spec.ts",
    ]);
    expect(statuses(out)).toEqual({
      "src/app/badge/badge.spec.ts::Badge shows its label": "failed",
    });
  }, 300_000);

  it("a Sass partial selects the components whose styles use it", async () => {
    const dir = await materialize("angular-cli", { git: true });
    await edit(dir, "src/styles/_tokens.scss", "#c00", "#0c0");
    const a = await (await SmartTest.open({ root: dir })).analyze();
    expect(a.decision.selectedTests.map((t) => t.filePath)).toEqual([
      "src/app/badge/badge.spec.ts",
    ]);
  }, 300_000);

  it("a type error in an export no test runs fails the specs that compile it", async () => {
    const dir = await materialize("angular-cli", { git: true });
    await edit(
      dir,
      "src/app/price.ts",
      "@Service()",
      'export const unused: number = "x";\n\n@Service()',
    );
    const out = await (await SmartTest.open({ root: dir })).run({ formats: ["json"] });
    expect(out.report.decision.selectedTests.map((t) => t.filePath)).toEqual([
      "src/app/price.spec.ts",
    ]);
    expect(out.exitCode).not.toBe(0);
    expect(JSON.stringify(out.report)).toContain("TS2322");
  }, 300_000);

  it("fileReplacements: the development environment the tests build with selects its readers", async () => {
    const dir = await materialize("angular-cli", { git: true });
    await edit(dir, "src/environments/environment.development.ts", "'EUR'", "'GBP'");
    const out = await (await SmartTest.open({ root: dir })).run({ formats: ["json"] });
    expect(out.report.decision.selectedTests.map((t) => t.filePath)).toEqual([
      "src/app/price.spec.ts",
    ]);
    expect(statuses(out)).toEqual({ "src/app/price.spec.ts::Price formats an amount": "failed" });
  }, 300_000);
});
