import { expect, it } from "vitest";
import { countOrders } from "../src/users";

it("counts orders", async () => {
  expect(await countOrders({ user: { count: async () => 0 }, order: { count: async () => 7 } })).toBe(7);
});
