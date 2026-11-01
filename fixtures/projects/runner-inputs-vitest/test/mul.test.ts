import { expect, it } from "vitest";
import { mul } from "../src/math";

it("multiplies", () => expect(mul(2, 3)).toBe(6));
