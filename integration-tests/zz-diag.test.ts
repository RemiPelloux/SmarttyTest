// TEMPORARY Windows diagnostics (removed before merge).
import { existsSync, lstatSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { it } from "vitest";
import { FIXTURES, materialize } from "./helpers.js";

const tryIt = (label: string, fn: () => unknown) => {
  try {
    console.log("DIAG", label, JSON.stringify(fn()));
  } catch (e) {
    console.log("DIAG", label, "THROWS", String(e));
  }
};

it.runIf(process.platform === "win32")(
  "diag",
  async () => {
    const src = join(FIXTURES, "no-vcs-vitest", "node_modules");
    tryIt("src exists", () => existsSync(src));
    tryIt("src list", () => readdirSync(src));
    tryIt("src vitest lstat", () => lstatSync(join(src, "vitest")).isSymbolicLink());
    tryIt("src vitest link", () => readlinkSync(join(src, "vitest")));
    tryIt("src vitest real", () => realpathSync.native(join(src, "vitest")));
    tryIt("src vitest.mjs", () => existsSync(join(src, "vitest", "vitest.mjs")));
    const dir = await materialize("no-vcs-vitest");
    const nm = join(dir, "node_modules");
    tryIt("dst lstat", () => [lstatSync(nm).isSymbolicLink(), lstatSync(nm).isDirectory()]);
    tryIt("dst link", () => readlinkSync(nm));
    tryIt("dst list", () => readdirSync(nm));
    tryIt("dst vitest.mjs", () => existsSync(join(nm, "vitest", "vitest.mjs")));
    tryIt("dst vitest real", () => realpathSync.native(join(nm, "vitest")));
    tryIt("dst canonical vitest.mjs", () =>
      existsSync(join(realpathSync.native(dir), "node_modules", "vitest", "vitest.mjs")),
    );
  },
  120_000,
);
