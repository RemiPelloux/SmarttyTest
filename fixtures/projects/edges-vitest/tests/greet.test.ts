import { expect, it } from "vitest";
import { greet } from "../src/greet";

it("greets", () => {
  expect(greet("Ada")).toBe("Hello, Ada");
});
