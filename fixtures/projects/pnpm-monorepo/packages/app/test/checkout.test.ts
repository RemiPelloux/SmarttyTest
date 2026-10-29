import { expect, it } from "vitest";
import { checkoutTotal } from "../src/checkout";

it("sums gross prices", () => expect(checkoutTotal([10, 5])).toBe(18));
