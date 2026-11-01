/**
 * Calls through declared types, module-level instances and mocks (audit fixes): a change to the
 * member that runs selects the test, and an unrelated member does not.
 */
import { analyzeSource } from "@smarttest/language-typescript";
import type { FileAnalysis } from "@smarttest/source-parser";
import { describe, expect, it } from "vitest";
import { DependencyGraph } from "./index.js";

/** Builds a graph; imports resolve by matching the specifier's tail to a file name. */
function graph(files: Record<string, string>) {
  const map = new Map<string, FileAnalysis>();
  for (const [p, c] of Object.entries(files)) {
    const a = analyzeSource(p, c);
    for (const imp of a.imports) {
      const tail = imp.specifier.replace(/^(\.\.?\/)+/, "");
      const r = Object.keys(files).find(
        (f) => f.replace(/\.ts$/, "") === tail || f.replace(/\.ts$/, "").endsWith(`/${tail}`),
      );
      if (r) imp.resolved = r;
      else imp.external = true;
    }
    map.set(p, a);
  }
  return new DependencyGraph(map, (p) => p.includes(".test."));
}

const repo = {
  "src/repo.ts": `export interface Repo { find(): number }
export interface Store extends Repo { save(): void }
export class MemRepo implements Store { find() { return 1; } save() {} other() { return 2; } }
export class PgRepo implements Repo { find() { return 3; } }
export class Base { m() { return 1; } n() { return this.m(); } }
export class Sub extends Base { m() { return 2; } }
`,
};

function selects(code: string, test: string, file: string, unit: string): boolean {
  const g = graph({ ...repo, "src/case.ts": code, "test/t.test.ts": test });
  return g.dependentsOf([{ file, units: [unit] }]).tests.has("test/t.test.ts");
}

describe("calls through a declared type", () => {
  it("`const r: Repo = new MemRepo()` reaches MemRepo's member", () => {
    const code =
      'import { MemRepo, Repo } from "./repo";\nexport function f() { const r: Repo = new MemRepo(); return r.find(); }\n';
    const test = 'import { f } from "../src/case";\nit("x", () => f());\n';
    expect(selects(code, test, "src/repo.ts", "MemRepo.find")).toBe(true);
    expect(selects(code, test, "src/repo.ts", "MemRepo.other")).toBe(false);
  });

  it("a class field `private repo: Repo = new MemRepo()` reaches MemRepo's member", () => {
    const code =
      'import { MemRepo, Repo } from "./repo";\nexport class Svc { private repo: Repo = new MemRepo(); get() { return this.repo.find(); } }\n';
    const test = 'import { Svc } from "../src/case";\nit("x", () => new Svc().get());\n';
    expect(selects(code, test, "src/repo.ts", "MemRepo.find")).toBe(true);
    expect(selects(code, test, "src/repo.ts", "MemRepo.other")).toBe(false);
  });

  it("`const s: Base = new Sub()` reaches the override", () => {
    const code =
      'import { Sub, Base } from "./repo";\nexport function f() { const s: Base = new Sub(); return s.m(); }\n';
    const test = 'import { f } from "../src/case";\nit("x", () => f());\n';
    expect(selects(code, test, "src/repo.ts", "Sub.m")).toBe(true);
  });

  it("a receiver typed by an interface reaches every implementation of the member", () => {
    const code =
      'import type { Repo } from "./repo";\nexport function count(r: Repo) { return r.find(); }\n';
    const test = 'import { count } from "../src/case";\nit("x", () => count(globalThis.repo));\n';
    expect(selects(code, test, "src/repo.ts", "MemRepo.find")).toBe(true);
    expect(selects(code, test, "src/repo.ts", "PgRepo.find")).toBe(true);
    expect(selects(code, test, "src/repo.ts", "MemRepo.save")).toBe(false);
  });

  it("follows interfaces that extend interfaces", () => {
    const code =
      'import type { Store } from "./repo";\nexport function count(s: Store) { return s.find(); }\n';
    const test = 'import { count } from "../src/case";\nit("x", () => count(globalThis.repo));\n';
    expect(selects(code, test, "src/repo.ts", "MemRepo.find")).toBe(true);
    expect(selects(code, test, "src/repo.ts", "PgRepo.find")).toBe(false);
  });

  it("a receiver typed by a base class reaches overrides, and base code calling them", () => {
    const code =
      'import type { Base } from "./repo";\nexport const viaBase = (b: Base) => b.n();\n';
    const test = 'import { viaBase } from "../src/case";\nit("x", () => viaBase(globalThis.b));\n';
    expect(selects(code, test, "src/repo.ts", "Sub.m")).toBe(true);
  });

  it("constructor injection: the test passing `new MemRepo()` is selected", () => {
    const code =
      'import type { Repo } from "./repo";\nexport class Svc { constructor(private repo: Repo) {} get() { return this.repo.find(); } }\n';
    const test =
      'import { Svc } from "../src/case";\nimport { MemRepo } from "../src/repo";\nit("x", () => new Svc(new MemRepo()).get());\n';
    expect(selects(code, test, "src/repo.ts", "MemRepo.find")).toBe(true);
  });
});

