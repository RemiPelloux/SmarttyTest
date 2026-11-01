// TEMPORARY Windows diagnostics (removed before merge).
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { SmartTest } from "@smarttest/core";
import { it } from "vitest";
import { materialize } from "./helpers.js";

it.runIf(process.platform === "win32")(
  "diag",
  async () => {
    for (const [name, bin] of [
      ["no-vcs-vitest", "node_modules/vitest/vitest.mjs"],
      ["express-cjs-jest", "node_modules/jest/bin/jest.js"],
    ] as const) {
      const dir = await materialize(name);
      console.log("DIAG dir", dir, realpathSync.native(dir));
      const out = await (await SmartTest.open({ root: dir })).run({ formats: ["json"] });
      console.log("DIAG run", name, JSON.stringify(out.report.executions).slice(0, 3000));
      const args =
        name === "no-vcs-vitest"
          ? [
              "run",
              "--reporter=json",
              `--outputFile=${join(dir, "r.json")}`,
              join(realpathSync.native(dir), "tests", "math.test.ts"),
            ]
          : ["--json", `--outputFile=${join(dir, "r.json")}`];
      const r = spawnSync(process.execPath, [join(dir, bin), ...args], {
        cwd: realpathSync.native(dir),
        encoding: "utf8",
      });
      console.log(
        "DIAG spawn",
        name,
        r.status,
        r.error,
        r.stdout.slice(0, 2000),
        r.stderr.slice(0, 3000),
      );
      try {
        console.log("DIAG report", readFileSync(join(dir, "r.json"), "utf8").slice(0, 1500));
      } catch (e) {
        console.log("DIAG no report", String(e));
      }
    }
  },
  120_000,
);
