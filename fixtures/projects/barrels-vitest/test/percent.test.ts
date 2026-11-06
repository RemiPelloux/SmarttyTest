import { expect, it } from "vitest";
import { format } from "../src";

it("formats a percentage", () => expect(format.percent(25)).toBe("25%"));
