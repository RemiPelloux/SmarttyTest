import { describe, expect, it } from "vitest";
import {
  findNodeTestScript,
  readNodeTestCommand,
  scriptCommands,
  vitestScriptTypecheck,
} from "./scripts.js";

describe("scriptCommands", () => {
  it("splits on && || ; | outside quotes and removes the quotes", () => {
    expect(scriptCommands(`tsc -b && A="x && y" node --test 'a b' || echo; c | d`)).toEqual([
      ["tsc", "-b"],
      ["A=x && y", "node", "--test", "a b"],
      ["echo"],
      ["c"],
      ["d"],
    ]);
  });
});

describe("readNodeTestCommand", () => {
  it("keeps the node options, wherever they sit, and drops the ones SmartTest owns", () => {
    const c = readNodeTestCommand(
      "node --import tsx --test --experimental-test-module-mocks --test-concurrency 2 " +
        "--test-name-pattern=slow --test-reporter spec --test-reporter-destination=stdout " +
        "--experimental-test-coverage --test-coverage-lines=90 --watch -C dev --env-file=.env " +
        "--test-timeout 5000 ./test/ 'src/**/*.test.ts'",
    );
    expect(c?.nodeArgs).toEqual([
      "--import=tsx",
      "--experimental-test-module-mocks",
      "--test-concurrency=2",
      "-C",
      "dev",
      "--env-file=.env",
      "--test-timeout=5000",
    ]);
    expect(c?.patterns).toEqual(["test/", "src/**/*.test.ts"]);
    expect(c?.preloads).toEqual([{ flag: "--import", value: "tsx" }]);
    expect(c?.computed).toBe(false);
  });

  it("reads env prefixes (cross-env too) and the preloads inside NODE_OPTIONS", () => {
    const c = readNodeTestCommand(
      `cross-env TZ=UTC NODE_OPTIONS="--require ./setup.cjs --no-warnings" node --test`,
    );
    expect(c?.env).toEqual({ TZ: "UTC", NODE_OPTIONS: "--require ./setup.cjs --no-warnings" });
    expect(c?.nodeArgs).toEqual([]);
    expect(c?.preloads).toEqual([{ flag: "--require", value: "./setup.cjs" }]);
  });

  it("finds node behind a wrapper and in a later command; flags a computed part", () => {
    expect(readNodeTestCommand("npm run build && c8 node --test test/")?.patterns).toEqual([
      "test/",
    ]);
    const c = readNodeTestCommand("node --import $SETUP --test");
    expect(c?.computed).toBe(true);
    expect(c?.nodeArgs).toEqual([]);
    expect(readNodeTestCommand("node server.js")).toBeUndefined();
    expect(readNodeTestCommand("vitest run")).toBeUndefined();
  });

  it("the first script that runs node --test", () => {
    expect(
      findNodeTestScript({ build: "tsc", test: "node --test", "test:x": "node -r a --test" })?.name,
    ).toBe("test");
  });
});

describe("vitestScriptTypecheck", () => {
  it("is on when a script runs vitest with --typecheck", () => {
    expect(vitestScriptTypecheck({ test: "vitest run --typecheck" })).toBe(true);
    expect(vitestScriptTypecheck({ test: "pnpm exec vitest --typecheck.enabled" })).toBe(true);
    expect(vitestScriptTypecheck({ t: "tsc && npx vitest run --typecheck=true src" })).toBe(true);
  });

  it("is off without it, with --typecheck.only, or for another config", () => {
    expect(vitestScriptTypecheck({ test: "vitest run" })).toBe(false);
    expect(vitestScriptTypecheck({ test: "vitest --typecheck.only" })).toBe(false);
    expect(vitestScriptTypecheck({ test: "tsc --typecheck && vitest run" })).toBe(false);
    const other = { types: "vitest --typecheck --config vitest.types.config.ts" };
    expect(vitestScriptTypecheck(other, "vitest.config.ts")).toBe(false);
    expect(vitestScriptTypecheck(other, "pkg/vitest.types.config.ts")).toBe(true);
    expect(vitestScriptTypecheck(other)).toBe(true);
  });
});
