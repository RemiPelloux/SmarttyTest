import { describe, expect, it } from "vitest";
import { analyzeSource } from "./analyze.js";

const scripts = (path: string, code: string) => {
  const a = analyzeSource(path, code);
  return {
    hints: (a.dynamicHints ?? []).map((h) => h.pattern),
    unresolved: a.dynamicUnresolved.length,
  };
};

describe("worker and child-process scripts", () => {
  it("links workers to their script", () => {
    expect(
      scripts(
        "src/run.ts",
        `import { Worker } from "node:worker_threads";
export const a = () => new Worker(new URL("./w.mjs", import.meta.url));
export const b = () => new Worker("./src/w2.js");
export const c = () => new Worker("postMessage(1)", { eval: true });`,
      ),
    ).toEqual({ hints: ["w.mjs", "w2.js"], unresolved: 0 });
    // Browser and Vite workers are globals.
    expect(
      scripts(
        "src/ui.ts",
        `export const w = new Worker(new URL("./calc.worker.ts", import.meta.url), { type: "module" });`,
      ).hints,
    ).toEqual(["calc.worker.ts"]);
  });

  it("links node, tsx and ts-node runs to their script", () => {
    const code = `import { execFileSync, spawn, fork, exec } from "node:child_process";
import * as cp from "child_process";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
const ROOT = resolve(import.meta.dirname, "..");
execFileSync(process.execPath, [fileURLToPath(new URL("./child.mjs", import.meta.url))]);
spawn("node", ["--import", "tsx", join(__dirname, "fixtures", "srv.ts"), "--port", "1"]);
fork(join(import.meta.dirname, "forked.js"));
cp.execFileSync("tsx", ["scripts/gen.ts"]);
execFileSync(process.execPath, ["--import", "tsx", \`scripts/ops/\${name}\`], { cwd: ROOT });
exec("node scripts/x.mjs --flag");
require("node:child_process").spawnSync("ts-node", ["-P", "tsconfig.json", "./tools/t.ts"]);
`;
    expect(scripts("test/run.test.ts", code)).toEqual({
      hints: [
        "child.mjs",
        "fixtures/srv.ts",
        "forked.js",
        "../scripts/gen.ts",
        "../scripts/ops/*",
        "../scripts/x.mjs",
        "../tools/t.ts",
      ],
      unresolved: 0,
    });
  });

  it("follows a script path kept in a local constant", () => {
    const code = `import { execFileSync } from "node:child_process";
import { Worker } from "node:worker_threads";
export function run() {
  const script = fileURLToPath(new URL("../scripts/double.mjs", import.meta.url));
  const url = new URL("./w.mjs", import.meta.url);
  new Worker(url);
  return execFileSync(process.execPath, [script, "2"]);
}`;
    expect(scripts("src/jobs.ts", code)).toEqual({
      hints: ["w.mjs", "../scripts/double.mjs"],
      unresolved: 0,
    });
  });

  it("records uncertainty when a script runs from a path it cannot work out", () => {
    const code = `import { execFileSync, spawn, fork } from "node:child_process";
export function run(script: string, args: string[]) {
  execFileSync(process.execPath, [script]);
  spawn("node", args);
  fork(script);
}`;
    expect(scripts("src/r.ts", code)).toEqual({ hints: [], unresolved: 3 });
  });

  it("ignores ordinary commands, inline code and package binaries", () => {
    const code = `import { spawn, execSync, execFileSync } from "node:child_process";
spawn("git", ["status"]);
execSync("npm run build");
execFileSync(process.execPath, ["-e", "console.log(1)"]);
execFileSync(process.execPath, ["--version"]);
execFileSync(process.execPath, [require.resolve("typescript/bin/tsc")]);
const m = /x/.exec("node a.js");
`;
    expect(scripts("test/a.test.ts", code)).toEqual({ hints: [], unresolved: 0 });
  });
});
