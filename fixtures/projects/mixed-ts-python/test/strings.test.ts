import { expect, it } from "vitest";
import { capitalize, kebab } from "../src";

it("capitalizes", () => expect(capitalize("ada")).toBe("Ada"));
it("kebab-cases", () => expect(kebab("helloWorld")).toBe("hello-world"));
