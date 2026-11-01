/**
 * The published config schema (packages/cli/schemas/config.v1.schema.json) is a frozen 1.0
 * contract. These tests make it impossible for the schema, the TypeScript types and the runtime
 * validator to drift apart:
 *   1. the schema's shape (keys, optionality, enums, primitive types) equals `SmartTestConfig`;
 *   2. a config using every option is valid for both the schema and `validateConfig`;
 *   3. every invalid variant the schema rejects is rejected by `validateConfig` too.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type JsonSchema, validateJsonSchema } from "@smarttest/shared";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import type { Rule } from "./types.js";
import { validateConfig } from "./validate.js";

const SCHEMA_PATH = join(import.meta.dirname, "../../cli/schemas/config.v1.schema.json");
const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8")) as JsonSchema;

type Shape =
  | string
  | { enum: string[] }
  | { array: Shape }
  | { record: Shape }
  | { anyOf: Shape[] }
  | { object: Record<string, { optional: boolean; shape: Shape }> };

const sortShapes = (shapes: Shape[]): Shape[] =>
  [...shapes].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

/** Merges alternatives: string literals become one enum, a single alternative stands alone. */
function union(shapes: Shape[]): Shape {
  const literals: string[] = [];
  const rest: Shape[] = [];
  for (const s of shapes) {
    if (typeof s === "object" && "enum" in s) literals.push(...s.enum);
    else if (!rest.some((r) => JSON.stringify(r) === JSON.stringify(s))) rest.push(s);
  }
  const all = [...rest, ...(literals.length ? [{ enum: [...new Set(literals)].sort() }] : [])];
  return all.length === 1 ? (all[0] as Shape) : { anyOf: sortShapes(all) };
}

// ── shape of the TypeScript type ────────────────────────────────────────────────────────────

function typeShape(checker: ts.TypeChecker, type: ts.Type, node: ts.Node): Shape {
  if (type.isUnion()) {
    const parts = type.types.filter((t) => !(t.flags & ts.TypeFlags.Undefined));
    if (parts.length && parts.every((t) => t.flags & ts.TypeFlags.BooleanLiteral)) return "boolean";
    if (parts.length === 1) return typeShape(checker, parts[0] as ts.Type, node);
    return union(parts.map((t) => typeShape(checker, t, node)));
  }
  if (type.isStringLiteral()) return { enum: [type.value] };
  if (type.flags & ts.TypeFlags.String) return "string";
  if (type.flags & ts.TypeFlags.Number) return "number";
  if (type.flags & (ts.TypeFlags.Boolean | ts.TypeFlags.BooleanLiteral)) return "boolean";
  if (checker.isArrayType(type)) {
    const [item] = checker.getTypeArguments(type as ts.TypeReference);
    return { array: typeShape(checker, item as ts.Type, node) };
  }
  const index = checker.getIndexInfoOfType(type, ts.IndexKind.String);
  const props = checker.getPropertiesOfType(type);
  if (index && !props.length) return { record: typeShape(checker, index.type, node) };
  const object: Record<string, { optional: boolean; shape: Shape }> = {};
  for (const p of props)
    object[p.name] = {
      optional: !!(p.flags & ts.SymbolFlags.Optional),
      shape: typeShape(checker, checker.getTypeOfSymbolAtLocation(p, node), node),
    };
  return { object };
}

function smartTestConfigShape(): Shape {
  const file = join(import.meta.dirname, "types.ts");
  const program = ts.createProgram([file], {
    strict: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    customConditions: ["@smarttest/source"],
  });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(file) as ts.SourceFile;
  const decl = source.statements.find(
    (s): s is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(s) && s.name.text === "SmartTestConfig",
  ) as ts.InterfaceDeclaration;
  return typeShape(checker, checker.getTypeAtLocation(decl), decl);
}

// ── shape of the JSON schema ────────────────────────────────────────────────────────────────

function deref(s: JsonSchema): JsonSchema {
  if (typeof s.$ref !== "string") return s;
  const name = s.$ref.replace("#/$defs/", "");
  return deref((schema.$defs as Record<string, JsonSchema>)[name] as JsonSchema);
}

