import { expect, it } from "vitest";
import { theme } from "../src/theme";

it("follows the dark-mode flag", () => expect(theme()).toBe("dark"));
