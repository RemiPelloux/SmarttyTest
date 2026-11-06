import { expect, it } from "vitest";
import { greet } from "../src";

it("greets", () => expect(greet("Ada")).toBe("Hello, Ada"));
