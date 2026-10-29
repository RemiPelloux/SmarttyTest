// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are source code under test
import { describe, expect, it } from "vitest";
import { analyzeSource } from "./analyze.js";

const hints = (src: string) =>
  analyzeSource("src/shared/a.test.ts", src).dynamicHints?.map((h) => h.pattern);

describe("statically evaluated dynamic imports", () => {
  it("resolves module-level string constants in template literals", () => {
    expect(
      hints(
        "const SCRIPTS = '../../scripts/seo-static/';\nawait import(/* @vite-ignore */ `${SCRIPTS}finalize-prerender.mjs`);",
      ),
    ).toEqual(["../../scripts/seo-static/finalize-prerender.mjs"]);
  });

  it("understands new URL(…, import.meta.url), fileURLToPath and resolve(__dirname…)", () => {
    expect(
      hints(
        "const dir = new URL('../tpl/', import.meta.url);\nimport(new URL('a.mjs', dir).href);",
      ),
    ).toEqual(["../tpl/a.mjs"]);
    expect(
      hints(
        "import { resolve, dirname } from 'node:path';\nconst here = dirname(fileURLToPath(import.meta.url));\nimport(resolve(here, '../payment/currency.ts'));",
      ),
    ).toEqual(["../payment/currency.ts"]);
    expect(hints("require(require('path').join(__dirname, 'fixtures', 'x.js'));")).toEqual([
      "fixtures/x.js",
    ]);
  });

  it("turns unknown parts into bounded globs", () => {
    expect(
      hints(
        "const tplDir = '../src/server/email/templates';\nexport const load = (name) => import(`${tplDir}/${name}.ts`);",
      ),
    ).toEqual(["../src/server/email/templates/*.ts"]);
  });

  it("leaves truly unknowable imports as uncertainty", () => {
    const a = analyzeSource(
      "x.ts",
      "export const load = (file) => import(file);\nimport(pathToFileURL(file).href);",
    );
    expect(a.dynamicHints).toBeUndefined();
    expect(a.dynamicUnresolved).toHaveLength(2);
  });
});
