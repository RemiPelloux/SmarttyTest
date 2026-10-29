import { expect, it } from "vitest";
import { AuthController } from "../../../../src/modules/auth/AuthController";

it("returns a token on login", () => {
  expect(new AuthController().handleLogin({ email: "ada@example.com" }).token).toMatch(/^tok_/);
});
