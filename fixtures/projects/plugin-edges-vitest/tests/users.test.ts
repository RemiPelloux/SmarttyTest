import { expect, it } from "vitest";
import { findUserQuery } from "../src/users.js";

it("finds a user by id", () => {
  expect(findUserQuery()).toBe("SELECT * FROM users WHERE id = ?");
});
