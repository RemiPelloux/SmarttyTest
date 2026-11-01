import { spawnSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { VitestAdapter } from "@smarttest/adapter-vitest";
import { SmartTest } from "@smarttest/core";
import { describe, expect, it } from "vitest";
import { edit, git, materialize } from "./helpers.js";

/**
 * A test is what a runner collects, not what its name looks like (AGENTS.md: when unsure, select
 * the test). Each case is a change that a real run fails on, and that SmartTest used to skip.
 */
const selectedOf = (a: { decision: { selectedTests: { filePath: string }[] } }) =>
  a.decision.selectedTests.map((t) => t.filePath).sort();

async function write(dir: string, files: Record<string, string>): Promise<void> {
  for (const [file, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, file)), { recursive: true });
    await writeFile(join(dir, file), text);
  }
}

/** ts-lib-vitest with extra files, committed; then `change` is applied uncommitted. */
async function vitestProject(
  files: Record<string, string>,
  remove: string[] = [],
): Promise<string> {
  const dir = await materialize("ts-lib-vitest", { git: true });
  for (const f of remove) await rm(join(dir, f));
  await write(dir, files);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "setup");
  return dir;
}

const analyze = async (dir: string) =>
  (await SmartTest.open({ root: dir })).analyze({ mode: "balanced" });

