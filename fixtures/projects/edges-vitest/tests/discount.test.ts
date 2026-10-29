import { expect, it } from "vitest";
import { makeShop } from "../src/shop";

it("discounts large orders", () => {
  expect(makeShop().discount(3)).toBe(5);
});
