import { describe, expect, it } from "vitest";
import { walkFiles } from "./glob.js";

describe("walkFiles: ignored folders in a Git listing", () => {
  const gitFiles = [
    "package.json",
    "src/a.ts",
    "src/tests/build/a.test.ts",
    "dist/index.js",
    "node_modules/x/index.js",
    "src/node_modules/y.js",
    "packages/p/package.json",
    "packages/p/dist/index.js",
    "packages/p/src/build/b.ts",
    "packages/q/dist/c.ts",
    "out",
  ];

  it("skips dependency folders anywhere, and build output only at a package root", async () => {
    expect(await walkFiles("/nowhere", { gitFiles })).toEqual(
      [
        "package.json",
        "src/a.ts",
        "src/tests/build/a.test.ts",
        "packages/p/package.json",
        "packages/p/src/build/b.ts",
        "packages/q/dist/c.ts",
        "out",
      ].sort(),
    );
  });

  it("applies a custom set of folders everywhere", async () => {
    expect(
      await walkFiles("/nowhere", { gitFiles, ignoredDirs: new Set(["build", "src"]) }),
    ).toEqual(
      [
        "package.json",
        "dist/index.js",
        "node_modules/x/index.js",
        "packages/p/package.json",
        "packages/p/dist/index.js",
        "packages/q/dist/c.ts",
        "out",
      ].sort(),
    );
  });
});
