import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyMutation, CompilerResolver, MUTANT_ERROR, mutationPoints } from "./oracle.js";

describe("mutationPoints", () => {
  const text = [
    "export function add(a: number, b: number) {",
    "  return a + b;",
    "}",
    "export const twice = (n: number) => n * 2;",
    "export class Box {",
    "  constructor(private v: number) {}",
    "  get value() { return this.v; }",
    "  open(): number { return this.v; }",
    "  close = () => 0;",
    "}",
    "export function overload(a: string): string;",
    "export function overload(a: string) { return a; }",
  ].join("\n");
  it("finds every function with a body and names it", () => {
    expect(mutationPoints("a.ts", text).map((p) => p.name)).toEqual([
      "add",
      "twice",
      "Box.constructor",
      "Box.value",
      "Box.open",
      "Box.close",
      "overload",
    ]);
  });
  it("a block gets a throw first; an expression body becomes a throwing call", () => {
    const [add, twice] = mutationPoints("a.ts", text);
    if (!add || !twice) throw new Error("expected two mutation points");
    expect(applyMutation(text, add)).toContain(`{ ${MUTANT_ERROR}\n  return a + b;`);
    expect(applyMutation(text, twice)).toContain(`(n: number) => (() => { ${MUTANT_ERROR} })();`);
  });
});

describe("CompilerResolver", () => {
  it("resolves as tsc does: project files, paths aliases, packages and types", async () => {
    const root = await mkdtemp(join(tmpdir(), "st-oracle-"));
    const files: Record<string, string> = {
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          paths: { "@lib/*": ["./src/lib/*"] },
        },
      }),
      "package.json": '{"type":"module"}',
      "src/lib/x.ts": "export const x = 1;",
      "src/a.ts": "",
      "src/only-types.d.ts": "export type T = 1;",
      "node_modules/pkg/package.json": '{"name":"pkg","main":"index.js"}',
      "node_modules/pkg/index.js": "",
    };
    for (const [f, t] of Object.entries(files)) {
      await mkdir(dirname(join(root, f)), { recursive: true });
      await writeFile(join(root, f), t);
    }
    const r = new CompilerResolver(root);
    expect(r.resolve("src/a.ts", "./lib/x.js")).toEqual({ kind: "project", file: "src/lib/x.ts" });
    expect(r.resolve("src/a.ts", "@lib/x.js")).toEqual({ kind: "project", file: "src/lib/x.ts" });
    expect(r.resolve("src/a.ts", "pkg")).toEqual({ kind: "external" });
    expect(r.resolve("src/a.ts", "./only-types.js")).toEqual({
      kind: "types-only",
      file: "src/only-types.d.ts",
    });
    expect(r.resolve("src/a.ts", "./missing.js")).toEqual({ kind: "unresolved" });
  });
});
