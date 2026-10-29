import { expect, it } from "vitest";
import { formatEuro } from "../src/format";

it("formats euros", () => expect(formatEuro(3)).toBe("€3.00"));
