import { analyzeSource } from "@smarttest/language-typescript";
import type { FileAnalysis } from "@smarttest/source-parser";
import { describe, expect, it } from "vitest";
import { DependencyGraph } from "./index.js";

/** Deterministic pseudo-random numbers (mulberry32). */
function random(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A random project: modules importing each other (cycles included), some with a dynamic import
 * (uncertainty), and tests importing modules.
 */
function project(seed: number, modules: number, tests: number) {
  const rnd = random(seed);
  const files = new Map<string, FileAnalysis>();
  const name = (i: number) => `src/m${i}.ts`;
  const add = (path: string, deps: number[], dynamic: boolean) => {
    const src = [
      ...deps.map((d, k) => `import { v${d} as d${k} } from "./m${d}";`),
      dynamic ? "export const load = (p: string) => import(p);" : "",
      `export const v${path.replace(/\D/g, "")} = 1;`,
    ].join("\n");
    const a = analyzeSource(path, src);
    for (const imp of a.imports) {
      const m = /^\.\/m(\d+)$/.exec(imp.specifier);
      if (m) imp.resolved = name(Number(m[1]));
    }
    files.set(path, a);
  };
  for (let i = 0; i < modules; i++) {
    const deps = new Set<number>();
    const n = Math.floor(rnd() * 4);
    for (let k = 0; k < n; k++) deps.add(Math.floor(rnd() * modules)); // any index: cycles too
    deps.delete(i);
    add(name(i), [...deps], rnd() < 0.15);
  }
  for (let t = 0; t < tests; t++) {
    const deps = new Set([Math.floor(rnd() * modules), Math.floor(rnd() * modules)]);
    const path = `test/t${t}.test.ts`;
    const a = analyzeSource(
      path,
      [...deps].map((d, k) => `import { v${d} as d${k} } from "../src/m${d}";`).join("\n"),
    );
    for (const imp of a.imports) {
      const m = /m(\d+)$/.exec(imp.specifier);
      if (m) imp.resolved = name(Number(m[1]));
    }
    files.set(path, a);
  }
  return new DependencyGraph(files, (p) => p.includes(".test."));
}

/** The definitions the graph's backward passes replace: one forward closure per file. */
const naive = {
  reachable(g: DependencyGraph, file: string) {
    const out: { file: string; reasons: string[] }[] = [];
    for (const f of [file, ...g.dependenciesOf(file)]) {
      const u = g.uncertainty.get(f);
      if (u) out.push({ file: f, reasons: u });
    }
    return out;
  },
  dependingOn(g: DependencyGraph, files: string[], matches: (f: string) => boolean) {
    return files.filter((f) => [...g.dependenciesOf(f)].some(matches)).sort();
  },
};

describe("DependencyGraph backward passes", () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    it(`match a closure per file (seed ${seed})`, () => {
      const g = project(seed, 60, 30);
      // A fresh graph per side: the naive closures fill the cache the backward passes avoid.
      const fast = project(seed, 60, 30);
      const files = [...g.toGraph().nodes.map((n) => n.id)].filter((f) => !f.includes("#"));
      expect(g.uncertainty.size).toBeGreaterThan(0);
      for (const f of files) {
        const expected = naive.reachable(g, f);
        expect(fast.uncertaintyReachableFrom(f)).toEqual(expected);
        expect(fast.uncertaintyReachableFrom(f, 2)).toEqual(expected.slice(0, 2));
        expect(fast.uncertaintyCount(f)).toBe(expected.length);
      }
      // Callers select a matching file on its own: they compare "matches or depends on a match".
      for (const scope of ["src/m1", "src/m2", "src/m3", "test/t1"]) {
        const matches = (f: string) => f.startsWith(scope);
        const users = fast.filesDependingOn(matches);
        const expected = new Set(naive.dependingOn(g, files, matches));
        for (const f of files)
          expect(users.has(f) || matches(f)).toBe(expected.has(f) || matches(f));
      }
    });
  }

  it("counts every uncertain file of an import cycle for each file of the cycle", () => {
    const files = new Map<string, FileAnalysis>();
    const src: Record<string, string> = {
      "src/a.ts": 'import { b } from "./b";\nexport const a = (p: string) => import(p);\n',
      "src/b.ts": 'import { a } from "./a";\nexport const b = (p: string) => import(p);\n',
      "src/c.ts": 'import { a } from "./a";\nexport const c = 1;\n',
    };
    for (const [p, c] of Object.entries(src)) {
      const a = analyzeSource(p, c);
      for (const imp of a.imports) imp.resolved = `src/${imp.specifier.slice(2)}.ts`;
      files.set(p, a);
    }
    const g = new DependencyGraph(files, () => false);
    expect(g.uncertaintyCount("src/a.ts")).toBe(2);
    expect(g.uncertaintyCount("src/c.ts")).toBe(2);
    expect(g.uncertaintyReachableFrom("src/c.ts").map((u) => u.file)).toEqual([
      ...g.dependenciesOf("src/c.ts"),
    ]);
    // src/a.ts reaches itself through the cycle (callers test a matching file on its own).
    expect(g.filesDependingOn((f) => f === "src/a.ts")).toEqual(
      new Set(["src/a.ts", "src/b.ts", "src/c.ts"]),
    );
  });
});
