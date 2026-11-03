import { expect, it } from "vitest";
import { clamp } from "@lib/util/numbers";

it("clamps", () => expect(clamp(12, 0, 10)).toBe(10));
