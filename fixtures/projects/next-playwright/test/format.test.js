import assert from "node:assert/strict";
import { test } from "node:test";
import { displayName } from "../lib/format.js";

test("display name", () => assert.equal(displayName({ first: "A", last: "B" }), "A B"));
