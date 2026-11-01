/**
 * Files a runner loads because its configuration names them: setup files and what they import,
 * the configuration's own imports, and modules an alias maps a specifier to. Each change selects
 * exactly the tests it can affect, a cached pass never hides it, and discovery follows the
 * configuration's imports.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SmartTest } from "@smarttest/core";
import { describe, expect, it } from "vitest";
import { edit, git, materialize } from "./helpers.js";

const ALL = [
  "test/add.test.ts",
  "test/handlers.test.ts",
  "test/limit.test.ts",
  "test/mul.test.ts",
  "test/theme.test.ts",
];

async function selection(dir: string): Promise<string[]> {
  const a = await (await SmartTest.open({ root: dir })).analyze({ mode: "safe" });
  return a.decision.selectedTests.map((t) => t.filePath).sort();
}

describe("runner inputs · runner-inputs-vitest", () => {
  it("a targeted change selects only the tests it can affect", async () => {
    const dir = await materialize("runner-inputs-vitest", { git: true });
    const cases: [string, string, string, string[]][] = [
      // Setup file and the module it imports: every Vitest test loads them.
      ["src/mocks/handlers.ts", '"alice"', '"bob"', ALL],
      ["test/support/setup.ts", "= handlers;", '= { user: "carol" };', ALL],
      // The configuration and the shared settings it imports.
      ["vitest.shared.ts", '__LIMIT__: "3"', '__LIMIT__: "4"', ALL],
      ["vitest.config.ts", "test: { setupFiles", "test: { /* note */ setupFiles", ALL],
      // A module an alias maps to: the tests reaching an import of the mapped specifier.
      ["test/support/flags.ts", "darkMode = true", "darkMode = false", ["test/theme.test.ts"]],
      // Ordinary source: symbol precision is unchanged.
      ["src/math.ts", "return a + b;", "return a - b;", ["test/add.test.ts"]],
    ];
    for (const [file, find, replace, expected] of cases) {
      await edit(dir, file, find, replace);
      expect(await selection(dir), file).toEqual(expected);
      await edit(dir, file, replace, find);
    }
  }, 120_000);

  it("explain names the setup file and the runner", async () => {
    const dir = await materialize("runner-inputs-vitest", { git: true });
    await edit(dir, "src/mocks/handlers.ts", '"alice"', '"bob"');
    const st = await SmartTest.open({ root: dir });
    const test = await st.explain("test/handlers.test.ts", { fresh: true });
    expect(test.kind).toBe("test");
    expect(test.status).toBe("selected");
    expect(test.reasons).toEqual([
      "src/mocks/handlers.ts changed — imported by test/support/setup.ts, setup file of vitest (setupFiles in vitest.config.ts)",
    ]);
    const source = await st.explain("test/support/setup.ts");
    expect(source.kind).toBe("source");
    if (source.kind !== "source") return;
    expect(source.loadedBy).toEqual([
      {
        reason: "setup file of vitest (setupFiles in vitest.config.ts)",
        tests: ALL,
      },
    ]);
  }, 120_000);

  it("a change to what the configuration loads never produces a cached pass", async () => {
    const dir = await materialize("runner-inputs-vitest", { git: true });
    // The test file itself changed: it is selected on every run below.
    await edit(dir, "test/handlers.test.ts", "it(", "// touched\nit(");
    const first = await (await SmartTest.open({ root: dir })).run({});
    expect(first.report.summary.failed).toBe(0);
    const second = await (await SmartTest.open({ root: dir })).run({});
    expect(second.report.executions.every((e) => e.status === "cached-pass")).toBe(true);
    // The handlers the setup file installs change: the cached pass no longer holds.
    await edit(dir, "src/mocks/handlers.ts", '"alice"', '"bob"');
    const third = await (await SmartTest.open({ root: dir })).run({});
    expect(third.report.executions.some((e) => e.status === "cached-pass")).toBe(false);
    expect(third.report.summary.failed).toBeGreaterThan(0);
  }, 180_000);

  it("discovery follows the files the configuration imports", async () => {
    const dir = await materialize("runner-inputs-vitest", { git: true });
    await mkdir(join(dir, "spec"));
    await writeFile(
      join(dir, "spec/extra.test.ts"),
      'import { expect, it } from "vitest";\nit("extra", () => expect(1).toBe(1));\n',
    );
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "extra");
    const before = await (await SmartTest.open({ root: dir })).analyze({});
    expect(before.testFiles).not.toContain("spec/extra.test.ts");
    expect(before.unassignedTests).toContain("spec/extra.test.ts");
    // Only the imported shared settings change: the cached listing must not be reused.
    await edit(
      dir,
      "vitest.shared.ts",
      '"test/**/*.test.ts"',
      '"test/**/*.test.ts", "spec/**/*.test.ts"',
    );
    const after = await (await SmartTest.open({ root: dir })).analyze({});
    expect(after.testFiles).toContain("spec/extra.test.ts");
  }, 120_000);
});
