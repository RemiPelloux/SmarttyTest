import { describe, expect, it } from "vitest";
import { analyzeSource } from "./analyze.js";

describe("resource collection", () => {
  it("records env keys, models and translation keys per declaration", () => {
    const a = analyzeSource(
      "src/a.ts",
      `import type { Lead } from "wasp/entities";
export function f(ctx: any) { return [process.env.API_URL, process.env["X"], ctx.entities.Job.find()]; }
export function g(db: any) { return db.user.count(); }
export function h(l: Lead, k: string) { return [t("nav.home"), t(k), t(\`menu.\${k}\`)]; }
export function nav(t: (k: string) => string, k: string) { return t(k); }
export function page() { const { t } = useTranslation("auth"); const { t: tl } = useTranslation("landing"); return [t("login"), tl("hero"), nav(t, "x")]; }
const { PORT, ...rest } = process.env;`,
    );
    const res = (n: string) => a.symbols.find((s) => s.qualifiedName === n)?.resources;
    expect(res("f")).toEqual(["env:API_URL", "env:X", "model:Job"]);
    expect(res("g")).toEqual(["model:User"]);
    expect(res("h")).toEqual(["i18n:*", "i18n:menu.*", "i18n:nav.home", "model:Lead"]);
    // A translation function received as a parameter reads in its callers' namespaces.
    expect(res("nav")).toBeUndefined();
    expect(res("page")).toEqual(["i18n:auth.*", "i18n:auth.login", "i18n:landing.hero"]);
    expect(
      a.symbols.find((s) => s.qualifiedName === "PORT")?.resources ?? a.topLevelResources,
    ).toEqual(expect.arrayContaining(["env:*", "env:PORT"]));
  });

  it("does not mistake a local named t for a translation function", () => {
    const a = analyzeSource(
      "a.test.ts",
      'import { take } from "./x";\nit("x", () => { const t = 1; take("a", t); });',
    );
    expect(a.topLevelResources).toBeUndefined();
  });

  it("reads translation catalogs, asset reads and mock kinds", () => {
    const cat = analyzeSource(
      "src/locales/en/common.ts",
      'const r = { a: "x", n: { b: "y" } } as const;\nexport default r;',
    );
    expect(Object.keys(cat.catalogKeys ?? {})).toEqual(["a", "n.b"]);
    const notCat = analyzeSource("src/locales/index.ts", "export const f = () => 1;");
    expect(notCat.catalogKeys).toBeUndefined();
    const reads = analyzeSource(
      "src/t.ts",
      'import { readFileSync } from "node:fs";\nexport function load() { return readFileSync(new URL("./tpl/a.txt", import.meta.url), "utf8"); }\nexport const cwd = () => readFileSync("relative.txt");',
    );
    expect(reads.assetReads).toEqual([{ pattern: "tpl/a.txt", line: 1, unit: "load" }]);
    const mocks = analyzeSource(
      "t.test.ts",
      'vi.mock("./a", () => ({ x: 1 }));\nvi.mock("./b", async (orig) => ({ ...(await orig()) }));\nvi.mock("./c");',
    );
    expect(mocks.imports.map((i) => [i.specifier, i.mock])).toEqual([
      ["./a", "factory"],
      ["./b", "actual"],
      ["./c", "auto"],
    ]);
  });
});
