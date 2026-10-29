import { expect, it } from "vitest";
import { isEmail } from "../../../../src/shared/validators/EmailValidator";

it("validates emails", () => {
  expect(isEmail("ada@example.com")).toBe(true);
  expect(isEmail("ada")).toBe(false);
});
