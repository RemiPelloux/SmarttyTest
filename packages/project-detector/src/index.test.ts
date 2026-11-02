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

describe("Angular detection", () => {
  it("runs each Angular project through ng test, not the Vitest the builder starts", async () => {
    const root = await mkdtemp(join(tmpdir(), "st-detect-angular-"));
    try {
      await writeFile(
        join(root, "package.json"),
        JSON.stringify({
          scripts: { test: "ng test" },
          dependencies: { "@angular/core": "^22.2.0" },
          devDependencies: { "@angular/build": "^22.2.5", vitest: "^5.0.0" },
        }),
      );
      await writeFile(
        join(root, "angular.json"),
        JSON.stringify({
          projects: {
            demo: { root: "", architect: { test: { builder: "@angular/build:unit-test" } } },
            lib: {
              root: "projects/lib",
              architect: { test: { builder: "@angular/build:unit-test" } },
            },
          },
        }),
      );
      const profile = await detectProject(root, { files: [] });
      expect(profile.runners.map((r) => [r.adapter, r.configFile, r.project])).toEqual([
        ["angular", "angular.json", "demo"],
        ["angular", "angular.json", "lib"],
      ]);
      expect(profile.frameworks.map((f) => f.value)).toContain("Angular");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
