/**
 * A small JSON Schema (draft 2020-12) validator for the subset SmartTest's published schemas use:
 * `type` (including `integer` and type arrays), `enum`, `const`, `properties`, `required`,
 * `additionalProperties`, `items`, `anyOf`, `oneOf`, `minimum`, `exclusiveMinimum`, `maximum`,
 * `minLength`, `minItems` and local `$ref`s (`#/$defs/name`). Annotations (`title`,
 * `description`, `$id`…) are ignored. Unsupported keywords throw, so a schema can never rely on a
 * check that silently does nothing.
 */

export type JsonSchema = { [keyword: string]: unknown };

export interface JsonSchemaIssue {
  /** JSON path of the offending value, e.g. `$.rules[0].risk`. */
  path: string;
  message: string;
}

const ANNOTATIONS = new Set([
  "$schema",
  "$id",
  "$defs",
  "$comment",
  "title",
  "description",
  "default",
  "examples",
  "deprecated",
  "markdownDescription",
]);
const KEYWORDS = new Set([
  "type",
  "enum",
  "const",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "anyOf",
  "oneOf",
  "minimum",
  "exclusiveMinimum",
  "maximum",
  "minLength",
  "minItems",
  "$ref",
]);

const typeOf = (v: unknown): string =>
  v === null
    ? "null"
    : Array.isArray(v)
      ? "array"
      : typeof v === "number" && Number.isInteger(v)
        ? "integer"
        : typeof v;

const matchesType = (v: unknown, type: string): boolean => {
  const actual = typeOf(v);
  return actual === type || (type === "number" && actual === "integer");
};

/**
 * Throws when any subschema uses a keyword this validator does not implement, or a `$ref` that
 * does not resolve: a published schema must never rely on a check that silently does nothing.
 */
export function assertSupportedSchema(
  schema: JsonSchema,
  root: JsonSchema = schema,
  at = "#",
): void {
  for (const k of Object.keys(schema))
    if (!KEYWORDS.has(k) && !ANNOTATIONS.has(k))
      throw new Error(`json-schema: unsupported keyword "${k}" at ${at}`);
  if (typeof schema.$ref === "string") {
    const name = /^#\/\$defs\/(.+)$/.exec(schema.$ref)?.[1];
    if (!name || !(root.$defs as Record<string, unknown> | undefined)?.[name])
      throw new Error(`json-schema: unresolvable $ref "${schema.$ref}" at ${at}`);
  }
  const sub = (s: unknown, p: string) => {
    if (s && typeof s === "object" && !Array.isArray(s))
      assertSupportedSchema(s as JsonSchema, root, p);
  };
  for (const [k, s] of Object.entries((schema.properties as object | undefined) ?? {}))
    sub(s, `${at}/properties/${k}`);
  for (const [k, s] of Object.entries((schema.$defs as object | undefined) ?? {}))
    sub(s, `${at}/$defs/${k}`);
  sub(schema.items, `${at}/items`);
  sub(schema.additionalProperties, `${at}/additionalProperties`);
  for (const kw of ["anyOf", "oneOf"])
    for (const [i, s] of ((schema[kw] as unknown[] | undefined) ?? []).entries())
      sub(s, `${at}/${kw}/${i}`);
}

/** Validates `value` against `schema`; returns every issue found (empty when valid). */
export function validateJsonSchema(
  schema: JsonSchema,
  value: unknown,
  root: JsonSchema = schema,
  path = "$",
): JsonSchemaIssue[] {
  const issues: JsonSchemaIssue[] = [];
  const fail = (message: string) => issues.push({ path, message });
  for (const k of Object.keys(schema))
    if (!KEYWORDS.has(k) && !ANNOTATIONS.has(k))
      throw new Error(`json-schema: unsupported keyword "${k}" at ${path}`);

  if (typeof schema.$ref === "string") {
    const m = /^#\/\$defs\/(.+)$/.exec(schema.$ref);
    const target = m
      ? (root.$defs as Record<string, JsonSchema> | undefined)?.[m[1] as string]
      : undefined;
    if (!target) throw new Error(`json-schema: unresolvable $ref "${schema.$ref}" at ${path}`);
    issues.push(...validateJsonSchema(target, value, root, path));
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string];
    if (!types.some((t) => matchesType(value, t))) {
      fail(`expected ${types.join(" | ")}, got ${typeOf(value)}`);
      return issues;
    }
  }
  if ("const" in schema && JSON.stringify(value) !== JSON.stringify(schema.const))
    fail(`expected ${JSON.stringify(schema.const)}`);
  if (
    Array.isArray(schema.enum) &&
    !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))
  )
    fail(`expected one of ${schema.enum.map((e) => JSON.stringify(e)).join(", ")}`);
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum)
      fail(`must be >= ${schema.minimum}`);
    if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum)
      fail(`must be > ${schema.exclusiveMinimum}`);
    if (typeof schema.maximum === "number" && value > schema.maximum)
      fail(`must be <= ${schema.maximum}`);
  }
  if (typeof value === "string" && typeof schema.minLength === "number")
    if (value.length < schema.minLength)
      fail(`must have at least ${schema.minLength} character(s)`);
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems)
      fail(`must have at least ${schema.minItems} item(s)`);
    if (schema.items && typeof schema.items === "object")
      for (const [i, v] of value.entries())
        issues.push(...validateJsonSchema(schema.items as JsonSchema, v, root, `${path}[${i}]`));
  }
  if (typeOf(value) === "object") {
    const obj = value as Record<string, unknown>;
    for (const k of (schema.required as string[] | undefined) ?? [])
      if (!(k in obj)) issues.push({ path: `${path}.${k}`, message: "is required" });
    const props = (schema.properties as Record<string, JsonSchema> | undefined) ?? {};
    for (const [k, v] of Object.entries(obj)) {
      const sub = props[k];
      if (sub) issues.push(...validateJsonSchema(sub, v, root, `${path}.${k}`));
      else if (schema.additionalProperties === false)
        issues.push({ path: `${path}.${k}`, message: "is not allowed" });
      else if (schema.additionalProperties && typeof schema.additionalProperties === "object")
        issues.push(
          ...validateJsonSchema(schema.additionalProperties as JsonSchema, v, root, `${path}.${k}`),
        );
    }
  }
  for (const kw of ["anyOf", "oneOf"] as const) {
    const options = schema[kw] as JsonSchema[] | undefined;
    if (!options) continue;
    const results = options.map((o) => validateJsonSchema(o, value, root, path));
    const passing = results.filter((r) => !r.length).length;
    if (kw === "anyOf" && !passing) {
      const best = results.reduce((a, b) => (b.length < a.length ? b : a));
      issues.push(...best);
    }
    if (kw === "oneOf" && passing !== 1)
      fail(
        passing
          ? `matches ${passing} alternatives, expected exactly one`
          : `matches none of ${options.length} alternatives`,
      );
  }
  return issues;
}
