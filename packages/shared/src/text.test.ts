import { describe, expect, it } from "vitest";
import { matchGlob } from "./glob.js";
import { redact } from "./logger.js";
import { changedLineRange, suggest } from "./text.js";

describe("glob", () => {
  it.each([
    ["src/a/b.ts", "src/**", true],
    ["src/a/b.ts", "src/**/*.ts", true],
    ["src/b.ts", "src/**/*.ts", true],
    ["src/b.tsx", "src/**/*.{ts,tsx}", true],
    ["lib/b.ts", "src/**", false],
    ["src/modules/auth/AuthService.ts", "src/modules/auth/**", true],
    ["tsconfig.base.json", "**/tsconfig*.json", true],
    ["pkg/tsconfig.json", "**/tsconfig*.json", true],
  ])("%s ~ %s → %s", (path, pattern, expected) => {
    expect(matchGlob(path, pattern)).toBe(expected);
  });
});

describe("redact", () => {
  it("removes tokens and key=value secrets", () => {
    const out = redact("token=abcdef123456 and ghp_aaaaaaaaaaaaaaaaaaaaaaaa");
    expect(out).not.toContain("abcdef123456");
    expect(out).not.toContain("ghp_aaaa");
  });
});

describe("text helpers", () => {
  it("suggests close commands", () => {
    expect(suggest("rnu", ["run", "init", "scan"])).toBe("run");
    expect(suggest("zzzzzz", ["run", "init"])).toBeUndefined();
  });
  it("computes a conservative changed range", () => {
    expect(changedLineRange("a\nb\nc", "a\nX\nc")).toEqual({ start: 1, end: 1 });
    expect(changedLineRange("a", "a")).toBeUndefined();
  });
});
