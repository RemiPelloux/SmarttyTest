import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { TypeScriptResolver, typescriptAnalyzer } from "@smarttest/language-typescript";
import { SymbolIndex } from "@smarttest/symbol-index";
import { describe, expect, it } from "vitest";

/**
 * Adding a file re-resolves only the imports it can affect (not every import of the project), and
 * still gives exactly what a resolution from scratch gives — with TypeScript's own resolution.
 */
describe("incremental resolution with the TypeScript resolver", () => {
  const index = async (root: string, files: string[]) => {
    const idx = await SymbolIndex.load(join(root, ".smarttest"));
    const stats = await idx.update({
      root,
      files,
      analyzers: [typescriptAnalyzer],
      resolver: new TypeScriptResolver(root, []),
      contextKey: "tsconfig",
    });
    await idx.save();
    return { idx, stats };
  };
  const targets = (idx: SymbolIndex, file: string) =>
    Object.fromEntries(
      (idx.get(file)?.imports ?? []).map((i) => [
        i.specifier,
        i.resolved ?? (i.external ? "external" : "unresolved"),
      ]),
    );
  const sorted = (idx: SymbolIndex) =>
    JSON.stringify([...idx.entries()].sort(([a], [b]) => a.localeCompare(b)));

  it("finds a new file that shadows a resolution: a sibling module, an earlier paths target", async () => {
    const root = await mkdtemp(join(tmpdir(), "st-incr-ts-"));
    const write = async (p: string, c = "export const v = 1;\n") => {
      await mkdir(dirname(join(root, p)), { recursive: true });
      await writeFile(join(root, p), c);
    };
    try {
      await write(
        "tsconfig.json",
        JSON.stringify({
          compilerOptions: {
            module: "NodeNext",
            moduleResolution: "Bundler",
            baseUrl: ".",
            paths: {
              "@app/config": ["src/local/settings.ts", "src/config.ts"],
              "@lib/*": ["src/override/*", "src/*"],
            },
          },
        }),
      );
      await write("src/a/index.ts");
      await write("src/config.ts");
      await write("src/m/f.ts");
      await write("src/other.ts");
      await write(
        "src/main.ts",
        [
          'import { v as a } from "./a";',
          'import { v as c } from "@app/config";',
          'import { v as f } from "@lib/m/f";',
          'import { v as o } from "./other";',
          "export const all = [a, c, f, o];",
          "",
        ].join("\n"),
      );
      const base = ["src/a/index.ts", "src/config.ts", "src/m/f.ts", "src/main.ts", "src/other.ts"];
      const first = await index(root, base);
      expect(targets(first.idx, "src/main.ts")).toEqual({
        "./a": "src/a/index.ts",
        "@app/config": "src/config.ts",
        "@lib/m/f": "src/m/f.ts",
        "./other": "src/other.ts",
      });
      const shadows = ["src/a.ts", "src/local/settings.ts", "src/override/m/f.ts"];
      for (const f of shadows) await write(f);
      const files = [...base, ...shadows].sort();
      const second = await index(root, files);
      expect(second.stats.resolvedAll).toBeUndefined();
      expect(targets(second.idx, "src/main.ts")).toEqual({
        "./a": "src/a.ts",
        "@app/config": "src/local/settings.ts",
        "@lib/m/f": "src/override/m/f.ts",
        "./other": "src/other.ts",
      });
      // Identical to resolving everything from scratch.
      const fresh = await mkdtemp(join(tmpdir(), "st-incr-ts-fresh-"));
      await cp(root, fresh, { recursive: true });
      await rm(join(fresh, ".smarttest"), { recursive: true, force: true });
      const scratch = await index(fresh, files);
      expect(scratch.stats.resolvedAll).toBe(true);
      expect(sorted(scratch.idx)).toBe(sorted(second.idx));
      await rm(fresh, { recursive: true, force: true });
      // Removing them restores the earlier resolutions.
      for (const f of shadows) await rm(join(root, f));
      const third = await index(root, base);
      expect(targets(third.idx, "src/main.ts")).toEqual(targets(first.idx, "src/main.ts"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
