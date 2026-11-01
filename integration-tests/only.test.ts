import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { main } from "smarttest";
import { describe, expect, it } from "vitest";
import { edit, git, materialize } from "./helpers.js";

/**
 * `--only <path>` restricts the changed set before selection, never the dependency analysis:
 * a file reached only through an unresolved import still selects the tests that load it.
 */

const SCHEMAS = resolve(import.meta.dirname, "../packages/cli/schemas");

async function cli(cwd: string, ...argv: string[]) {
  let out = "";
  let err = "";
  const code = await main(
    argv,
    {
      stdout: { write: (s: string) => (out += s), isTTY: false },
      stderr: { write: (s: string) => (err += s), isTTY: false },
    } as never,
    cwd,
  );
  return { code, out, err };
}

interface Scope {
  paths: string[];
  matched: string[];
  unchanged: string[];
  excluded: string[];
}
interface ImpactJson {
  description: string;
  decision: { selectedTests: { filePath: string }[]; warnings: string[] };
  only?: Scope;
}

async function impact(dir: string, ...args: string[]): Promise<ImpactJson> {
  const r = await cli(dir, "impact", "--uncommitted", ...args, "--json");
  expect(r.code, r.out).toBe(0);
  return JSON.parse(r.out) as ImpactJson;
}

const selected = (doc: ImpactJson) => doc.decision.selectedTests.map((t) => t.filePath).sort();

/** Required keys of the `only` object, as the schema declares them. */
async function onlyRequired(schema: "impact" | "run"): Promise<string[]> {
  const doc = JSON.parse(await readFile(join(SCHEMAS, `${schema}.v1.schema.json`), "utf8"));
  const only =
    schema === "impact"
      ? doc.properties.only
      : doc.properties.report.properties.change.properties.only;
  return only.required as string[];
}

