import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectProject } from "./index.js";

describe("node --test detection", () => {
  it("reads the file arguments wherever the node options sit", async () => {
    const root = await mkdtemp(join(tmpdir(), "st-detect-node-"));
    try {
      await writeFile(
        join(root, "package.json"),
        JSON.stringify({
          scripts: { test: "node --test --import tsx --test-reporter spec 'test/**/*.test.ts'" },
        }),
      );
      const profile = await detectProject(root, { files: [] });
      expect(profile.runners.find((r) => r.adapter === "node")?.patterns).toEqual([
        "test/**/*.test.ts",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
