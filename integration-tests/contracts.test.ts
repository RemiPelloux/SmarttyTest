/**
 * Public contracts frozen at 1.0.0 (documentation/reference/contracts.md): every `--json`
 * document of a frozen command validates against its published schema, every command that prints
 * JSON is either frozen or explicitly experimental, and the exit codes are what the docs say.
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  assertSupportedSchema,
  ExitCode,
  type JsonSchema,
  validateJsonSchema,
} from "@smarttest/shared";
import { main } from "smarttest";
import { describe, expect, it } from "vitest";
import { edit, materialize } from "./helpers.js";

const ROOT = resolve(import.meta.dirname, "..");
const SCHEMAS = join(ROOT, "packages/cli/schemas");

/** Commands whose `--json` document is frozen at 1.0.0 (one `<command>.v1.schema.json` each). */
const FROZEN = [
  "run",
  "impact",
  "scan",
  "explain",
  "ci",
  "doctor",
  "shard",
  "flaky",
  "validate-selection",
  "hook",
  "sync",
];
/** Commands that print JSON whose shape may still change in a minor release. */
const EXPERIMENTAL = [
  "trace",
  "shadow",
  "migrate",
  "init",
  "uninstall",
  "generate",
  "rules",
  "snapshot",
  "vcs",
  "benchmark",
  "graph",
  "coverage",
  "report",
  "studio",
];

async function cli(cwd: string, ...argv: string[]) {
  let out = "";
  let err = "";
  const io = {
    stdout: {
      write: (s: string) => {
        out += s;
        return true;
      },
      isTTY: false,
    },
    stderr: {
      write: (s: string) => {
        err += s;
        return true;
      },
      isTTY: false,
    },
  };
  const code = await main(argv, io as never, cwd);
  return { code, out, err };
}

const schema = async (name: string) =>
  JSON.parse(await readFile(join(SCHEMAS, `${name}.v1.schema.json`), "utf8")) as JsonSchema;

async function expectValid(name: string, out: string): Promise<Record<string, unknown>> {
  const doc = JSON.parse(out) as Record<string, unknown>;
  expect(validateJsonSchema(await schema(name), doc), name).toEqual([]);
  return doc;
}