function schemaShape(input: JsonSchema, top = false): Shape {
  const s = deref(input);
  if (Array.isArray(s.enum)) return { enum: [...(s.enum as string[])].sort() };
  if (typeof s.const === "string") return { enum: [s.const] };
  if (Array.isArray(s.anyOf)) return union((s.anyOf as JsonSchema[]).map((x) => schemaShape(x)));
  if (s.type === "string" || s.type === "boolean") return s.type;
  if (s.type === "integer" || s.type === "number") return "number";
  if (s.type === "array") return { array: schemaShape(s.items as JsonSchema) };
  if (s.type === "object" && s.properties) {
    const required = (s.required as string[] | undefined) ?? [];
    const object: Record<string, { optional: boolean; shape: Shape }> = {};
    for (const [k, v] of Object.entries(s.properties as Record<string, JsonSchema>)) {
      if (top && k === "$schema") continue; // editor hint, not a config option
      object[k] = { optional: !required.includes(k), shape: schemaShape(v) };
    }
    return { object };
  }
  if (s.type === "object" && typeof s.additionalProperties === "object")
    return { record: schemaShape(s.additionalProperties as JsonSchema) };
  throw new Error(`unsupported schema node ${JSON.stringify(s)}`);
}

// ── a configuration that uses every option ──────────────────────────────────────────────────

const rule: Rule = {
  name: "auth",
  match: {
    path: "src/auth/**",
    package: "api",
    class: "*Service",
    method: "login",
    function: "hash*",
    decorator: "Injectable",
    visibility: "public",
    kind: "method",
    extends: "Base",
    implements: "Guard",
  },
  require: ["unit", "integration"],
  coverage: { lines: 80, branches: 70 },
  risk: "critical",
  execution: { alwaysRunOnAffected: true, mode: "safe", retries: 1 },
  generate: { template: "service", path: "tests/{name}.test.ts" },
};

const KITCHEN_SINK = {
  $schema: "./node_modules/smarttest/schemas/config.v1.schema.json",
  include: ["src/**/*.ts"],
  exclude: ["src/legacy/**"],
  mode: "balanced",
  adapters: ["vitest"],
  vcs: { provider: "git", base: "origin/main", snapshots: true },
  snapshots: { storeContent: false, keep: 20 },
  tests: {
    layout: "mirror",
    directory: "tests",
    naming: "{name}.test.{ext}",
    match: ["tests/**/*.test.ts"],
    templates: ".smarttest/templates",
    discovery: "runner",
  },
  runners: [
    { adapter: "node", dir: "packages/a", config: "vitest.config.ts", patterns: ["**/*.test.js"] },
  ],
  generated: [{ path: "src/generated/**", policy: "rebuild-required", from: ["schema.graphql"] }],
  triggers: ["config/**"],
  rules: [rule],
  retries: 1,
  adaptive: true,
  projects: {
    backend: {
      tests: {
        layout: "custom",
        directory: "tests",
        naming: "{name}.spec.{ext}",
        path: "backend/src/__tests__/{FileName}.test.{Extension}",
        templates: "templates",
      },
      mode: "safe",
      rules: [{ ...rule, name: "backend-auth" }],
    },
  },
  cache: true,
  parallelGroups: 2,
  hook: {
    checks: [
      { name: "lint", run: "biome check {files}", projects: [""], files: "**/*.ts", stage: "both" },
    ],
    budgetMs: 30_000,
  },
  plugins: ["./tools/smarttest-plugin.mjs"],
  timeoutMs: 600_000,
  workers: 2,
  reports: { formats: ["html", "json", "junit", "markdown"], outputDir: ".smarttest/reports" },
  storeDir: ".smarttest",
};

// ── invalid variants derived from the schema ────────────────────────────────────────────────

type Path = (string | number)[];
interface Mutation {
  path: Path;
  /** Replacement value; `undefined` deletes the key. */
  value: unknown;
  why: string;
}

const NOPE = "__not-an-option__";

