import { statSync } from "node:fs";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "@smarttest/shared";
import type { Analyzer, FileAnalysis, ModuleResolver } from "@smarttest/source-parser";
import { describe, expect, it } from "vitest";
import { SymbolIndex } from "./index.js";

/** Imports are `import "./x"` lines; resolution maps "./x" to "x.ts" when that file exists. */
const analyzer: Analyzer = {
  id: "fake",
  version: "fake-1",
  supports: (p) => p.endsWith(".ts"),
  analyze: (path, content): FileAnalysis => ({
    path,
    hash: sha256(content),
    language: "typescript",
    moduleKind: "esm",
    imports: [...content.matchAll(/import "\.\/(\w+)"/g)].map((m, line) => ({
      specifier: `./${m[1]}`,
      kind: "side-effect",
      bindings: [],
      typeOnly: false,
      line,
    })) as FileAnalysis["imports"],
    symbols: [],
    localExports: [],
    topLevelRefs: [],
    topLevelHash: "",
    importsHash: "",
    dynamicUnresolved: [],
    parseErrors: 0,
    analyzerVersion: "fake-1",
  }),
};

async function project(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "st-index-"));
  for (const [p, c] of Object.entries(files)) await writeFile(join(root, p), c);
  return root;
}

async function update(root: string, files: string[], contextKey = "ctx") {
  const set = new Set(files);
  const resolver: ModuleResolver = {
    resolve: (_from, spec) => {
      const target = `${spec.slice(2)}.ts`;
      return set.has(target) ? { resolved: target } : { reason: "not found" };
    },
  };
  const index = await SymbolIndex.load(join(root, ".smarttest"));
  const stats = await index.update({ root, files, analyzers: [analyzer], resolver, contextKey });
  await index.save();
  return { index, stats };
}

const state = (root: string, f: string) =>
  readFile(join(root, ".smarttest", "state", f), "utf8").then(
    (t) => JSON.parse(t) as Record<string, unknown>,
    () => undefined,
  );
const snapshot = (i: SymbolIndex) => JSON.stringify([...i.entries()]);

describe("SymbolIndex persistence", () => {
  it("writes a small delta for a few changed files and loads exactly what it saved", async () => {
    const root = await project({ "a.ts": 'import "./b"', "b.ts": "1", "c.ts": 'import "./b"' });
    const files = ["a.ts", "b.ts", "c.ts"];
    await update(root, files);
    const base = await state(root, "index.json");
    expect(base?.baseId).toEqual(expect.any(String));
    expect(await state(root, "index-delta.json")).toBeUndefined();

    // A content change: the delta, not the full index, is written.
    await writeFile(join(root, "b.ts"), "22");
    const edited = await update(root, files);
    expect(edited.stats.parsed).toBe(1);
    expect(await state(root, "index.json")).toEqual(base);
    const delta = await state(root, "index-delta.json");
    expect(delta?.baseId).toBe(base?.baseId);
    expect(Object.keys(delta?.files as object)).toEqual(["b.ts"]);
    const loaded = await SymbolIndex.load(join(root, ".smarttest"));
    expect(snapshot(loaded)).toBe(snapshot(edited.index));
    expect((await update(root, files)).stats.parsed).toBe(0);

    // A deleted file stays deleted; its importers keep it visible as missing.
    await rm(join(root, "b.ts"));
    const removed = await update(root, ["a.ts", "c.ts"], "ctx2");
    expect(removed.index.get("b.ts")).toBeUndefined();
    expect(removed.index.get("a.ts")?.imports[0]).toMatchObject({
      resolved: "b.ts",
      missing: true,
    });
    // A new context (and file set) re-resolves everything: a full write, and no delta left.
    expect(await state(root, "index-delta.json")).toBeUndefined();
    expect((await state(root, "index.json"))?.baseId).not.toBe(base?.baseId);
    expect(snapshot(await SymbolIndex.load(join(root, ".smarttest")))).toBe(
      snapshot(removed.index),
    );
  });

  it("ignores a delta written against another full index", async () => {
    const root = await project({ "a.ts": "1", "b.ts": "2" });
    await update(root, ["a.ts", "b.ts"]);
    await writeFile(join(root, "a.ts"), "11");
    await update(root, ["a.ts", "b.ts"]);
    const delta = (await state(root, "index-delta.json")) as Record<string, unknown>;
    await writeFile(
      join(root, ".smarttest", "state", "index-delta.json"),
      JSON.stringify({ ...delta, baseId: "another" }),
    );
    const loaded = await SymbolIndex.load(join(root, ".smarttest"));
    expect(loaded.get("a.ts")?.hash).toBe(sha256("1"));
    // The base's stale entry is re-validated by its stats and re-parsed.
    const again = await update(root, ["a.ts", "b.ts"]);
    expect(again.stats.parsed).toBe(1);
    expect(again.index.get("a.ts")?.hash).toBe(sha256("11"));
  });

  it("rewrites the full index once the delta grows large", async () => {
    const files = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`f${i}.ts`, `${i}`]));
    const root = await project(files);
    const paths = Object.keys(files);
    await update(root, paths);
    const base = await state(root, "index.json");
    const later = new Date(Date.now() + 5000);
    for (const p of paths) await utimes(join(root, p), later, later);
    await update(root, paths);
    expect(await state(root, "index-delta.json")).toBeUndefined();
    expect((await state(root, "index.json"))?.baseId).not.toBe(base?.baseId);
  });
});

