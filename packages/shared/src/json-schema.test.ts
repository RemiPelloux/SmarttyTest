import { describe, expect, it } from "vitest";
import { assertSupportedSchema, validateJsonSchema } from "./json-schema.js";

describe("validateJsonSchema", () => {
  const schema = {
    $defs: { mode: { enum: ["fast", "safe"] } },
    type: "object",
    required: ["n"],
    additionalProperties: false,
    properties: {
      n: { type: "integer", minimum: 0 },
      mode: { $ref: "#/$defs/mode" },
      tags: { type: "array", items: { type: "string", minLength: 1 } },
      workers: { anyOf: [{ type: "integer", minimum: 1 }, { const: "auto" }] },
      byDir: { type: "object", additionalProperties: { type: "boolean" } },
    },
  };

  it("accepts a valid document", () => {
    expect(
      validateJsonSchema(schema, {
        n: 0,
        mode: "safe",
        tags: ["a"],
        workers: "auto",
        byDir: { x: true },
      }),
    ).toEqual([]);
  });

  it("reports every invalid path", () => {
    const issues = validateJsonSchema(schema, {
      n: 1.5,
      mode: "turbo",
      tags: [""],
      workers: 0,
      byDir: { x: 1 },
      extra: 1,
    });
    expect(issues.map((i) => i.path).sort()).toEqual(
      ["$.byDir.x", "$.extra", "$.mode", "$.n", "$.tags[0]", "$.workers"].sort(),
    );
    expect(validateJsonSchema(schema, {}).map((i) => i.path)).toEqual(["$.n"]);
  });

  it("refuses keywords it does not implement, at any depth", () => {
    expect(() => validateJsonSchema({ pattern: "^a" }, "a")).toThrow(/unsupported keyword/);
    expect(() => assertSupportedSchema(schema)).not.toThrow();
    const nested = { type: "object", properties: { a: { items: { format: "uri" } } } };
    expect(() => assertSupportedSchema(nested)).toThrow(/"format" at #\/properties\/a\/items/);
    expect(() => assertSupportedSchema({ $ref: "#/$defs/missing" })).toThrow(/unresolvable/);
  });
});
