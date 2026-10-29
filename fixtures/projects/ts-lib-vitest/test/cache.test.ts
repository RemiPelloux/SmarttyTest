import { expect, it } from "vitest";
import { Cache } from "@lib/core/Cache";

it("stores values", () => expect(new Cache<number>().set("a", 1).size()).toBe(1));
