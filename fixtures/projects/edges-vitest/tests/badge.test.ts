import { expect, it } from "vitest";
import { badge } from "../src/client/cart";

it("counts items", () => {
  expect(badge([1, 2])).toBe("2");
});
