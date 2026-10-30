import { describe, expect, it } from "vitest";
import {
  fromProjectPath,
  isInside,
  sameProjectPath,
  toPosix,
  toProjectPath,
} from "../src/core/paths.js";

describe("project paths", () => {
  it("maps absolute files to project-relative POSIX paths", () => {
    expect(toProjectPath("/repo", "/repo/src/a.ts")).toBe("src/a.ts");
    expect(toProjectPath("/repo/", "/repo/a.ts")).toBe("a.ts");
    expect(toProjectPath("/repo", "/repo/src\\a.ts")).toBe("src\\a.ts".replace("\\", "/"));
  });

  it("refuses to claim files outside the workspace folder", () => {
    expect(toProjectPath("/repo", "/elsewhere/a.ts")).toBeUndefined();
    expect(toProjectPath("/repo", "/repo")).toBe(".");
    expect(toProjectPath("/repo", "/repo/../secret.ts")).toBeUndefined();
    expect(isInside("/repo", "/repo/src/a.ts")).toBe(true);
    expect(isInside("/repo", "/other/a.ts")).toBe(false);
  });

  it("rejects traversal when resolving back to disk", () => {
    expect(fromProjectPath("/repo", "src/a.ts")).toBe("/repo/src/a.ts");
    expect(fromProjectPath("/repo", "../a.ts")).toBeUndefined();
    expect(fromProjectPath("/repo", "src/../../a.ts")).toBeUndefined();
  });

  it("compares case-insensitively only on Windows", () => {
    expect(sameProjectPath("src/A.ts", "src/a.ts", "linux")).toBe(false);
    expect(sameProjectPath("src/A.ts", "src/a.ts", "win32")).toBe(true);
    expect(sameProjectPath("./src/a.ts", "src/a.ts", "linux")).toBe(true);
  });

  it("normalises separators", () => {
    expect(toPosix("src\\core\\a.ts")).toBe("src/core/a.ts");
  });
});
