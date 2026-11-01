import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { catArgs, SvnAdapter } from "./index.js";

const hasSvn =
  spawnSync("svn", ["--version", "--quiet"]).status === 0 &&
  spawnSync("svnadmin", ["--version", "--quiet"]).status === 0;

describe("svn file reads (SR-05)", () => {
  it("never lets a file name be read as an option or a peg revision", () => {
    expect(catArgs("BASE", "--config-dir=evil")).toEqual([
      "cat",
      "--non-interactive",
      "-r",
      "BASE",
      "--",
      "--config-dir=evil",
    ]);
    expect(catArgs("12", "src/a@2x.ts").at(-1)).toBe("src/a@2x.ts@");
  });

  it.skipIf(!hasSvn)("reads the base content of a file named like an option", async () => {
    const base = await mkdtemp(join(tmpdir(), "st-svn-"));
    try {
      const repo = join(base, "repo");
      const wc = join(base, "wc");
      const run = (cwd: string, cmd: string, ...args: string[]) => {
        const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
        if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")}: ${r.stderr}`);
      };
      run(base, "svnadmin", "create", repo);
      run(base, "svn", "checkout", "-q", pathToFileURL(repo).href, wc);
      await mkdir(join(wc, "src"));
      await writeFile(join(wc, "--config-dir=evil"), "before\n");
      await writeFile(join(wc, "src", "a@2x.ts"), "export const a = 1;\n");
      run(wc, "svn", "add", "-q", "--", "--config-dir=evil", "src");
      run(wc, "svn", "add", "-q", "--force", "src/a@2x.ts@");
      run(wc, "svn", "commit", "-q", "-m", "initial");
      await writeFile(join(wc, "--config-dir=evil"), "after\n");
      const input = await new SvnAdapter(wc).getChangeInput({ kind: "uncommitted" });
      expect(input.changeSet.changes.map((c) => c.path)).toContain("--config-dir=evil");
      expect(await input.readBefore("--config-dir=evil")).toBe("before\n");
      expect(await input.readBefore("src/a@2x.ts")).toBe("export const a = 1;\n");
      await expect(
        new SvnAdapter(wc).getChangeInput({ kind: "base", ref: "--config-dir=/tmp" }),
      ).rejects.toMatchObject({ code: "ST_UNSAFE_REVISION" });
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
