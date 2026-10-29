import { expect, it } from "vitest";
import { banner } from "../src/banner";

it("renders the banner", () => expect(banner(3)).toBe("Only €3.00 today"));
