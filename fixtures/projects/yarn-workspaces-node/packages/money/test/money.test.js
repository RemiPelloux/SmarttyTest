import assert from "node:assert/strict";
import { test } from "node:test";
import { add, format } from "../src/index.js";

test("adds", () => assert.equal(add(0.1, 0.2), 0.3));
test("formats", () => assert.equal(format(2), "2.00 EUR"));
