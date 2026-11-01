import { expect, it } from "vitest";
import { double } from "../src/jobs";

it("doubles in a child process", () => {
  expect(double(21)).toBe(42);
});
