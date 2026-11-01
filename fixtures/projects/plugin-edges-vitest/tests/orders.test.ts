import { expect, it } from "vitest";
import { listOrdersQuery, orderCount } from "../src/orders.js";

it("lists the newest orders first", () => {
  expect(listOrdersQuery()).toBe("SELECT * FROM orders ORDER BY created_at DESC");
});

it("counts orders", () => {
  expect(orderCount([1, 2])).toBe(2);
});
