import { describe, expect, it } from "vitest";
import { widenedBy } from "./smarttest.js";

describe("widenedBy", () => {
  it("names the triggers and fallbacks that selected tests, largest first", () => {
    const lock = { kind: "mandatory-trigger", message: "yarn.lock changed: vitest changed" };
    const env = { kind: "fallback", message: ".env: API_URL not read by analysed code" };
    const direct = { kind: "direct-dependency", message: "Directly depends on src/a.ts" };
    expect(
      widenedBy([
        { reasons: [lock, direct] },
        { reasons: [lock, env] },
        { reasons: [lock, lock] },
        { reasons: [direct] },
      ]),
    ).toEqual([
      { reason: lock.message, tests: 3 },
      { reason: env.message, tests: 1 },
    ]);
  });
});
