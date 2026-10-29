import { expect, it } from "vitest";
import { goodbye } from "../src/templates";

it("renders the goodbye template", () => {
  expect(goodbye("Ada")).toBe("Goodbye, Ada.");
});
