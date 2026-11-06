import { expect, it } from "vitest";
import { alpha } from "../src/plugins";

it("runs alpha", () => expect(alpha()).toBe("alpha"));