describe("--only: file-scoped selection", () => {
  it("selects only the tests of the named file when two files changed", async () => {
    const dir = await materialize("ts-lib-vitest", { git: true });
    // A behaviour-preserving change to clamp() and a breaking change to capitalize().
    await edit(dir, "src/util/numbers.ts", "Math.max(min, n)", "Math.max(n, min)");
    await edit(dir, "src/util/strings.ts", "s.charAt(0).toUpperCase()", "s.charAt(0)");

    const whole = await impact(dir);
    expect(selected(whole)).toEqual(
      expect.arrayContaining(["test/numbers.test.ts", "test/strings.test.ts"]),
    );
    expect(whole.only).toBeUndefined();

    const numbers = await impact(dir, "--only", "src/util/numbers.ts");
    expect(selected(numbers)).toEqual(["test/numbers.test.ts"]);
    expect(numbers.only).toEqual({
      paths: ["src/util/numbers.ts"],
      matched: ["src/util/numbers.ts"],
      unchanged: [],
      excluded: ["src/util/strings.ts"],
    });
    expect(Object.keys(numbers.only ?? {}).sort()).toEqual((await onlyRequired("impact")).sort());
    expect(numbers.description).toContain("only src/util/numbers.ts");
    expect(numbers.decision.warnings.join("\n")).toContain("1 other changed file(s)");

    // An absolute path and a directory both name the same scope.
    const absolute = await impact(dir, "--only", join(dir, "src/util/numbers.ts"));
    expect(selected(absolute)).toEqual(["test/numbers.test.ts"]);
    const directory = await impact(dir, "--only", "src/util/");
    expect(selected(directory)).toEqual(selected(whole));
    expect(directory.only?.excluded).toEqual([]);

    // The scoped run passes: the broken capitalize() is outside the scope, and says so.
    const run = await cli(dir, "run", "--uncommitted", "--only", "src/util/numbers.ts", "--json");
    expect(run.code, run.out).toBe(0);
    const report = JSON.parse(run.out).report;
    expect(report.executions.map((e: { file: string }) => e.file)).toEqual([
      "test/numbers.test.ts",
    ]);
    expect(report.change.only.excluded).toEqual(["src/util/strings.ts"]);
    expect(report.change.changeSet.changes.map((c: { path: string }) => c.path)).toEqual([
      "src/util/numbers.ts",
    ]);
    expect(report.command).toBe("run --affected --only src/util/numbers.ts");
    expect(Object.keys(report.change.only).sort()).toEqual((await onlyRequired("run")).sort());

    // Scoped to the broken file, the failure is found.
    const broken = await cli(dir, "run", "--uncommitted", "--only", "src/util/strings.ts");
    expect(broken.code).toBe(1);
  }, 180_000);

  it("selects nothing for a file with no change and says so", async () => {
    const dir = await materialize("ts-lib-vitest", { git: true });
    await edit(dir, "src/util/numbers.ts", "Math.max(min, n)", "Math.max(n, min)");
    const doc = await impact(dir, "--only", "src/core/Cache.ts");
    expect(selected(doc)).toEqual([]);
    expect(doc.only).toMatchObject({ unchanged: ["src/core/Cache.ts"], matched: [] });
    expect(doc.decision.warnings[0]).toContain("src/core/Cache.ts has no change");

    const text = await cli(dir, "impact", "--uncommitted", "--only", "src/core/Cache.ts");
    expect(text.out).toContain("src/core/Cache.ts has no change");
    expect(text.out).toMatch(/SELECTED\]?\s+0\n/);
  }, 120_000);

  it("still selects through the file's unresolved relationships", async () => {
    const dir = await materialize("ts-lib-vitest", { git: true });
    // src/plugins/csv.ts is reached only through a dynamic import the analysis cannot resolve.
    await mkdir(join(dir, "src/plugins"));
    await writeFile(
      join(dir, "src/plugins/registry.ts"),
      'export async function load(name: string): Promise<(rows: string[][]) => string> {\n  const mod = await import("./" + name);\n  return mod.default;\n}\n',
    );
    await writeFile(
      join(dir, "src/plugins/csv.ts"),
      'export default (rows: string[][]): string => rows.map((r) => r.join(",")).join("\\n");\n',
    );
    await writeFile(
      join(dir, "test/registry.test.ts"),
      'import { expect, it } from "vitest";\nimport { load } from "../src/plugins/registry";\n\nit("loads the csv plugin", async () => expect((await load("csv"))([["a", "b"]])).toBe("a,b"));\n',
    );
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "plugins");
    await edit(dir, "src/plugins/csv.ts", 'r.join(",")', 'r.join(", ")');
    await edit(dir, "src/util/numbers.ts", "Math.max(min, n)", "Math.max(n, min)");

    const doc = await impact(dir, "--only", "src/plugins/csv.ts");
    expect(doc.only?.excluded).toEqual(["src/util/numbers.ts"]);
    // No static path from any test to csv.ts, yet the registry test cannot be ruled out.
    expect(selected(doc)).toContain("test/registry.test.ts");
    expect(selected(doc)).not.toContain("test/numbers.test.ts");
    expect(doc.decision.warnings.join("\n")).not.toContain("has no change");

    // A file with no change selects nothing, unresolved imports elsewhere or not.
    const unchanged = await impact(dir, "--only", "src/core/Cache.ts");
    expect(selected(unchanged)).toEqual([]);

    const run = await cli(dir, "run", "--uncommitted", "--only", "src/plugins/csv.ts", "--json");
    expect(run.code, run.out).toBe(1);
    expect(
      JSON.parse(run.out).report.executions.find(
        (e: { file: string }) => e.file === "test/registry.test.ts",
      )?.status,
    ).toBe("failed");
  }, 180_000);

  it("matches a path by its real letter case and refuses a path that is neither changed nor on disk", async () => {
    const dir = await materialize("ts-lib-vitest", { git: true });
    await edit(dir, "src/util/strings.ts", "s.charAt(0).toUpperCase()", "s.charAt(0)");
    // Wrong case: on a case-insensitive file system it would match nothing and skip every test.
    const run = await cli(dir, "run", "--uncommitted", "--only", "src/Util/Strings.ts", "--json");
    expect(run.code, run.out).toBe(1);
    const report = JSON.parse(run.out).report;
    expect(report.change.only.matched).toEqual(["src/util/strings.ts"]);
    expect(report.decision.warnings.join("\n")).toContain("matched src/util/strings.ts");
    // A typo is a usage error, never an all-skipped pass.
    const typo = await cli(dir, "run", "--uncommitted", "--only", "src/util/strngs.ts", "--json");
    expect(typo.code).toBe(2);
    expect(JSON.parse(typo.out).error).toMatchObject({ code: "ST_USAGE", category: "usage" });
  }, 120_000);

  it("rejects --only outside the project, with --all and with --hook", async () => {
    const dir = await materialize("ts-lib-vitest", { git: true });
    expect((await cli(dir, "impact", "--only", "../elsewhere.ts")).code).toBe(2);
    expect((await cli(dir, "run", "--all", "--only", "src/index.ts")).code).toBe(2);
    expect((await cli(dir, "run", "--staged", "--hook", "--only", "src/index.ts")).code).toBe(2);
  }, 60_000);
});
