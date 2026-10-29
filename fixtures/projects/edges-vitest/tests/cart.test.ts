import { expect, it } from "vitest";
import { cartLabel } from "../src/client/cart";

it("labels the cart", () => {
  expect(cartLabel([{ price: 2 }, { price: 3 }])).toBe("5 EUR");
});
