import { expect, it } from "vitest";
import { render } from "../src/app/core";
import { PriceComponent } from "../src/app/price.component";

it("formats the price", () => {
  expect(render(PriceComponent).html).toBe("<b>12.50 EUR</b>");
});