describe("SymbolIndex trust (SR-16)", () => {
  it("never uses an index or delta it did not write, even with matching hashes and stats", async () => {
    const root = await project({ "a.ts": 'import "./b"', "b.ts": "1" });
    await update(root, ["a.ts", "b.ts"]);
    // A crafted index: the right content hash and stats for a.ts, but its import of b.ts removed
    // (that edge would select a.ts's tests when b.ts changes). Written without the MAC.
    const stored = (await state(root, "index.json")) as {
      files: Record<string, FileAnalysis>;
    };
    stored.files["a.ts"] = { ...(stored.files["a.ts"] as FileAnalysis), imports: [] };
    await writeFile(join(root, ".smarttest", "state", "index.json"), JSON.stringify(stored));
    const loaded = await SymbolIndex.load(join(root, ".smarttest"));
    expect(loaded.size).toBe(0);
    expect(loaded.loadWarnings.join()).toMatch(/rebuilt/);
    const { index, stats } = await update(root, ["a.ts", "b.ts"]);
    expect(stats.parsed).toBe(2);
    expect(index.get("a.ts")?.imports.map((i) => i.resolved)).toEqual(["b.ts"]);
  });
});

describe("SymbolIndex resolution", () => {
  /** "./name" resolves to the first of name.ts / name.json that exists on disk. */
  const diskResolver = (root: string, extra: Partial<ModuleResolver> = {}): ModuleResolver => ({
    resolve: (_from, spec) => {
      for (const ext of [".ts", ".json"]) {
        const target = `${spec.slice(2)}${ext}`;
        if (statSync(join(root, target), { throwIfNoEntry: false })) return { resolved: target };
      }
      return { reason: "not found" };
    },
    ...extra,
  });
  const run = async (root: string, files: string[], resolver: ModuleResolver) => {
    const index = await SymbolIndex.load(join(root, ".smarttest"));
    await index.update({ root, files, analyzers: [analyzer], resolver, contextKey: "ctx" });
    await index.save();
    return index;
  };

  // Audit p10: the file set holds source files only, so deleting an imported JSON/SVG/CSS file
  // kept the stale resolution and the change selected nothing.
  it("re-resolves the importers of an asset deleted or restored with a warm index", async () => {
    const root = await project({ "a.ts": 'import "./data"', "data.json": "{}" });
    const files = ["a.ts"];
    expect((await run(root, files, diskResolver(root))).get("a.ts")?.imports[0]).toMatchObject({
      resolved: "data.json",
    });
    await rm(join(root, "data.json"));
    const gone = (await run(root, files, diskResolver(root))).get("a.ts")?.imports[0];
    expect(gone).toMatchObject({ resolved: "data.json", missing: true, unresolved: "not found" });
    // The stored index says so too.
    const loaded = await SymbolIndex.load(join(root, ".smarttest"));
    expect(loaded.get("a.ts")?.imports[0]?.missing).toBe(true);
    await writeFile(join(root, "data.json"), "{}");
    const back = (await run(root, files, diskResolver(root))).get("a.ts")?.imports[0];
    expect(back?.resolved).toBe("data.json");
    expect(back?.unresolved).toBeUndefined();
  });

  it("re-resolves an unresolved import once the asset it names exists", async () => {
    const root = await project({ "a.ts": 'import "./data"' });
    const first = await run(root, ["a.ts"], diskResolver(root));
    expect(first.get("a.ts")?.imports[0]?.unresolved).toBe("not found");
    await writeFile(join(root, "data.json"), "{}");
    const imp = (await run(root, ["a.ts"], diskResolver(root))).get("a.ts")?.imports[0];
    expect(imp?.resolved).toBe("data.json");
    expect(imp?.unresolved).toBeUndefined();
  });

  // Audit p5/p14: a gitignored build (lib/index.js) is no graph node; trusting the edge lost the
  // tests of the source it is built from.
  it("turns code resolved outside the indexed files into uncertainty", async () => {
    const root = await project({ "a.ts": 'import "./b"', "b.ts": "" });
    const imp = (await run(root, ["a.ts"], diskResolver(root))).get("a.ts")?.imports[0];
    expect(imp?.unresolved).toBe('resolves to "b.ts", which is not an indexed source file');
    expect(imp?.resolved).toBeUndefined();
  });

  it("keeps the edge of an uncertain resolution and records its reason", async () => {
    const root = await project({ "a.ts": 'import "./b"', "b.ts": "" });
    const resolver: ModuleResolver = {
      resolve: () => ({ resolved: "b.ts", uncertain: "conditions disagree" }),
    };
    const imp = (await run(root, ["a.ts", "b.ts"], resolver)).get("a.ts")?.imports[0];
    expect(imp).toMatchObject({ resolved: "b.ts", unresolved: "conditions disagree" });
  });

  it("matches an aliased glob pattern through the resolver", async () => {
    const root = await project({ "a.ts": "", "p1.ts": "", "p2.ts": "" });
    const globber: Analyzer = {
      ...analyzer,
      analyze: (path, content) => ({
        ...analyzer.analyze(path, content),
        ...(path === "a.ts"
          ? { dynamicHints: [{ pattern: "@/p*.ts", line: 0, expr: "glob" }] }
          : {}),
      }),
    };
    const index = await SymbolIndex.load(join(root, ".smarttest"));
    await index.update({
      root,
      files: ["a.ts", "p1.ts", "p2.ts"],
      analyzers: [globber],
      resolver: diskResolver(root, {
        resolvePattern: (_f, p) => (p.startsWith("@/") ? p.slice(2) : undefined),
      }),
    });
    expect(index.get("a.ts")?.dynamicTargets).toEqual(["p1.ts", "p2.ts"]);
    expect(index.get("a.ts")?.dynamicUnmatched).toBeUndefined();
  });
});
