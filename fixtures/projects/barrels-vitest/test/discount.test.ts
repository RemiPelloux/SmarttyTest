import { expect, it } from "vitest";
import { discount } from "../src";

it("discounts", () => expect(discount(200, 25)).toBe(150));
