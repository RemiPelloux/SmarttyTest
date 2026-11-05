import { expect, it } from "vitest";
import { count } from "../src";

it("counts items", () => expect(count([1, 2, 3])).toBe(3));
