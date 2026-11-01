import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

interface UiModule {
  csvCell(value: unknown): string;
  toCsv(rows: unknown[][]): string;
}

// The web app is plain browser JavaScript; its pure helpers load in Node unchanged.
const ui = (await import(
  pathToFileURL(join(import.meta.dirname, "..", "web", "js", "ui.js")).href
)) as UiModule;

describe("tests CSV export", () => {
  it("neutralises spreadsheet formulas in repository-controlled cells", () => {
    expect(ui.csvCell('=HYPERLINK("http://evil.example","x")')).toBe(
      `"'=HYPERLINK(""http://evil.example"",""x"")"`,
    );
    for (const cell of ["+1+cmd|' /C calc'!A0", "-2+3", "@SUM(A1)", "\t=1", "\r=1"])
      expect(ui.csvCell(cell).replace(/^"/, "").startsWith("'")).toBe(true);
    expect(ui.csvCell("src/util.test.ts")).toBe("src/util.test.ts");
    expect(ui.toCsv([["a,b", 2]])).toBe('"a,b",2\n');
  });
});
