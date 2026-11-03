/**
 * `smarttest audit` (S29): fault injection, reachability and resolution measure selection. Each
 * check must report a miss when there is one, not only pass on a clean project.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { audit, SmartTest } from "@smarttest/core";
import { describe, expect, it } from "vitest";
import { loadTraces, saveTraces } from "../packages/core/src/traces.js";
import { git, materialize } from "./helpers.js";

async function project(config: string, files: Record<string, string> = {}): Promise<string> {
  const dir = await materialize("ts-lib-vitest", { git: true });
  await writeFile(join(dir, "smarttest.config.mjs"), config);
  for (const [f, text] of Object.entries(files)) await writeFile(join(dir, f), text);
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

  it("reachability reports a file a test loaded that cannot select it", async () => {
    const dir = await project("export default { adaptive: false };\n");
    const st = await SmartTest.open({ root: dir });
    await st.collectTraces();
    // As if test/numbers.test.ts had loaded src/core/Cache.ts at run time (a link the graph lacks).
    const store = await loadTraces(st.storeDir);
    const numbers = store?.tests["test/numbers.test.ts"];
    expect(numbers).toBeDefined();
    if (store && numbers) {
      numbers.fileHashes["src/core/Cache.ts"] = "planted";
      await saveTraces(st.storeDir, store);
    }
    const r = await audit(st, { traces: {} });
    expect(r.traces?.unreachable).toEqual([
      { test: "test/numbers.test.ts", file: "src/core/Cache.ts" },
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
