import { expect, it } from "vitest";
import { UserService } from "../../../../src/modules/users/UserService";

it("registers users", () => {
  expect(new UserService().register("1", "ada@example.com")).toEqual({ email: "ada@example.com" });
});
