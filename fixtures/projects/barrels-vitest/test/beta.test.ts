import { expect, it } from "vitest";
import { beta } from "../src/plugins";

it("runs beta", () => expect(beta()).toBe("beta"));
