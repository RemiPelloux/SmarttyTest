import { expect, it } from "vitest";
import { price } from "../src";

it("converts cents", () => expect(price(250)).toBe(2.5));
