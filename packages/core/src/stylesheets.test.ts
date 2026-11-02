import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { styleImports, styleKey, stylesheetImporters } from "./stylesheets.js";

describe("styleImports", () => {
  it("reads @use, @forward, @import (several per statement) and CSS url()", () => {
    expect(
      styleImports(`@use "sass:math";
@use "../styles/vars" as v;
@use 'theme' with ($primary: "red");
@forward "./mixins" show m;
@import 'a', "b";
@import url("reset.css");
// @import "commented";
/* @use "also-commented"; */
.x { color: red; }`),
    ).toEqual(["../styles/vars", "theme", "./mixins", "a", "b", "reset.css"]);
  });

  it("reads unquoted imports in the indented syntax", () => {
    expect(styleImports("@import vars, mixins\n.x\n  color: red", "a.sass")).toEqual([
      "vars",
      "mixins",
    ]);
  });
});

describe("styleKey", () => {
  it("drops partial underscores, extensions and index files", () => {
    expect(styleKey("src/styles/_vars.scss")).toBe("src/styles/vars");
    expect(styleKey("src/theme/_index.scss")).toBe("src/theme");
    expect(styleKey("~bootstrap/scss/functions")).toBe("bootstrap/scss/functions");
  });
});

describe("stylesheetImporters", () => {
  it("finds direct and transitive importers, relative and through load paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "st-styles-"));
    const files: Record<string, string> = {
      "src/styles/_vars.scss": "$c: red;",
      "src/styles/_theme.scss": '@forward "vars";',
      "src/app/a.component.scss": '@use "../styles/theme";',
      "src/app/b.component.scss": '@use "styles/vars";', // includePaths: ["src"]
      "src/app/c.component.scss": ".c { color: blue; }",
      "node_modules/lib/_x.scss": '@use "vars";',
    };
    for (const [f, text] of Object.entries(files)) {
      await mkdir(dirname(join(root, f)), { recursive: true });
      await writeFile(join(root, f), text);
    }
    const map = await stylesheetImporters(root, Object.keys(files), [
      "src/styles/_vars.scss",
      "src/app/c.component.scss",
    ]);
    expect(map.get("src/styles/_vars.scss")).toEqual([
      "src/app/a.component.scss",
      "src/app/b.component.scss",
      "src/styles/_theme.scss",
    ]);
    expect(map.has("src/app/c.component.scss")).toBe(false);
  });
});
