import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { main } from "smarttest";
import { describe, expect, it } from "vitest";
import { edit, materialize } from "./helpers.js";

const SCHEMAS = resolve(import.meta.dirname, "../packages/cli/schemas");

function io() {
  let out = "";
  let err = "";
  return {
    io: {
      stdout: { write: (s: string) => (out += s), isTTY: false },
      stderr: { write: (s: string) => (err += s), isTTY: false },
    },
    get out() {
      return out;
    },
    get err() {
      return err;
    },
  };
}

async function cli(cwd: string, ...argv: string[]) {
  const c = io();
  const code = await main(argv, c.io, cwd);
  return { code, out: c.out, err: c.err };
}

/** Minimal JSON-schema check: required keys (recursively for declared object properties) and consts. */
function check(schema: Record<string, unknown>, value: unknown, path = "$"): string[] {
  const issues: string[] = [];
  if ("const" in schema && value !== schema.const)
    issues.push(`${path}: expected ${String(schema.const)}`);
  if (schema.type === "object") {
    if (typeof value !== "object" || value === null) return [`${path}: expected object`];
    for (const k of (schema.required as string[] | undefined) ?? [])
      if (!(k in value)) issues.push(`${path}.${k}: missing`);
    for (const [k, sub] of Object.entries(
      (schema.properties as Record<string, Record<string, unknown>>) ?? {},
    )) {
      if (k in value)
        issues.push(...check(sub, (value as Record<string, unknown>)[k], `${path}.${k}`));
    }
  }
  if (schema.type === "array" && schema.items && Array.isArray(value)) {
    for (const [i, v] of value.entries())
      issues.push(...check(schema.items as Record<string, unknown>, v, `${path}[${i}]`));
  }
  return issues;
}
const schema = async (name: string) =>
  JSON.parse(await readFile(join(SCHEMAS, `${name}.v1.schema.json`), "utf8")) as Record<
    string,
    unknown
  >;

