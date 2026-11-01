import { expect, it } from "vitest";
import { query } from "../src/db.js";

it("throws for a query that does not exist", () => {
  expect(() => query("no-such-query")).toThrow();
});
