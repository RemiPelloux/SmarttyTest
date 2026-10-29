import { expect, it } from "vitest";
import { add, multiply } from "../src/math";

it("adds", () => expect(add(2, 3)).toBe(5));
it("multiplies", () => expect(multiply(2, 3)).toBe(6));
