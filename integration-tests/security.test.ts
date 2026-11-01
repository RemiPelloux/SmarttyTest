/**
 * Regression tests of the 1.0.0 security review (documentation/architecture/security-review.md):
 * repository content (a fork's pull request) must not redirect SmartTest's writes or plant state
 * that reduces the selection.
 */
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareCi, SmartTest } from "@smarttest/core";
import { afterEach, describe, expect, it } from "vitest";
import { git, materialize } from "./helpers.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("state planted by repository content", () => {
  it("refuses a store that is committed to the repository (SR-06)", async () => {
    const dir = await materialize("ts-lib-vitest", { git: true });
    dirs.push(dir);
    // A crafted result cache claiming every test passed, committed by a pull request.
    await mkdir(join(dir, ".smarttest", "cache"), { recursive: true });
    await writeFile(
      join(dir, ".smarttest", "cache", "results.json"),
      JSON.stringify({ version: 1, files: {} }),
    );
    git(dir, "add", "-f", ".smarttest/cache/results.json");
    git(dir, "commit", "-q", "-m", "plant a cache");
    await expect(SmartTest.open({ root: dir })).rejects.toMatchObject({
      code: "ST_STORE_TRACKED",
      exitCode: 3,
    });
    git(dir, "rm", "-q", "-r", "--cached", ".smarttest");
    await expect(SmartTest.open({ root: dir })).resolves.toBeInstanceOf(SmartTest);
  });

  it("never writes through a committed .smarttest/state link (SR-01)", async () => {
    const dir = await materialize("ts-lib-vitest");
    dirs.push(dir);
    const outside = await mkdtemp(join(tmpdir(), "st-home-"));
    dirs.push(outside);
    await mkdir(join(dir, ".smarttest"), { recursive: true });
    await symlink(
      outside,
      join(dir, ".smarttest", "state"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const st = await SmartTest.open({ root: dir });
    await expect(st.analyze()).rejects.toMatchObject({ code: "ST_UNSAFE_PATH" });
    expect(await readdir(outside)).toEqual([]);
  });
});

describe("CI variables (SR-05)", () => {
  it("runs the full suite rather than pass an option-like ref to git", async () => {
    const dir = await materialize("ts-lib-vitest", { git: true });
    dirs.push(dir);
    const plan = await prepareCi(dir, {
      provider: "github",
      isPullRequest: true,
      targetBranch: "--upload-pack=touch pwned",
      evidence: "test",
    });
    expect(plan.all).toBe(true);
    expect(plan.warnings.join()).toContain("unsafe ref");
  });
});