describe("smarttest CLI", () => {
  it("prints help and version, and rejects bad usage with exit 2 and a suggestion", async () => {
    const dir = await materialize("no-vcs-vitest");
    expect((await cli(dir, "--help")).out).toContain("Exit codes: 0 success");
    expect((await cli(dir, "--version")).out.trim()).toMatch(/^\d+\.\d+\.\d+/);
    const bad = await cli(dir, "run", "--afected");
    expect(bad.code).toBe(2);
    expect(bad.err).toContain("Did you mean --affected?");
    const unknown = await cli(dir, "rnu");
    expect(unknown.code).toBe(2);
    expect(unknown.err).toContain("smarttest run");
    const json = await cli(dir, "nope", "--json");
    expect(check(await schema("error"), JSON.parse(json.out))).toEqual([]);
  });

  it("explain --units matches one explain per unit, in one call", async () => {
    const dir = await materialize("nest-auth-vitest", { git: true });
    const file = "src/modules/catalog/CatalogService.ts";
    const units = ["CatalogService", "CatalogService.list", "CatalogService.total"];
    const batch = JSON.parse(
      (await cli(dir, "explain", file, "--units", units.join(","), "--json")).out,
    );
    expect(check(await schema("explain"), batch)).toEqual([]);
    expect(batch.units.map((u: { unit: string }) => u.unit)).toEqual(units);
    for (const [i, unit] of units.entries()) {
      const one = JSON.parse((await cli(dir, "explain", `${file}#${unit}`, "--json")).out);
      expect(batch.units[i].tests, unit).toEqual(one.tests);
    }
    expect(batch.units.some((u: { tests: unknown[] }) => u.tests.length > 0)).toBe(true);
    expect((await cli(dir, "explain", `${file}#CatalogService`, "--units", "x")).code).toBe(2);
  }, 120_000);

  it("emits schema-valid JSON for scan, impact, explain and run", async () => {
    const dir = await materialize("nest-auth-vitest", { git: true });
    await edit(dir, "src/modules/catalog/CatalogService.ts", "sum + p.price", "p.price + sum");
    for (const [cmd, args] of [
      ["scan", []],
      ["impact", []],
      ["explain", ["tests/unit/modules/catalog/CatalogService.test.ts"]],
      ["run", []],
    ] as const) {
      const r = await cli(dir, cmd, ...args, "--json");
      const doc = JSON.parse(r.out);
      expect(check(await schema(cmd), doc), cmd).toEqual([]);
      if (cmd === "run") expect(r.code).toBe(0);
    }
  }, 120_000);

  it("init: needs --yes when non-interactive, is idempotent, and rolls back byte-for-byte", async () => {
    const dir = await materialize("nest-auth-vitest", { git: true });
    const before = await readFile(join(dir, "package.json"), "utf8");
    const gitignoreBefore = await readFile(join(dir, ".gitignore"), "utf8");
    const refused = await cli(dir, "init", "--non-interactive");
    expect(refused.code).toBe(3);
    expect((await cli(dir, "init", "--dry-run")).out).toContain("Dry run — nothing was written.");
    expect(await readdir(dir)).not.toContain("smarttest.config.ts");
    expect((await cli(dir, "init", "--yes")).code).toBe(0);
    const config = await readFile(join(dir, "smarttest.config.ts"), "utf8");
    expect(config).toContain('import { defineConfig } from "smarttest"');
    expect((await cli(dir, "init", "--yes")).out).toContain("nothing to change");
    expect(await readFile(join(dir, "smarttest.config.ts"), "utf8")).toBe(config);
    expect((await cli(dir, "doctor")).code).toBe(0);
    expect((await cli(dir, "init", "--rollback")).code).toBe(0);
    expect(await readFile(join(dir, "package.json"), "utf8")).toBe(before);
    expect(await readFile(join(dir, ".gitignore"), "utf8")).toBe(gitignoreBefore);
    expect(await readdir(dir)).not.toContain("smarttest.config.ts");
  }, 120_000);

  it("rollback never overwrites files edited after init", async () => {
    const dir = await materialize("nest-auth-vitest", { git: true });
    await cli(dir, "init", "--yes");
    await edit(dir, "smarttest.config.ts", 'mode: "balanced"', 'mode: "safe"');
    const r = await cli(dir, "init", "--rollback");
    expect(r.code).toBe(5);
    expect(r.out).toContain("edited since init");
    expect(await readFile(join(dir, "smarttest.config.ts"), "utf8")).toContain('mode: "safe"');
  }, 120_000);

  it("generate: dry-run writes nothing, generation is repeatable and never overwrites", async () => {
    const dir = await materialize("nest-auth-vitest", { git: true });
    const dry = await cli(dir, "generate", "--dry-run");
    expect(dry.out).toContain("would be created");
    expect(await readdir(join(dir, "tests/unit/modules/users"))).toEqual(["UserService.test.ts"]);
    const first = await cli(dir, "generate", "--json");
    const created = (JSON.parse(first.out).written as string[]).sort();
    expect(created).toEqual([
      "tests/unit/modules/auth/AuthenticationMiddleware.test.ts",
      "tests/unit/modules/users/UserRepository.test.ts",
    ]);
    const scaffold = await readFile(
      join(dir, "tests/unit/modules/users/UserRepository.test.ts"),
      "utf8",
    );
    expect(scaffold).toContain('it.todo("save');
    expect(scaffold).not.toMatch(/\bit\(/);
    const second = await cli(dir, "generate", "--json");
    expect(JSON.parse(second.out).written).toEqual([]);
    // the scaffolds run as todo, never as passing tests
    const run = await cli(dir, "run", "--all", "--json");
    const report = JSON.parse(run.out).report;
    const repo = report.executions.find(
      (e: { file: string }) => e.file === "tests/unit/modules/users/UserRepository.test.ts",
    );
    expect(repo.tests.every((t: { status: string }) => t.status === "pending")).toBe(true);
    expect(report.summary.passed).toBe(10);
  }, 180_000);

  it("uninstall keeps tests and removes SmartTest state", async () => {
    const dir = await materialize("nest-auth-vitest", { git: true });
    await cli(dir, "init", "--yes");
    await cli(dir, "generate");
    const r = await cli(dir, "uninstall", "--yes");
    expect(r.code).toBe(0);
    const files = await readdir(dir);
    expect(files).not.toContain("smarttest.config.ts");
    expect(files).not.toContain(".smarttest");
    expect(await readdir(join(dir, "tests/unit/modules/users"))).toContain(
      "UserRepository.test.ts",
    );
  }, 120_000);
});
