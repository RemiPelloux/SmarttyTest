import { createRequire } from "node:module";
import { expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { two } = require("../src/legacy/index.cjs");

it("returns two", () => expect(two()).toBe(2));
