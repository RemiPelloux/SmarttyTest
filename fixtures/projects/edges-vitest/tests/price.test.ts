import { expect, it } from "vitest";
import { makeShop } from "../src/shop";

it("prices items", () => {
  expect(makeShop().price(3)).toBe(30);
});
