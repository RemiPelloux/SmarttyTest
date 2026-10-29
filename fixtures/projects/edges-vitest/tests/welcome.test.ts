import { expect, it } from "vitest";
import { welcome } from "../src/templates";

it("renders the welcome template", () => {
  expect(welcome("Ada")).toBe("Welcome, Ada!");
});
