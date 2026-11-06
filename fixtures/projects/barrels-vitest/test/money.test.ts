import { expect, it } from "vitest";
import { format } from "../src";

it("formats money", () => expect(format.money(2.5)).toBe("$2.50"));
