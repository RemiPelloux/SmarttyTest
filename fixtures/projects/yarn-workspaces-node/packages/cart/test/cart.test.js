import assert from "node:assert/strict";
import { test } from "node:test";
import { total } from "../src/index.js";

test("totals", () => assert.equal(total([{ price: 1.1 }, { price: 2.2 }]), 3.3));