describe("files a runner collects are tests, whatever their name", () => {
  it("Vitest `include` naming files that do not look like tests", async () => {
    const dir = await vitestProject(
      {
        "vitest.config.ts":
          'import { fileURLToPath } from "node:url";\nimport { defineConfig } from "vitest/config";\nexport default defineConfig({\n  resolve: { alias: { "@lib": fileURLToPath(new URL("./src", import.meta.url)) } },\n  test: { include: ["checks/**/*.ts"] },\n});\n',
        "checks/numbers.ts":
          'import { expect, it } from "vitest";\nimport { clamp } from "@lib/util/numbers";\n\nit("clamps", () => expect(clamp(12, 0, 10)).toBe(10));\n',
      },
      ["test/numbers.test.ts"],
    );
    await edit(dir, "src/util/numbers.ts", "Math.min(max,", "Math.min(max + 1,");
    const a = await analyze(dir);
    expect(a.testFiles).toContain("checks/numbers.ts");
    expect(selectedOf(a)).toEqual(["checks/numbers.ts"]);
  }, 120_000);

  it("a test another test imports: the walk goes on to the importer", async () => {
    const dir = await vitestProject(
      {
        "test/shared.test.ts":
          'import { expect, it } from "vitest";\nimport { clamp } from "@lib/util/numbers";\n\nexport const checkClamp = (v: number) => expect(clamp(v, 0, 10)).toBe(10);\nit("shared self", () => expect(1).toBe(1));\n',
        "test/uses-shared.test.ts":
          'import { it } from "vitest";\nimport { checkClamp } from "./shared.test";\n\nit("uses shared", () => checkClamp(12));\n',
      },
      ["test/numbers.test.ts"],
    );
    await edit(dir, "src/util/numbers.ts", "Math.min(max,", "Math.min(max + 1,");
    expect(selectedOf(await analyze(dir))).toEqual([
      "test/shared.test.ts",
      "test/uses-shared.test.ts",
    ]);

    // A change to the imported test itself selects its importers too.
    git(dir, "checkout", "-q", "--", "src/util/numbers.ts");
    await edit(dir, "test/shared.test.ts", "toBe(10)", "toBe(11)");
    expect(selectedOf(await analyze(dir))).toEqual([
      "test/shared.test.ts",
      "test/uses-shared.test.ts",
    ]);
  }, 120_000);

  it("Vitest type tests (`*.test-d.ts`) with typecheck enabled, seeded by a type change", async () => {
    const dir = await vitestProject({
      "vitest.config.ts":
        'import { fileURLToPath } from "node:url";\nimport { defineConfig } from "vitest/config";\nexport default defineConfig({\n  resolve: { alias: { "@lib": fileURLToPath(new URL("./src", import.meta.url)) } },\n  test: { typecheck: { enabled: true } },\n});\n',
      "src/types.ts": "export type Id = string;\nexport const mk = (): Id => 'a';\n",
      "test/types.test-d.ts":
        'import { expectTypeOf, test } from "vitest";\nimport type { Id } from "../src/types";\n\ntest("id", () => expectTypeOf<Id>().toEqualTypeOf<string>());\n',
    });
    await edit(dir, "src/types.ts", "type Id = string", "type Id = number");
    const a = await analyze(dir);
    expect(a.testFiles).toContain("test/types.test-d.ts");
    expect(selectedOf(a)).toEqual(["test/types.test-d.ts"]);
  }, 120_000);

  it("Vitest in-source tests (`includeSource`)", async () => {
    const dir = await vitestProject({
      "vitest.config.ts":
        'import { fileURLToPath } from "node:url";\nimport { defineConfig } from "vitest/config";\nexport default defineConfig({\n  resolve: { alias: { "@lib": fileURLToPath(new URL("./src", import.meta.url)) } },\n  test: { includeSource: ["src/**/*.ts"] },\n});\n',
      "src/util/sum.ts":
        'import { clamp } from "./numbers";\n\nexport const sum = (a: number, b: number) => clamp(a + b, 0, 10);\n\nif (import.meta.vitest) {\n  const { it, expect } = import.meta.vitest;\n  it("sums", () => expect(sum(1, 2)).toBe(3));\n}\n',
    });
    const a0 = await analyze(dir);
    expect(a0.testFiles).toContain("src/util/sum.ts");
    expect(a0.testFiles).not.toContain("src/util/numbers.ts");
    await edit(dir, "src/util/numbers.ts", "Math.min(max,", "Math.min(max + 1,");
    expect(selectedOf(await analyze(dir))).toEqual(["src/util/sum.ts", "test/numbers.test.ts"]);
  }, 120_000);

  it("a vitest.workspace file is never passed as --config", async () => {
    const dir = await materialize("ts-lib-vitest");
    await rm(join(dir, "vitest.config.ts"));
    await writeFile(join(dir, "vitest.workspace.ts"), "export default ['.'];\n");
    const files = (
      await new VitestAdapter({
        projectRoot: dir,
        cwd: dir,
        configFile: "vitest.workspace.ts",
      }).discover()
    )
      .map((t) => t.filePath)
      .sort();
    expect(files).toEqual([
      "test/cache.test.ts",
      "test/labeler.test.ts",
      "test/numbers.test.ts",
      "test/strings.test.ts",
    ]);
  }, 120_000);

  const bin = resolve(import.meta.dirname, "../packages/cli/dist/bin.js");
  const run = (dir: string) =>
    spawnSync(process.execPath, [bin, "run", "--uncommitted", "--no-cache", "--json"], {
      cwd: dir,
      encoding: "utf8",
    });

  it("node --test: a file under test/ that is not named like a test runs, and fails", async () => {
    const dir = await materialize("node-test-esm", { git: true });
    await write(dir, {
      "package.json":
        '{ "name": "n", "private": true, "type": "module", "scripts": { "test": "node --test" } }\n',
      "test/money-check.js":
        'import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport * as money from "../src/money.js";\n\ntest("money exports", () => assert.ok(Object.keys(money).length > 0));\n',
    });
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "check");
    await writeFile(join(dir, "src/money.js"), "export {};\n");
    const a = await analyze(dir);
    expect(a.testFiles).toContain("test/money-check.js");
    expect(selectedOf(a)).toContain("test/money-check.js");
    const r = run(dir);
    const json = JSON.parse(r.stdout);
    const selected = json.report.decision.selectedTests.map(
      (t: { filePath: string }) => t.filePath,
    );
    expect(selected).toContain("test/money-check.js");
    // The failure is reported, never a pass by omission.
    expect(r.status, r.stderr).toBe(1);
    const exec = json.report.executions.find(
      (e: { file: string }) => e.file === "test/money-check.js",
    );
    expect(exec?.status).toBe("failed");
  }, 180_000);

  // Node 22.18+ and 23.6+ strip types by default: `node --test` runs .ts test files.
  it.skipIf(typeof (process.features as { typescript?: unknown }).typescript !== "string")(
    "node --test: TypeScript test files of a Node that strips types",
    async () => {
      const dir = await materialize("node-test-esm", { git: true });
      await write(dir, {
        "src/math.ts": "export const add = (a: number, b: number): number => a + b;\n",
        "test/math.ts":
          'import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { add } from "../src/math.ts";\n\ntest("add", () => assert.equal(add(1, 2), 3));\n',
        "src/math.test.ts":
          'import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { add } from "./math.ts";\n\ntest("add here", () => assert.equal(add(2, 2), 4));\n',
        "package.json":
          '{ "name": "n", "private": true, "type": "module", "scripts": { "test": "node --test" } }\n',
      });
      git(dir, "add", "-A");
      git(dir, "commit", "-q", "-m", "ts");
      await edit(dir, "src/math.ts", "a + b", "a + b + 1");
      const a = await analyze(dir);
      expect(selectedOf(a)).toEqual(["src/math.test.ts", "test/math.ts"]);
      expect(a.unassignedTests).toEqual([]);
      const r = run(dir);
      expect(r.status, r.stderr).toBe(1);
      const failed = JSON.parse(r.stdout)
        .report.executions.filter((e: { status: string }) => e.status === "failed")
        .map((e: { file: string }) => e.file)
        .sort();
      expect(failed).toEqual(["src/math.test.ts", "test/math.ts"]);
    },
    180_000,
  );
});
