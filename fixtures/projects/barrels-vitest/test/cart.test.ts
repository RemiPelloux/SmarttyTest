import { expect, it } from "vitest";
import { cartTotal } from "../src";

it("adds the cart up", () => expect(cartTotal([1, 2, 3])).toBe(6));
