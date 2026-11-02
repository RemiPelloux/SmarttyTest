import { describe, expect, it } from "vitest";
import { jestPathPattern } from "./index.js";

describe("jestPathPattern", () => {
  it("matches exactly one file, whatever characters its path holds", () => {
    const file = "/work/my.app (v2)/src/app/[id]/page+1.spec.ts";
    const re = new RegExp(jestPathPattern(file));
    expect(re.test(file)).toBe(true);
    expect(re.test(`${file}x`)).toBe(false);
    expect(re.test("/work/my.app (v2)/src/app/[id]/page+1Xspec.ts")).toBe(false);
  });
});
