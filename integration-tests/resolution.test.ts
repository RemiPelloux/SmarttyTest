/**
 * Import resolution and the index cache, end to end (resolution audit): a local folder named
 * like a Node builtin, a deleted asset with a warm index, and alias changes in a jsconfig.json or
 * in a config a tsconfig extends.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SmartTest } from "@smarttest/core";
import { afterEach, describe, expect, it } from "vitest";
import { git } from "./helpers.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const PACKAGE = JSON.stringify({
  name: "resolution",
  type: "module",
  scripts: { test: "vitest run" },
  devDependencies: { vitest: "^5.0.0" },
});

async function write(dir: string, files: Record<string, string>): Promise<void> {
  for (const [p, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, p)), { recursive: true });
    await writeFile(join(dir, p), text);
  }
}

/** A committed project (the store is ignored). */
async function project(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "st-resolution-"));
  dirs.push(dir);
  await write(dir, {
    ".gitignore": ".smarttest/\nnode_modules\n",
    "package.json": PACKAGE,
    ...files,
  });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "initial");
  return dir;
}

const selected = async (dir: string) =>
  (await (await SmartTest.open({ root: dir })).analyze()).decision.selectedTests
    .map((t) => t.filePath)
    .sort();

describe("import resolution, end to end", () => {
  // Audit p1: `domain/user` and `constants` under `baseUrl: "src"` were taken for Node builtins.
  it("resolves a baseUrl folder named like a Node builtin to the project's file", async () => {
    const dir = await project({
      "tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: "src" } }),
      "src/domain/user.ts": "export function makeUser() { return { id: 1 }; }\n",
      "src/constants.ts": "export const LIMIT = 3;\n",
      "src/app.ts":
        'import { makeUser } from "domain/user";\nimport { LIMIT } from "constants";\nexport const run = () => [makeUser(), LIMIT];\n',
      "src/app.test.ts":
        'import { it } from "vitest";\nimport { run } from "./app";\nit("runs", () => { run(); });\n',
    });
    await write(dir, {
      "src/domain/user.ts": "export function makeUser() { return { id: 2 }; }\n",
    });
    expect(await selected(dir)).toEqual(["src/app.test.ts"]);
  }, 60_000);

  // Audit p10: deleting an imported JSON file selected nothing once the index was warm.
  it("selects the importers of an asset deleted after the index was built", async () => {
    const dir = await project({
      "src/data.json": '{ "n": 1 }\n',
      "src/app.ts": 'import data from "./data.json";\nexport const n = () => data.n;\n',
      "src/app.test.ts":
        'import { it } from "vitest";\nimport { n } from "./app";\nit("reads", () => { n(); });\n',
    });
    expect(await selected(dir)).toEqual([]);
    await rm(join(dir, "src/data.json"));
    expect(await selected(dir)).toEqual(["src/app.test.ts"]);
  }, 60_000);

  // Audit p3/p4: the index cache key hashed tsconfig*.json files only, so a committed alias change
  // in a jsconfig.json, or in a config a tsconfig extends, kept the old resolutions.
  for (const [name, configs] of [
    [
      "jsconfig.json",
      (target: string) => ({
        "jsconfig.json": JSON.stringify({
          compilerOptions: { baseUrl: ".", paths: { "@lib/*": [`src/${target}/*`] } },
        }),
      }),
    ],
    [
      "a config the tsconfig extends",
      (target: string) => ({
        "tsconfig.json": JSON.stringify({ extends: "./config/base.json" }),
        "config/base.json": JSON.stringify({
          compilerOptions: { baseUrl: "..", paths: { "@lib/*": [`src/${target}/*`] } },
        }),
      }),
    ],
  ] as const) {
    it(`re-resolves the imports when an alias in ${name} changes`, async () => {
      const dir = await project({
        ...configs("old"),
        "src/old/math.ts": "export const add = (a: number, b: number) => a + b;\n",
        "src/new/math.ts": "export const add = (a: number, b: number) => b + a;\n",
        "src/app.ts": 'import { add } from "@lib/math";\nexport const total = () => add(1, 2);\n',
        "src/app.test.ts":
          'import { it } from "vitest";\nimport { total } from "./app";\nit("adds", () => { total(); });\n',
      });
      expect(await selected(dir)).toEqual([]);
      await write(dir, configs("new"));
      git(dir, "commit", "-qam", "switch the alias");
      await write(dir, {
        "src/new/math.ts": "export const add = (a: number, b: number) => a - -b;\n",
      });
      expect(await selected(dir)).toEqual(["src/app.test.ts"]);
    }, 60_000);
  }
});
