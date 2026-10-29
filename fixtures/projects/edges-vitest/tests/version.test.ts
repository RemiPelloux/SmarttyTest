import { expect, it } from "vitest";
import { SCHEMA_VERSION } from "../src/generated/version";

it("has a schema version", () => {
  expect(SCHEMA_VERSION).toBe(1);
});
