import { test } from "node:test";
import assert from "node:assert/strict";
import { total } from "../src/cart.js";

test("totals the cart", () => assert.equal(total([{ price: 1.005, qty: 2 }, { price: 2, qty: 1 }]), 4.01));