function mutations(input: JsonSchema, value: unknown, path: Path, out: Mutation[]): void {
  const s = deref(input);
  const at = (v: unknown, why: string) => out.push({ path, value: v, why });
  if (Array.isArray(s.enum) || typeof s.const === "string") {
    at(NOPE, "value outside the enum");
    return;
  }
  if (Array.isArray(s.anyOf)) {
    at(NOPE, "matches no alternative");
    at(true, "matches no alternative");
    for (const alt of s.anyOf as JsonSchema[]) {
      const a = deref(alt);
      if (a.type === "integer" && typeof a.minimum === "number")
        at(a.minimum - 1, `below the minimum ${a.minimum}`);
    }
    return;
  }
  switch (s.type) {
    case "string":
      at(42, "number instead of string");
      if (typeof s.minLength === "number") at("", "empty string");
      return;
    case "boolean":
      at("yes", "string instead of boolean");
      return;
    case "integer":
    case "number":
      at("1", "string instead of number");
      if (s.type === "integer") at(1.5, "fraction instead of integer");
      if (typeof s.minimum === "number") at(s.minimum - 1, `below the minimum ${s.minimum}`);
      if (typeof s.exclusiveMinimum === "number")
        at(s.exclusiveMinimum, `not above ${s.exclusiveMinimum}`);
      if (typeof s.maximum === "number") at(s.maximum + 1, `above the maximum ${s.maximum}`);
      return;
    case "array":
      at("not-an-array", "string instead of array");
      expect(
        Array.isArray(value) && value.length,
        `kitchen sink needs an item at ${path.join(".")}`,
      ).toBeTruthy();
      mutations(s.items as JsonSchema, (value as unknown[])[0], [...path, 0], out);
      return;
    case "object": {
      if (path.length) at("not-an-object", "string instead of object");
      const obj = value as Record<string, unknown>;
      if (s.properties) {
        for (const [k, sub] of Object.entries(s.properties as Record<string, JsonSchema>)) {
          if (k === "$schema") continue;
          expect(obj, `kitchen sink is missing ${[...path, k].join(".")}`).toHaveProperty([k]);
          mutations(sub, obj[k], [...path, k], out);
        }
        for (const k of (s.required as string[] | undefined) ?? [])
          out.push({ path: [...path, k], value: undefined, why: "required key missing" });
      } else if (typeof s.additionalProperties === "object") {
        const [k, v] = Object.entries(obj)[0] ?? [];
        expect(k, `kitchen sink needs an entry at ${path.join(".")}`).toBeDefined();
        mutations(s.additionalProperties as JsonSchema, v, [...path, k as string], out);
      }
      return;
    }
    default:
      throw new Error(`unsupported schema node at ${path.join(".")}`);
  }
}

function apply(base: unknown, m: Mutation): unknown {
  const copy = structuredClone(base) as Record<string | number, unknown>;
  let cur = copy;
  for (const seg of m.path.slice(0, -1)) cur = cur[seg] as Record<string | number, unknown>;
  const last = m.path[m.path.length - 1] as string | number;
  if (m.value === undefined) delete cur[last];
  else cur[last] = m.value;
  return copy;
}

describe("config.v1.schema.json", () => {
  it("has the same shape as the SmartTestConfig type", () => {
    expect(schemaShape(schema, true)).toEqual(smartTestConfigShape());
  });

  it("accepts a config that uses every option, like validateConfig", () => {
    expect(validateJsonSchema(schema, KITCHEN_SINK)).toEqual([]);
    expect(validateConfig(KITCHEN_SINK)).toEqual({ errors: [], warnings: [] });
  });

  it("rejects nothing validateConfig accepts and vice versa, for every invalid variant", () => {
    const list: Mutation[] = [];
    mutations(schema, KITCHEN_SINK, [], list);
    expect(list.length).toBeGreaterThan(100);
    const disagreements: string[] = [];
    for (const m of list) {
      const variant = apply(KITCHEN_SINK, m);
      const bySchema = validateJsonSchema(schema, variant).length > 0;
      const byValidator = validateConfig(variant).errors.length > 0;
      if (!bySchema || !byValidator)
        disagreements.push(
          `${m.path.join(".")} = ${JSON.stringify(m.value)} (${m.why}): schema ${bySchema ? "rejects" : "accepts"}, validateConfig ${byValidator ? "rejects" : "accepts"}`,
        );
    }
    expect(disagreements).toEqual([]);
  });

  it("warns on unknown keys that the schema forbids", () => {
    const { errors, warnings } = validateConfig({ ...KITCHEN_SINK, mdoe: "safe" });
    expect(errors).toEqual([]);
    expect(warnings.map((w) => w.path)).toEqual(["mdoe"]);
    expect(validateJsonSchema(schema, { mdoe: "safe" }).map((i) => i.path)).toEqual(["$.mdoe"]);
  });
});
