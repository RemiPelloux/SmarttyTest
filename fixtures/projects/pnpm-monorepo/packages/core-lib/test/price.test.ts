import { expect, it } from "vitest";
import { priceWithTax } from "../src/price";

it("adds VAT", () => expect(priceWithTax(10)).toBe(12));
