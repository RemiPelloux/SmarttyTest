import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defineConfig, loadConfig, validateConfig } from "./index.js";

describe("defineConfig", () => {
  it("returns the configuration unchanged", () => {
    const config = defineConfig({
      mode: "balanced",
      rules: [{ name: "auth", match: { path: "src/auth/**" }, risk: "critical" }],
    });
    expect(config.mode).toBe("balanced");
  });
});

describe("validateConfig", () => {
  it("reports every invalid path and warns on unknown keys", () => {
    const { errors, warnings } = validateConfig({
      mode: "turbo",
      rules: [{ name: "x", match: { klass: "A" } }],
      foo: 1,
    });
    expect(errors.map((e) => e.path)).toEqual(["mode", "rules[0].match.klass"]);
    expect(warnings.map((w) => w.path)).toEqual(["foo"]);
  });
});

describe("loadConfig", () => {
  it("loads a TypeScript config that imports defineConfig from smarttest", async () => {
    const root = await mkdtemp(join(tmpdir(), "st-config-"));
    await writeFile(
      join(root, "smarttest.config.ts"),
      'import { defineConfig } from "smarttest";\nconst mode: "safe" = "safe";\nexport default defineConfig({ mode, retries: 1 });\n',
    );
    const loaded = await loadConfig(root);
    expect(loaded.config.mode).toBe("safe");
    expect(loaded.config.retries).toBe(1);
  });

  it("fails with ST_CONFIG_INVALID on bad values", async () => {
    const root = await mkdtemp(join(tmpdir(), "st-config-"));
    await writeFile(join(root, "smarttest.config.json"), JSON.stringify({ retries: -1 }));
    await expect(loadConfig(root)).rejects.toMatchObject({
      code: "ST_CONFIG_INVALID",
      exitCode: 3,
    });
  });
});
