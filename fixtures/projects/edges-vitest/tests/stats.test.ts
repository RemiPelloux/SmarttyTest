import { expect, it } from "vitest";
import { mean } from "../src/stats";

it("computes the mean", () => {
  expect(mean([1, 2, 3])).toBe(2);
});
