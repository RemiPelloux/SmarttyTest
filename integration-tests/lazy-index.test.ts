/**
 * 1.2.0 performance: the index is loaded lazily (symbol-index, schema 3): each analysis's symbols
 * and top-level uses stay in the stored text until a reader asks for them. Laziness must never
 * change a selection: for a range of changes, an analysis through the stored (lazy) index selects
 * exactly what a cold analysis selects, whose analyses are all parsed in memory.
 */
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Analysis, SmartTest } from "@smarttest/core";
import type { FileAnalysis } from "@smarttest/source-parser";
import { describe, expect, it } from "vitest";
import { git, materialize } from "./helpers.js";

/** What a decision selects and why, without what differs between runs (times, store notes). */
const decisionOf = (a: Analysis) => ({
  status: a.decision.analysisStatus,
  fallback: a.decision.fallbackApplied,
  selected: a.decision.selectedTests
    .map((t) => ({ id: t.testId, reasons: t.reasons }))
    .sort((x, y) => x.id.localeCompare(y.id)),
  skipped: a.decision.skippedTests.map((t) => t.testId).sort(),
  affectedFiles: [...a.decision.affectedFiles].sort(),
  affectedSymbols: [...a.decision.affectedSymbols].sort(),
});

const lazy = (a: FileAnalysis | undefined) =>
  !!a && !!Object.getOwnPropertyDescriptor(a, "symbols")?.get;

/**
 * Applies each change in turn (undoing the previous one), and compares the analysis through the
 * project's store with a cold one. Returns how many analyses had files left unparsed.
 */
async function compareChanges(
  dir: string,
  changes: { file: string; change: (text: string) => string }[],
): Promise<number> {
  await (await SmartTest.open({ root: dir })).analyze();
  let lazyRuns = 0;
  for (const { file, change } of changes) {
    const path = join(dir, file);
    const original = await readFile(path, "utf8");
    await writeFile(path, change(original));
    const stored = await (await SmartTest.open({ root: dir })).analyze();
    if ([...stored.index.entries().values()].some(lazy)) lazyRuns++;
    const cold = await (await SmartTest.open({ root: dir, ephemeralStore: true })).analyze();
    expect([...cold.index.entries().values()].some(lazy)).toBe(false);
    expect(decisionOf(stored), `${file}`).toEqual(decisionOf(cold));
    await writeFile(path, original);
  }
  return lazyRuns;
}

/** Edits of a source file: its body, a new export, a removed line, an emptied file. */
function editsOf(file: string, text: string): { file: string; change: (t: string) => string }[] {
  const lines = text.split("\n");
  const middle = Math.floor(lines.length / 2);
  return [
    { file, change: (t) => `${t}\nexport const lazyProbe = 1;\n` },
    { file, change: (t) => t.replace(/return\b/, "return 0 ||") },
    { file, change: () => lines.filter((_, i) => i !== middle).join("\n") },
    { file, change: () => "" },
  ];
}

/** Source files (not tests) of an analysis, in path order. */
const sources = (a: Analysis) =>
  [...a.index.entries().keys()]
    .filter((f) => !a.testFiles.includes(f) && !f.includes("test"))
    .sort();

describe("lazily loaded index", () => {
  it.each(["ts-lib-vitest", "nest-auth-vitest", "edges-vitest", "react-vitest", "pnpm-monorepo"])(
    "%s: every change selects what a cold analysis selects",
    async (fixture) => {
      const dir = await materialize(fixture, { git: true });
      const first = await (await SmartTest.open({ root: dir })).analyze();
      const files = sources(first);
      // Spread over the project: up to four files, each edited four ways.
      const step = Math.max(1, Math.floor(files.length / 4));
      const picked = files.filter((_, i) => i % step === 0).slice(0, 4);
      expect(picked.length).toBeGreaterThan(0);
      const changes = [];
      for (const f of picked) changes.push(...editsOf(f, await readFile(join(dir, f), "utf8")));
      await compareChanges(dir, changes);
    },
    240_000,
  );

  it("a generated layered project: lazy and cold analyses agree, and most files stay unparsed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "st-lazy-"));
    const n = 200;
    const perLayer = 10;
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({
        name: "lazy",
        private: true,
        type: "module",
        devDependencies: { vitest: "^5.0.5" },
      }),
    );
    await writeFile(
      join(dir, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "Bundler" } }),
    );
    await writeFile(
      join(dir, "smarttest.config.json"),
      JSON.stringify({ tests: { discovery: "static" } }),
    );
    await mkdir(join(dir, "src"));
    await mkdir(join(dir, "tests"));
    for (let i = 0; i < n; i++) {
      const layer = Math.floor(i / perLayer);
      // Two imports from the layer below, chosen deterministically.
      const deps =
        layer > 0
          ? [
              ...new Set([
                (layer - 1) * perLayer + ((i * 7) % perLayer),
                (layer - 1) * perLayer + ((i * 3 + 1) % perLayer),
              ]),
            ]
          : [];
      const imports = deps.map((d) => `import { Service${d} } from "./m${d}";`).join("\n");
      const uses = deps.map((d) => `new Service${d}().run(x)`).join(" + ") || "x";
      await writeFile(
        join(dir, "src", `m${i}.ts`),
        `${imports}\n\nexport class Service${i} {\n  run(x: number): number {\n    return ${uses} + ${i};\n  }\n  name(): string {\n    return "s${i}";\n  }\n}\n\nexport function helper${i}(v: number): number {\n  return v * ${i % 7};\n}\n`,
      );
      await writeFile(
        join(dir, "tests", `m${i}.test.ts`),
        `import { expect, it } from "vitest";\nimport { ${i % 2 ? `helper${i}` : `Service${i}`} } from "../src/m${i}";\n\nit("runs", () => {\n  expect(${i % 2 ? `helper${i}(1)` : `new Service${i}().name()`}).toBeDefined();\n});\n`,
      );
    }
    git(dir, "init", "-q", "-b", "main");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "initial");
    const at = (i: number) => `src/m${i}.ts`;
    const changes = [
      // Bodies (the stored graph is patched), at the top, middle and bottom of the layers.
      ...[0, 5, 95, 100, 150, 199].map((i) => ({
        file: at(i),
        change: (t: string) => t.replace(` + ${i};`, ` + ${i} + 1;`),
      })),
      // A member only some tests reach.
      { file: at(42), change: (t: string) => t.replace('return "s42";', 'return "S42";') },
      { file: at(43), change: (t: string) => t.replace("v * 1", "v * 2") },
      // Exports and imports (the graph is rebuilt).
      { file: at(77), change: (t: string) => `${t}\nexport const extra = 1;\n` },
      { file: at(120), change: (t: string) => t.replace(/^import .*\n/, "") },
      { file: at(60), change: () => "" },
    ];
    const lazyRuns = await compareChanges(dir, changes);
    // A graph rebuild (the last three changes) reads every file; a patched graph does not.
    expect(lazyRuns).toBe(changes.length - 3);
    // A change at the bottom layer reaches one test: most files are never parsed (once the graph
    // stored for the restored project is there to patch).
    await (await SmartTest.open({ root: dir })).analyze();
    const leaf = join(dir, at(195));
    await writeFile(leaf, (await readFile(leaf, "utf8")).replace("v * 6", "v * 7"));
    const a = await (await SmartTest.open({ root: dir })).analyze();
    const unparsed = [...a.index.entries().values()].filter(lazy).length;
    expect(a.decision.selectedTests.map((t) => t.testId)).toEqual(["tests/m195.test.ts"]);
    expect(unparsed).toBeGreaterThan(n);
  }, 240_000);
});
