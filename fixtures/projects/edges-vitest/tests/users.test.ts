import { expect, it } from "vitest";
import { countUsers } from "../src/users";

it("counts users", async () => {
  expect(await countUsers({ user: { count: async () => 3 }, order: { count: async () => 0 } })).toBe(3);
});
