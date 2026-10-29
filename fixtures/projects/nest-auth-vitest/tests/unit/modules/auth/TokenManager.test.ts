import { describe, expect, it } from "vitest";
import { TokenManager } from "../../../../src/modules/auth/TokenManager";

describe("TokenManager", () => {
  it("issues verifiable tokens", () => {
    const tm = new TokenManager();
    expect(tm.verify(tm.issue("ada"))).toBe(true);
  });
  it("rejects garbage", () => {
    expect(new TokenManager().verify("nope")).toBe(false);
  });
});
