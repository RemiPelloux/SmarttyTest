/**
 * `smarttest migrate --to vitest`: moves a Jest project to Vitest without losing SmartTest's
 * rules or history. Test files keep their shape: Vitest runs with `globals: true` (describe/it/
 * expect stay global, as in Jest) and `jest.*` calls become `vi.*`. Recorded durations, traces
 * and run history are keyed by file, so they carry over.
 */
import { join } from "node:path";
import { readJson, readText } from "@smarttest/shared";
import type { FilePlan } from "./index.js";

/** jest.X → vi.X where the API has the same meaning. */
const SAME = [
  "fn",
  "mock",
  "doMock",
  "unmock",
  "spyOn",
  "clearAllMocks",
  "resetAllMocks",
  "restoreAllMocks",
  "useFakeTimers",
  "useRealTimers",
  "advanceTimersByTime",
  "advanceTimersToNextTimer",
  "runAllTimers",
  "runOnlyPendingTimers",
  "clearAllTimers",
  "getTimerCount",
  "setSystemTime",
  "isMockFunction",
  "mocked",
  "resetModules",
];

export interface MigrateNote {
  file: string;
  line: number;
  message: string;
}

/** Rewrites one Jest test file for Vitest globals mode. */
export function migrateTestSource(
  text: string,
  file: string,
): { after: string; notes: MigrateNote[] } {
  const notes: MigrateNote[] = [];
  const lines = text.split("\n");
  const out = lines.map((l, i) => {
    let s = l;
    for (const api of SAME) s = s.replace(new RegExp(`\\bjest\\.${api}\\b`, "g"), `vi.${api}`);
    if (/\bjest\.requireActual\(/.test(s)) {
      s = s.replace(/\bjest\.requireActual\(/g, "await vi.importActual(");
      notes.push({
        file,
        line: i + 1,
        message:
          "jest.requireActual became `await vi.importActual(…)`: the mock factory must be async",
      });
    }
    if (/\bjest\.(?!fn|mock|spyOn)\w+/.test(s))
      notes.push({
        file,
        line: i + 1,
        message: `no automatic Vitest equivalent: ${/\bjest\.\w+/.exec(s)?.[0]}`,
      });
    if (/from\s+["']@jest\/globals["']/.test(s)) {
      s = s.replace(/import\s*\{[^}]*\}\s*from\s*["']@jest\/globals["'];?/, "");
      notes.push({
        file,
        line: i + 1,
        message: "removed the @jest/globals import (Vitest globals are enabled)",
      });
    }
    if (/\bjest\.Mock\b|\bjest\.Mocked\b|\bjest\.SpyInstance\b/.test(s))
      notes.push({
        file,
        line: i + 1,
        message: 'Jest types (jest.Mock…) need `import type { Mock } from "vitest"`',
      });
    if (/\(\s*done\s*\)\s*=>/.test(s))
      notes.push({
        file,
        line: i + 1,
        message: "`done` callbacks are not supported by Vitest: return a promise instead",
      });
    return s;
  });
  return { after: out.join("\n"), notes };
}

export interface MigratePlan {
  files: FilePlan[];
  notes: MigrateNote[];
  install: string;
}

export async function planMigrate(
  root: string,
  options: {
    dir: string;
    testFiles: readonly string[];
    packageManager: string;
    typescript: boolean;
  },
): Promise<MigratePlan> {
  const files: FilePlan[] = [];
  const notes: MigrateNote[] = [];
  for (const f of options.testFiles) {
    const before = await readText(join(root, f));
    if (before === undefined) continue;
    const { after, notes: n } = migrateTestSource(before, f);
    notes.push(...n);
    if (after !== before)
      files.push({
        path: f,
        action: "modify",
        reason: "jest.* → vi.*",
        before,
        after,
        risk: "medium",
      });
  }
  const pre = options.dir ? `${options.dir}/` : "";
  const pkgPath = `${pre}package.json`;
  const pkgText = await readText(join(root, pkgPath));
  const pkg = (await readJson<Record<string, unknown>>(join(root, pkgPath))) ?? {};
  const jestCfg = (pkg.jest ?? {}) as { testEnvironment?: string; setupFilesAfterEnv?: string[] };
  const env =
    jestCfg.testEnvironment && jestCfg.testEnvironment !== "node"
      ? jestCfg.testEnvironment
      : undefined;
  const setup = jestCfg.setupFilesAfterEnv ?? [];
  const configName = `${pre}vitest.config.${options.typescript ? "ts" : "mjs"}`;
  if ((await readText(join(root, configName))) === undefined)
    files.push({
      path: configName,
      action: "create",
      reason: "Vitest with Jest-compatible globals and test patterns",
      after: [
        'import { defineConfig } from "vitest/config";',
        "",
        "// Created by `smarttest migrate --to vitest`: Jest-style globals and Jest's default test patterns.",
        "export default defineConfig({",
        "  test: {",
        "    globals: true,",
        `    include: ["**/__tests__/**/*.?(c|m)[jt]s?(x)", "**/?(*.)+(spec|test).?(c|m)[jt]s?(x)"],`,
        ...(env ? [`    environment: ${JSON.stringify(env)},`] : []),
        ...(setup.length
          ? [`    setupFiles: ${JSON.stringify(setup.map((s) => s.replace("<rootDir>/", "./")))},`]
          : []),
        "  },",
        "});",
        "",
      ].join("\n"),
      risk: "medium",
    });
  if (pkgText !== undefined) {
    const scripts = (pkg.scripts ?? {}) as Record<string, string>;
    let changed = false;
    for (const [k, v] of Object.entries(scripts)) {
      const next = v
        .replace(/\bjest --watch\b/g, "vitest")
        .replace(/\bjest\b(?!\.)/g, "vitest run");
      if (next !== v) {
        scripts[k] = next;
        changed = true;
      }
    }
    if (pkg.jest) {
      delete pkg.jest;
      changed = true;
    }
    if (changed) {
      const indent = /^\{\n(\s+)/.exec(pkgText)?.[1] ?? "  ";
      files.push({
        path: pkgPath,
        action: "modify",
        reason: "test scripts run Vitest; Jest settings moved to vitest config",
        before: pkgText,
        after: `${JSON.stringify({ ...pkg, scripts }, null, indent)}\n`,
        risk: "medium",
      });
    }
  }
  const pm =
    options.packageManager === "pnpm"
      ? "pnpm add -D"
      : options.packageManager === "yarn"
        ? "yarn add -D"
        : "npm install -D";
  return { files, notes, install: `${options.dir ? `cd ${options.dir} && ` : ""}${pm} vitest` };
}