describe("module-level instances", () => {
  it("`export const repo = new MemRepo()`: users of repo.find reach MemRepo.find only", () => {
    const code = 'import { MemRepo } from "./repo";\nexport const repo = new MemRepo();\n';
    const test = 'import { repo } from "../src/case";\nit("x", () => repo.find());\n';
    expect(selects(code, test, "src/repo.ts", "MemRepo.find")).toBe(true);
    expect(selects(code, test, "src/repo.ts", "MemRepo.other")).toBe(false);
  });

  it("an instance handed out as a whole reaches every member", () => {
    const code = 'import { MemRepo } from "./repo";\nexport const repo = new MemRepo();\n';
    const test = 'import { repo } from "../src/case";\nit("x", () => use(repo));\n';
    expect(selects(code, test, "src/repo.ts", "MemRepo.other")).toBe(true);
  });

  it("through a namespace import and a declared type", () => {
    const code =
      'import { MemRepo, Repo } from "./repo";\nexport const repo: Repo = new MemRepo();\n';
    const test = 'import * as c from "../src/case";\nit("x", () => c.repo.find());\n';
    expect(selects(code, test, "src/repo.ts", "MemRepo.find")).toBe(true);
  });
});

describe("mocks", () => {
  const files = {
    "src/m.ts": "export const f = () => 1;\n",
  };

  it("vi.doMock does not hide the file's static import of the real module", () => {
    const g = graph({
      ...files,
      "test/m.test.ts": `import { f } from "../src/m";
it("real", () => f());
it("mocked", async () => { vi.doMock("../src/m", () => ({ f: () => 42 })); await import("../src/m"); });
`,
    });
    expect(g.dependentsOf([{ file: "src/m.ts", units: ["f"] }]).tests.has("test/m.test.ts")).toBe(
      true,
    );
  });

  it("a hoisted factory calling a helper still loads the real module", () => {
    const g = graph({
      ...files,
      "test/m.test.ts": `import { f } from "../src/m";
vi.mock("../src/m", () => partialMock());
it("x", () => f());
`,
    });
    expect(g.dependentsOf([{ file: "src/m.ts", units: ["f"] }]).tests.has("test/m.test.ts")).toBe(
      true,
    );
  });

  it("a hoisted pure factory still hides the real module", () => {
    const g = graph({
      ...files,
      "test/m.test.ts": `import { f } from "../src/m";
vi.mock("../src/m", () => ({ f: vi.fn() }));
it("x", () => f());
`,
    });
    expect(g.dependentsOf([{ file: "src/m.ts", units: ["f"] }]).tests.has("test/m.test.ts")).toBe(
      false,
    );
  });
});
