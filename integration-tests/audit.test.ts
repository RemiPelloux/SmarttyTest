/**
 * `smarttest audit` (S29): fault injection, reachability and resolution measure selection. Each
 * check must report a miss when there is one, not only pass on a clean project.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { audit, SmartTest } from "@smarttest/core";
import { describe, expect, it } from "vitest";
import { git, materialize } from "./helpers.js";

async function project(config: string, files: Record<string, string> = {}): Promise<string> {
  const dir = await materialize("ts-lib-vitest", { git: true });
  await writeFile(join(dir, "smarttest.config.mjs"), config);
  for (const [f, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, f)), { recursive: true });
    await writeFile(join(dir, f), text);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "audit setup");
  return dir;
}

describe("smarttest audit", () => {
  it("a clean project: every injected fault is caught, every import agrees, every load reaches", async () => {
    const dir = await project("export default { adaptive: false };\n");
    const before = await readFile(join(dir, "src/util/strings.ts"), "utf8");
    const r = await audit(await SmartTest.open({ root: dir }), {
      mutate: { mutants: 20 },
      traces: {},
      resolution: true,
    });
    expect(r.mutate?.mutants.length).toBe(r.mutate?.functions);
    expect(r.mutate?.missed).toBe(0);
    expect(r.mutate?.caught).toBeGreaterThan(0);
    expect(r.traces?.unreachable).toEqual([]);
    expect(r.traces?.pairs).toBeGreaterThan(0);
    expect(r.resolution?.mismatches).toEqual([]);
    expect(r.resolution?.agree).toBeGreaterThan(0);
    // The faults went into a temporary checkout, never into the project.
    expect(await readFile(join(dir, "src/util/strings.ts"), "utf8")).toBe(before);
    expect(git(dir, "status", "--porcelain")).toBe("");
  }, 300_000);

  it("reachability reports a file a test reads that cannot select it", async () => {
    // Read through a path relative to the working directory: nothing in the code ties it to the
    // test, so a change to the data would not select it.
    const dir = await project("export default { adaptive: false };\n", {
      "data/rates.json": '{ "vat": 20 }\n',
      "test/rates.test.ts":
        'import { readFileSync } from "node:fs";\nimport { expect, it } from "vitest";\n\nit("reads the rates", () => {\n  expect(JSON.parse(readFileSync("data/rates.json", "utf8")).vat).toBe(20);\n});\n',
    });
    const r = await audit(await SmartTest.open({ root: dir }), { traces: {} });
    expect(r.traces?.unreachable).toEqual([
      { test: "test/rates.test.ts", file: "data/rates.json" },
    ]);
  }, 300_000);

  it("fault injection reports the test FAST mode does not select (an import it cannot evaluate)", async () => {
    const dir = await project('export default { mode: "fast", adaptive: false };\n', {
      "src/util/hidden.ts": "export function secret(): number {\n  return 42;\n}\n",
      "test/hidden.test.ts":
        'import { expect, it } from "vitest";\n\nit("loads a module by a computed name", async () => {\n  const name = process.env.HIDDEN_MODULE ?? "../src/util/hidden";\n  const m = await import(name);\n  expect(m.secret()).toBe(42);\n});\n',
    });
    const r = await audit(await SmartTest.open({ root: dir }), { mutate: { mutants: 50 } });
    const secret = r.mutate?.mutants.find((m) => m.function === "secret");
    expect(secret?.outcome).toBe("missed");
    expect(secret?.missed).toEqual(["test/hidden.test.ts"]);
    expect(r.mutate?.missed).toBe(1);
  }, 300_000);
});
