import { mkdir, mkdtemp, readdir, symlink, writeFile } from "node:fs/promises";
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

  it("validates the hook scope", () => {
    expect(validateConfig({ hook: { runners: ["vitest"], exclude: ["e2e/**"] } }).errors).toEqual(
      [],
    );
    const { errors } = validateConfig({ hook: { runners: ["mocha"], exclude: "e2e/**" } });
    expect(errors.map((e) => e.path)).toEqual(["hook.runners", "hook.exclude"]);
    // An empty allow-list would run no test in the hook: refused rather than a silent no-op.
    expect(validateConfig({ hook: { runners: [] } }).errors.map((e) => e.path)).toEqual([
      "hook.runners",
    ]);
  });
});

describe("loadConfig", () => {
  it("loads a TypeScript config that imports defineConfig from smarttest", async () => {
    const root = await mkdtemp(join(tmpdir(), "st-config-"));
    await writeFile(
      join(root, "smarttest.config.ts"),
      'import { defineConfig } from "@tkmremi/smarttest";\nconst mode: "safe" = "safe";\nexport default defineConfig({ mode, retries: 1 });\n',
    );
    const loaded = await loadConfig(root);
    expect(loaded.config.mode).toBe("safe");
    expect(loaded.config.retries).toBe(1);
  });

  it("rejects an unknown hook runner as a SmartTestError with a hint", async () => {
    const root = await mkdtemp(join(tmpdir(), "st-config-"));
    await writeFile(
      join(root, "smarttest.config.json"),
      JSON.stringify({ hook: { runners: ["playwrite"] } }),
    );
    const error = await loadConfig(root).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "ST_CONFIG_INVALID", category: "configuration" });
    expect((error as Error).message).toContain("hook.runners");
    expect((error as { hint?: string }).hint).toBeTruthy();
  });

  it("resolves the hook scope; no scope means every runner", async () => {
    const root = await mkdtemp(join(tmpdir(), "st-config-"));
    expect((await loadConfig(root)).config.hook).toMatchObject({ exclude: [] });
    expect((await loadConfig(root)).config.hook.runners).toBeUndefined();
    await writeFile(
      join(root, "smarttest.config.json"),
      JSON.stringify({ hook: { runners: ["vitest"] } }),
    );
    expect((await loadConfig(root)).config.hook.runners).toEqual(["vitest"]);
  });

  it("fails with ST_CONFIG_INVALID on bad values", async () => {
    const root = await mkdtemp(join(tmpdir(), "st-config-"));
    await writeFile(join(root, "smarttest.config.json"), JSON.stringify({ retries: -1 }));
    await expect(loadConfig(root)).rejects.toMatchObject({
      code: "ST_CONFIG_INVALID",
      exitCode: 3,
    });
  });

  it("does not write the transpiled config through a committed .smarttest/tmp link (SR-01)", async () => {
    const base = await mkdtemp(join(tmpdir(), "st-cfg-link-"));
    const root = join(base, "repo");
    const outside = join(base, "outside");
    await mkdir(join(root, ".smarttest"), { recursive: true });
    await mkdir(outside);
    await symlink(outside, join(root, ".smarttest", "tmp"), "junction");
    await writeFile(join(root, "smarttest.config.ts"), 'export default { mode: "safe" };\n');
    await expect(loadConfig(root)).rejects.toMatchObject({ code: "ST_UNSAFE_PATH" });
    expect(await readdir(outside)).toEqual([]);
  });
});

describe("configured paths stay inside the project (SR-02)", () => {
  const paths = (raw: unknown) => validateConfig(raw).errors.map((e) => e.path);

  it("refuses absolute and ../ paths for the store, reports, runners and generated tests", () => {
    expect(paths({ storeDir: "../../home/u/.ssh" })).toEqual(["storeDir"]);
    expect(paths({ storeDir: "/tmp/x" })).toEqual(["storeDir"]);
    expect(paths({ storeDir: "." })).toEqual(["storeDir"]);
    expect(paths({ storeDir: "a/../.." })).toEqual(["storeDir"]);
    expect(paths({ reports: { outputDir: "C:\\Users\\u" } })).toEqual(["reports.outputDir"]);
    expect(paths({ reports: { outputDir: "../reports" } })).toEqual(["reports.outputDir"]);
    expect(paths({ reports: { outputDir: 3 } })).toEqual(["reports.outputDir"]);
    expect(paths({ tests: { directory: "../../.config/autostart" } })).toEqual(["tests.directory"]);
    expect(paths({ runners: [{ adapter: "vitest", dir: "/" }] })).toEqual(["runners[0].dir"]);
    expect(paths({ runners: [{ adapter: "vitest", config: "../x.ts" }] })).toEqual([
      "runners[0].config",
    ]);
  });

  it("accepts ordinary project-relative paths", () => {
    expect(
      paths({
        storeDir: ".cache/smarttest",
        reports: { outputDir: "reports" },
        tests: { directory: "test" },
        runners: [{ adapter: "vitest", dir: "packages/app", config: "vitest.config.ts" }],
      }),
    ).toEqual([]);
  });
});
