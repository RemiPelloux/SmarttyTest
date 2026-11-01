import { describe, expect, it } from "vitest";
import { escapeRe } from "./index.js";

describe("spec filters (SR-05)", () => {
  it("never passes a spec file named like an option as an option", () => {
    const filter = escapeRe("--config=evil.spec.ts");
    expect(filter.startsWith("-")).toBe(false);
    expect(new RegExp(filter).test("/repo/--config=evil.spec.ts")).toBe(true);
    expect(new RegExp(filter).test("/repo/--configXevil.spec.ts")).toBe(false);
    expect(escapeRe("e2e/a.spec.ts")).toBe("e2e/a\\.spec\\.ts");
  });
});
