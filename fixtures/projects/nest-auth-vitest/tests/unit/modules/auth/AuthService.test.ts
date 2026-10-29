import { describe, expect, it } from "vitest";
import { AuthService } from "../../../../src/modules/auth/AuthService";

describe("AuthService", () => {
  it("validates issued tokens", () => {
    const auth = new AuthService();
    expect(auth.validateToken(auth.login("ada@example.com"))).toBe(true);
  });
  it("rejects invalid emails", () => {
    expect(() => new AuthService().login("nope")).toThrow("invalid email");
  });
});
