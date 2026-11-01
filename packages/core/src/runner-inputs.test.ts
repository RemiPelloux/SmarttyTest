import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ChangeSet } from "@smarttest/shared";
import type { RunnerRoot } from "@smarttest/test-discovery";
import { afterEach, describe, expect, it } from "vitest";
import { readRunnerInputs, runnerHits, runnerInputFiles } from "./runner-inputs.js";

let dir: string;
async function project(files: Record<string, string>): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), "st-runner-inputs-"));
  for (const [f, c] of Object.entries(files)) {
    await mkdir(dirname(join(dir, f)), { recursive: true });
    await writeFile(join(dir, f), c);
  }
  return dir;
}
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

const changed = (...paths: string[]): ChangeSet => ({
  provider: "git",
  completeness: "complete",
  warnings: [],
  changes: paths.map((path) => ({ type: "modified" as const, path })),
});

describe("readRunnerInputs", () => {
  it("Vitest: config imports, setup files, global setup and file aliases", async () => {
    const root = await project({
      "vitest.config.ts": `import { fileURLToPath } from "node:url";
        import { defineConfig, mergeConfig } from "vitest/config";
        import { shared } from "./vitest.shared";
        export default mergeConfig(shared, defineConfig({
          resolve: { alias: { "virtual:flags": fileURLToPath(new URL("./test/flags.ts", import.meta.url)), "@src": "./src" } },
          test: { setupFiles: ["./test/setup.ts", "jest-extended/all"] },
        }));`,
      "vitest.shared.ts": `export const shared = { test: { globalSetup: "./test/global.ts" } };`,
      "test/setup.ts": `import "../src/mocks/handlers";`,
      "test/global.ts": `export default () => {};`,
      "test/flags.ts": `export const on = true;`,
      "src/index.ts": "",
    });
    const r = await readRunnerInputs(root, {
      adapter: "vitest",
      dir: "",
      configFile: "vitest.config.ts",
    });
    expect(r.configs).toEqual([
      { file: "vitest.config.ts" },
      { file: "vitest.shared.ts", importedBy: "vitest.config.ts" },
    ]);
    expect(r.loads).toEqual([
      { file: "test/setup.ts", key: "setupFiles", source: "vitest.config.ts" },
      { file: "test/global.ts", key: "globalSetup", source: "vitest.shared.ts" },
    ]);
    // A directory alias is the resolver's: only a file target is a mapped module.
    expect(r.mappings).toEqual([
      {
        file: "test/flags.ts",
        key: "alias",
        find: "virtual:flags",
        regex: false,
        source: "vitest.config.ts",
      },
    ]);
    expect(r.computed).toEqual([]);
  });

  it("Jest (package.json): setup files, environment, global setup/teardown, moduleNameMapper", async () => {
    const root = await project({
      "package.json": JSON.stringify({
        jest: {
          setupFiles: ["<rootDir>/test/env.js"],
          setupFilesAfterEnv: ["./test/after-env.js"],
          globalSetup: "./test/global-setup.js",
          globalTeardown: "./test/global-teardown.js",
          testEnvironment: "./test/environment.js",
          moduleNameMapper: {
            "\\.(css|less)$": "<rootDir>/test/styleMock.js",
            "^@/(.*)$": "<rootDir>/src/$1",
          },
        },
      }),
      "test/env.js": "",
      "test/after-env.js": "",
      "test/global-setup.js": "",
      "test/global-teardown.js": "",
      "test/environment.js": "",
      "test/styleMock.js": "",
    });
    const r = await readRunnerInputs(root, { adapter: "jest", dir: "" });
    expect(r.loads.map((l) => `${l.key}:${l.file}`)).toEqual([
      "setupFiles:test/env.js",
      "setupFilesAfterEnv:test/after-env.js",
      "globalSetup:test/global-setup.js",
      "globalTeardown:test/global-teardown.js",
      "testEnvironment:test/environment.js",
    ]);
    expect(r.mappings.map((m) => `${m.find}→${m.file}`)).toEqual([
      "\\.(css|less)$→test/styleMock.js",
    ]);
  });

  it("Playwright global setup, Cypress default support file, node --test preloads", async () => {
    const root = await project({
      "e2e/playwright.config.ts": `export default { globalSetup: require.resolve("./global-setup"), globalTeardown: "./teardown.ts" };`,
      "e2e/global-setup.ts": "",
      "e2e/teardown.ts": "",
      "cy/cypress.config.js": `module.exports = { e2e: {} };`,
      "cy/cypress/support/e2e.js": "",
      "node/package.json": JSON.stringify({
        scripts: { test: "node --import ./test/setup.mjs --test test/" },
      }),
      "node/test/setup.mjs": "",
    });
    const pw = await readRunnerInputs(root, {
      adapter: "playwright",
      dir: "e2e",
      configFile: "e2e/playwright.config.ts",
    });
    expect(pw.loads.map((l) => `${l.key}:${l.file}`)).toEqual([
      "globalSetup:e2e/global-setup.ts",
      "globalTeardown:e2e/teardown.ts",
    ]);
    const cy = await readRunnerInputs(root, {
      adapter: "cypress",
      dir: "cy",
      configFile: "cy/cypress.config.js",
    });
    expect(cy.loads.map((l) => `${l.key}:${l.file}`)).toEqual([
      "supportFile:cy/cypress/support/e2e.js",
    ]);
    const node = await readRunnerInputs(root, { adapter: "node", dir: "node" });
    expect(node.loads.map((l) => `${l.key}:${l.file}`)).toEqual(["--import:node/test/setup.mjs"]);
  });
});