describe("published schemas", () => {
  it("cover every command that prints JSON: frozen ones have a schema, the rest are listed as experimental", async () => {
    const source = await readFile(join(ROOT, "packages/cli/src/main.ts"), "utf8");
    const emitted = [
      ...new Set([...source.matchAll(/ctx\.json\(\s*"([\w-]+)"/g)].map((m) => m[1])),
    ];
    expect(emitted.length).toBeGreaterThan(10);
    for (const cmd of emitted)
      expect(FROZEN.includes(cmd as string) || EXPERIMENTAL.includes(cmd as string), cmd).toBe(
        true,
      );
    const files = (await readdir(SCHEMAS)).filter((f) => f.endsWith(".v1.schema.json")).sort();
    expect(files).toEqual([...FROZEN, "error", "config"].map((c) => `${c}.v1.schema.json`).sort());
    for (const f of files) {
      const s = JSON.parse(await readFile(join(SCHEMAS, f), "utf8")) as JsonSchema;
      expect(s.$schema, f).toBe("https://json-schema.org/draft/2020-12/schema");
      expect(s.$id, f).toBe(`https://remipelloux.github.io/SmarttyTest/schemas/${f}`);
      // Every keyword, in every subschema, is one the validator implements.
      expect(() => assertSupportedSchema(s), f).not.toThrow();
    }
  });

  it("error documents carry a category that maps to the documented exit code", async () => {
    const error = await schema("error");
    const errorProps = (error.properties as Record<string, JsonSchema>).error?.properties as Record<
      string,
      JsonSchema
    >;
    const categories = errorProps.category?.enum;
    expect(categories).toEqual([
      "usage",
      "configuration",
      "infrastructure",
      "policy",
      "test-failure",
      "internal",
    ]);
  });
});

describe("frozen --json documents validate against their schema", () => {
  it("scan, impact, explain, run, ci, doctor, shard, flaky, hook and sync", async () => {
    const dir = await materialize("nest-auth-vitest", { git: true });
    await edit(dir, "src/modules/catalog/CatalogService.ts", "sum + p.price", "p.price + sum");
    const cases: [string, string[]][] = [
      ["scan", ["scan"]],
      ["impact", ["impact"]],
      ["explain", ["explain", "tests/unit/modules/catalog/CatalogService.test.ts"]],
      ["explain", ["explain", "src/modules/catalog/CatalogService.ts"]],
      ["run", ["run"]],
      ["ci", ["ci", "--dry-run"]],
      ["doctor", ["doctor"]],
      ["shard", ["shard", "--total", "2", "--index", "1"]],
      ["flaky", ["flaky"]],
      ["hook", ["hook", "status"]],
      ["hook", ["hook", "install", "--dry-run"]],
      ["sync", ["sync", "--check"]],
    ];
    for (const [name, args] of cases) {
      const r = await cli(dir, ...args, "--json");
      expect(r.code, args.join(" ")).toBe(0);
      const doc = await expectValid(name, r.out);
      expect(doc.command).toBe(name);
    }
    const flaky = await cli(dir, "flaky", "--min-rate", "0", "--json");
    await expectValid("flaky", flaky.out);
    const installed = await cli(dir, "hook", "install", "--yes", "--json");
    expect((await expectValid("hook", installed.out)).applied).toHaveLength(1);
    const removed = await cli(dir, "hook", "uninstall", "--yes", "--json");
    expect((await expectValid("hook", removed.out)).removed).toHaveLength(1);
  }, 180_000);

  it("validate-selection", async () => {
    const dir = await materialize("nest-auth-vitest", { git: true });
    await edit(dir, "src/modules/catalog/CatalogService.ts", "sum + p.price", "p.price + sum");
    const r = await cli(dir, "validate-selection", "--json");
    expect(r.code).toBe(0);
    await expectValid("validate-selection", r.out);
  }, 120_000);
});

describe("exit codes", () => {
  it("are the documented values", () => {
    expect(ExitCode).toEqual({
      Success: 0,
      TestFailure: 1,
      InvalidUsage: 2,
      ConfigurationFailure: 3,
      InfrastructureFailure: 4,
      PolicyFailure: 5,
      Internal: 70,
    });
  });

  it("are what the CLI returns for each category", async () => {
    const dir = await materialize("nest-auth-vitest", { git: true });
    const error = await schema("error");
    const failing = async (expected: number, category: string, ...argv: string[]) => {
      const r = await cli(dir, ...argv, "--json");
      expect(r.code, argv.join(" ")).toBe(expected);
      const doc = JSON.parse(r.out);
      expect(validateJsonSchema(error, doc), argv.join(" ")).toEqual([]);
      expect(doc.error.category, argv.join(" ")).toBe(category);
    };
    expect((await cli(dir, "--version")).code).toBe(ExitCode.Success);
    await failing(ExitCode.InvalidUsage, "usage", "run", "--afected");
    await failing(ExitCode.InfrastructureFailure, "infrastructure", "run", "--base", "no-such-ref");
    await failing(ExitCode.ConfigurationFailure, "configuration", "init", "--non-interactive");

    await edit(dir, "tests/unit/modules/catalog/CatalogService.test.ts", "toBe(42)", "toBe(43)");
    const failed = await cli(dir, "run", "--json");
    expect(failed.code).toBe(ExitCode.TestFailure);
    await expectValid("run", failed.out);

    await writeFile(join(dir, "smarttest.config.json"), JSON.stringify({ mode: "turbo" }));
    await failing(ExitCode.ConfigurationFailure, "configuration", "impact");
  }, 180_000);
});
