import { describe, expect, it } from "vitest";
import { protectedRoute } from "../../src/routes/protected";

describe("protected routes", () => {
  it("rejects anonymous requests", () => {
    expect(protectedRoute({}).status).toBe(401);
  });
  it("accepts a valid bearer token", () => {
    expect(protectedRoute({ authorization: "Bearer tok_ada_3" }).status).toBe(200);
  });
});