describe("runnerHits", () => {
  const vitest: RunnerRoot = { adapter: "vitest", dir: "", configFile: "vitest.config.ts" };
  const node: RunnerRoot = { adapter: "node", dir: "tools" };
  const imports: Record<string, string[]> = {
    "test/setup.ts": ["src/mocks/handlers.ts"],
    "src/mocks/handlers.ts": ["src/mocks/data.ts"],
    "test/c.test.ts": ["test/flags.ts"],
  };
  const ctx = (cs: ChangeSet, computed = false) => ({
    inputs: [
      {
        root: vitest,
        label: "vitest",
        configs: [
          { file: "vitest.config.ts" },
          { file: "vitest.shared.ts", importedBy: "vitest.config.ts" },
        ],
        loads: [{ file: "test/setup.ts", key: "setupFiles", source: "vitest.config.ts" }],
        mappings: [
          {
            file: "test/flags.ts",
            key: "alias",
            find: "virtual:flags",
            regex: false,
            source: "vitest.config.ts",
          },
        ],
        computed: computed ? [{ key: "setupFiles", source: "vitest.config.ts" }] : [],
      },
      { root: node, label: "node (tools)", configs: [], loads: [], mappings: [], computed: [] },
    ],
    testsOf: (r: RunnerRoot) =>
      r === vitest ? ["test/a.test.ts", "test/b.test.ts", "test/c.test.ts"] : ["tools/x.test.js"],
    importsOf: (f: string) => imports[f] ?? [],
    importersOf: (match: (s: string) => boolean) =>
      match("virtual:flags") ? [{ file: "src/flags-user.ts" }] : [],
    dependsDirectly: () => false,
    testsDependingOn: (f: string) => (f === "src/flags-user.ts" ? ["test/c.test.ts"] : []),
    reachesAnyTest: (f: string) => f === "src/flags-user.ts",
    isTest: (f: string) => f.includes(".test."),
    changeSet: cs,
  });

  it("a module a setup file imports selects every test of that runner only, with its chain", () => {
    const { hits } = runnerHits(ctx(changed("src/mocks/data.ts")));
    expect(hits).toEqual([
      {
        file: "src/mocks/data.ts",
        tests: ["test/a.test.ts", "test/b.test.ts", "test/c.test.ts"],
        message:
          "src/mocks/data.ts changed — imported by src/mocks/handlers.ts, setup file of vitest (setupFiles in vitest.config.ts)",
        path: ["src/mocks/data.ts", "src/mocks/handlers.ts", "test/setup.ts"],
      },
    ]);
  });

  it("the runner's configuration and what it imports; its own config replaces the wide trigger", () => {
    const { hits } = runnerHits(ctx(changed("vitest.config.ts", "vitest.shared.ts")));
    expect(hits.map((h) => [h.file, h.message, !!h.narrow])).toEqual([
      ["vitest.config.ts", "vitest.config.ts changed — configuration of vitest", true],
      [
        "vitest.shared.ts",
        "vitest.shared.ts changed — imported by vitest.config.ts, the configuration of vitest",
        false,
      ],
    ]);
  });

  it("a mapped module selects the tests that import the mapped specifier", () => {
    const { hits } = runnerHits(ctx(changed("test/flags.ts")));
    expect(hits.map((h) => [h.file, h.tests])).toEqual([["test/flags.ts", ["test/c.test.ts"]]]);
    // Imports analysis already resolves to the target are graph edges (symbol precision).
    const linked = runnerHits({
      ...ctx(changed("test/flags.ts")),
      importersOf: () => [{ file: "src/flags-user.ts", resolved: "test/flags.ts" }],
    });
    expect(linked.hits).toEqual([]);
    // No analysed import matches (a stylesheet mapper): every test of the runner.
    const unseen = runnerHits({ ...ctx(changed("test/flags.ts")), importersOf: () => [] });
    expect(unseen.hits[0]?.tests).toEqual(["test/a.test.ts", "test/b.test.ts", "test/c.test.ts"]);
  });

  it("a computed setting: a changed file no test reaches selects the runner's tests, and says so", () => {
    const { hits, warnings } = runnerHits(ctx(changed("src/orphan.ts", "src/flags-user.ts"), true));
    expect(hits.map((h) => h.file)).toEqual(["src/orphan.ts"]);
    expect(hits[0]?.message).toContain("setupFiles in vitest.config.ts is computed");
    expect(warnings[0]).toContain("can't be read statically");
  });

  it("cache inputs: configuration, loads, mapped modules and their imports", () => {
    const inputs = ctx(changed()).inputs[0];
    expect(runnerInputFiles(inputs as never, (f) => imports[f] ?? [])).toEqual([
      "src/mocks/data.ts",
      "src/mocks/handlers.ts",
      "test/flags.ts",
      "test/setup.ts",
      "vitest.config.ts",
      "vitest.shared.ts",
    ]);
  });
});
