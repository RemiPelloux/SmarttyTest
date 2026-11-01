import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DependencyGraph } from "@smarttest/dependency-graph";
import { analyzeSource } from "@smarttest/language-typescript";
import { sha256 } from "@smarttest/shared";
import type { FileAnalysis } from "@smarttest/source-parser";
import { describe, expect, it } from "vitest";
import { GraphStore, PATCHED_FILES_BEFORE_SAVE } from "./graph-store.js";

const isTest = (p: string) => p.endsWith(".test.ts");

/** A chain m0 ← m1 ← … with one test per module; `salt` changes every body, never a surface. */
function project(n: number, salt = 0): Map<string, FileAnalysis> {
  const files = new Map<string, FileAnalysis>();
  const add = (path: string, text: string, resolve: Record<string, string>) => {
    const a = analyzeSource(path, text);
    for (const i of a.imports) {
      const r = resolve[i.specifier];
      if (r) i.resolved = r;
      else i.external = true;
    }
    files.set(path, a);
  };
  for (let i = 0; i < n; i++) {
    const dep = i ? `import { f${i - 1} } from "./m${i - 1}";\n` : "";
    add(
      `src/m${i}.ts`,
      `${dep}export function f${i}(x: number): number {\n  return ${i ? `f${i - 1}(x)` : "x"} + ${salt};\n}\n`,
      i ? { [`./m${i - 1}`]: `src/m${i - 1}.ts` } : {},
    );
    add(`test/m${i}.test.ts`, `import { f${i} } from "../src/m${i}";\nit("x", () => f${i}(1));\n`, {
      [`../src/m${i}`]: `src/m${i}.ts`,
    });
  }
  return files;
}

const selected = (g: DependencyGraph, file: string, unit: string) =>
  [...g.dependentsOf([{ file, units: [unit] }]).tests.keys()].sort();

describe("GraphStore", () => {
  it("rewrites a patched graph once many files differ, and loads it afterwards", async () => {
    const dir = await mkdtemp(join(tmpdir(), "st-graph-store-"));
    const n = PATCHED_FILES_BEFORE_SAVE + 8;
    const before = project(n);
    const store = () => new GraphStore(dir, { mode: "balanced" }, {});
    await store().save(new DependencyGraph(before, isTest), before);
    expect(store().load(before, isTest).status).toBe("loaded");

    // Every module body changed: patched, worth writing.
    const after = project(n, 1);
    const s = store();
    const load = s.load(after, isTest);
    expect(load.status).toBe("patched");
    expect(GraphStore.shouldSave(load)).toBe(true);
    if (load.status !== "patched") return;
    const fresh = new DependencyGraph(after, isTest);
    expect(selected(load.graph, "src/m3.ts", "f3")).toEqual(selected(fresh, "src/m3.ts", "f3"));
    expect(load.graph.stats).toEqual(fresh.stats);
    await s.save(load.graph, after);
    const again = store().load(after, isTest);
    expect(again.status).toBe("loaded");
    if (again.status === "loaded")
      expect(selected(again.graph, "src/m3.ts", "f3")).toEqual(selected(fresh, "src/m3.ts", "f3"));
    // …and its header describes the new contents exactly, as a fresh save would.
    const patchedText = await readFile(s.path, "utf8");
    await store().save(fresh, after);
    const freshText = await readFile(s.path, "utf8");
    const header = (t: string) => JSON.parse(t.slice(0, t.indexOf("\n")));
    expect(header(patchedText).files).toEqual(header(freshText).files);
    expect(header(patchedText).resolution).toEqual(header(freshText).resolution);
  });

  it("never uses a graph from other options or configuration", async () => {
    const dir = await mkdtemp(join(tmpdir(), "st-graph-store-"));
    const files = project(3);
    await new GraphStore(dir, { mode: "balanced" }, {}).save(
      new DependencyGraph(files, isTest),
      files,
    );
    expect(new GraphStore(dir, { mode: "safe" }, {}).load(files, isTest)).toMatchObject({
      status: "stale",
      reason: "configuration changed",
    });
    expect(
      new GraphStore(dir, { mode: "balanced" }, { e2eTests: new Set(["test/m0.test.ts"]) }).load(
        files,
        isTest,
      ),
    ).toMatchObject({ status: "stale" });
    // A resolution change with identical contents (another target for the same import).
    const moved = project(3);
    const imp = moved.get("src/m2.ts")?.imports[0];
    if (imp) imp.resolved = "src/m0.ts";
    expect(new GraphStore(dir, { mode: "balanced" }, {}).load(moved, isTest)).toMatchObject({
      status: "structural",
      reason: "module resolution changed",
    });
    // A damaged body.
    const path = join(dir, "state", "graph.json");
    const text = await readFile(path, "utf8");
    const nl = text.indexOf("\n");
    await writeFile(path, `${text.slice(0, nl + 1)}${text.slice(nl + 1).replace("{", "{ ")}`);
    expect(new GraphStore(dir, { mode: "balanced" }, {}).load(files, isTest)).toMatchObject({
      status: "corrupt",
    });
  });

  it("never restores a graph this machine did not write, even with a consistent header (SR-16)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "st-graph-store-"));
    const files = project(3);
    const store = () => new GraphStore(dir, { mode: "balanced" }, {});
    await store().save(new DependencyGraph(files, isTest), files);
    expect(store().load(files, isTest).status).toBe("loaded");
    // The header's checks are over public data: recompute them for a body with an edge renamed.
    const text = await readFile(store().path, "utf8");
    const nl = text.indexOf("\n");
    const header = JSON.parse(text.slice(0, nl)) as { body: string };
    const body = text.slice(nl + 1).replace(/"src\/m1\.ts"/g, '"src/mX.ts"');
    header.body = sha256(body);
    await writeFile(store().path, `${JSON.stringify(header)}\n${body}`);
    expect(store().load(files, isTest)).toMatchObject({ status: "corrupt" });
    await rm(`${store().path}.mac`);
    expect(store().load(files, isTest)).toMatchObject({ status: "corrupt" });
  });
});
