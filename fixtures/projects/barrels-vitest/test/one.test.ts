import { createRequire } from "node:module";
import { expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { one } = require("../src/legacy/index.cjs");

it("returns one", () => expect(one()).toBe(1));
