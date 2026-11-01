import { describe, expect, it } from "vitest";
import { readNodeTestScript, readRunnerConfig } from "./runner-config.js";

describe("readRunnerConfig", () => {
  it("reads Vitest setup files, global setup, aliases and local imports", () => {
    const f = readRunnerConfig(
      "vitest",
      "vitest.config.ts",
      `import { fileURLToPath } from "node:url";
       import { defineConfig, mergeConfig } from "vitest/config";
       import { shared } from "./vitest.shared";
       const setup = ["./test/setup.ts"];
       export default mergeConfig(shared, defineConfig({
         resolve: { alias: { "virtual:flags": fileURLToPath(new URL("./test/flags.ts", import.meta.url)) } },
         test: {
           setupFiles: setup,
           globalSetup: path.resolve(__dirname, "test/global.ts"),
           alias: [{ find: /^~mocks\\/(.*)$/, replacement: "./test/mocks/$1" }],
         },
       }));`,
    );
    expect(f.imports).toEqual(["./vitest.shared"]);
    expect(f.loads).toEqual([
      { key: "setupFiles", path: "./test/setup.ts", base: "runner" },
      { key: "globalSetup", path: "test/global.ts", base: "config" },
    ]);
    expect(f.mappings).toEqual([
      {
        key: "alias",
        find: "virtual:flags",
        regex: false,
        target: { path: "./test/flags.ts", base: "config" },
      },
      {
        key: "alias",
        find: "^~mocks\\/(.*)$",
        regex: true,
        target: { path: "./test/mocks/$1", base: "runner" },
      },
    ]);
    expect(f.computed).toEqual([]);
  });

  it("reports a computed value instead of guessing", () => {
    const f = readRunnerConfig(
      "vitest",
      "vitest.config.ts",
      `export default { test: { setupFiles: process.env.CI ? ["./a.ts"] : findSetups() } };`,
    );
    expect(f.loads).toEqual([]);
    expect(f.computed).toEqual(["setupFiles"]);
  });

  it("reads Jest configuration, including JSON (package.json `jest`)", () => {
    const j = readRunnerConfig(
      "jest",
      "jest.config.json",
      JSON.stringify({
        rootDir: ".",
        setupFiles: ["<rootDir>/test/env.js"],
        setupFilesAfterEnv: ["./test/after-env.ts", "jest-extended/all"],
        globalSetup: "./test/global-setup.js",
        globalTeardown: "./test/global-teardown.js",
        testEnvironment: "./test/env.js",
        transform: { "^.+\\.tsx?$": ["ts-jest", { isolatedModules: true }] },
        moduleNameMapper: { "\\.(css|less)$": "<rootDir>/test/styleMock.js" },
      }),
    );
    expect(j.root).toEqual({ path: ".", base: "runner" });
    expect(j.loads.map((l) => `${l.key}:${l.path}`)).toEqual([
      "setupFiles:<rootDir>/test/env.js",
      "setupFilesAfterEnv:./test/after-env.ts",
      "setupFilesAfterEnv:jest-extended/all",
      "globalSetup:./test/global-setup.js",
      "globalTeardown:./test/global-teardown.js",
      "testEnvironment:./test/env.js",
      "transform:ts-jest",
    ]);
    expect(j.mappings).toEqual([
      {
        key: "moduleNameMapper",
        find: "\\.(css|less)$",
        regex: true,
        target: { path: "<rootDir>/test/styleMock.js", base: "runner" },
      },
    ]);
  });

  it("reads Playwright global setup and Cypress support files", () => {
    const p = readRunnerConfig(
      "playwright",
      "playwright.config.ts",
      `export default defineConfig({ globalSetup: require.resolve("./e2e/global-setup"), globalTeardown: "./e2e/teardown.ts" });`,
    );
    expect(p.loads).toEqual([
      { key: "globalSetup", path: "./e2e/global-setup", base: "config" },
      { key: "globalTeardown", path: "./e2e/teardown.ts", base: "runner" },
    ]);
    const c = readRunnerConfig(
      "cypress",
      "cypress.config.mjs",
      `export default defineConfig({ e2e: { supportFile: false } });`,
    );
    expect(c.loads).toEqual([]);
    expect(c.present).toEqual(["supportFile"]);
    const d = readRunnerConfig("cypress", "cypress.config.mjs", `export default {};`);
    expect(d.present).toEqual([]);
  });
});

describe("readNodeTestScript", () => {
  it("reads --import, --require and -r", () => {
    expect(
      readNodeTestScript(
        "node --import ./test/setup.mjs -r ./test/env.cjs --require=tsx --test test/",
      ),
    ).toEqual({
      loads: [
        { key: "--import", path: "./test/setup.mjs", base: "runner" },
        { key: "-r", path: "./test/env.cjs", base: "runner" },
        { key: "--require", path: "tsx", base: "runner" },
      ],
      computed: false,
    });
    expect(readNodeTestScript("node --import $SETUP --test").computed).toBe(true);
  });
});
