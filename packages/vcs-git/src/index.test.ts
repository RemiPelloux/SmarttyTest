import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GitAdapter } from "./index.js";

describe("git revisions (SR-05)", () => {
  it("refuses option-like base and target revisions instead of passing them to git", async () => {
    const dir = await mkdtemp(join(tmpdir(), "st-git-opt-"));
    try {
      const git = (...args: string[]) =>
        execFileSync(
          "git",
          ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args],
          { cwd: dir, encoding: "utf8" },
        );
      git("init", "-q", "-b", "main");
      await writeFile(join(dir, "a.ts"), "export const a = 1;\n");
      git("add", "-A");
      git("commit", "-q", "-m", "one");
      const out = join(dir, "written-by-git");
      const adapter = new GitAdapter(dir);
      await expect(adapter.resolveBase(`--output=${out}`)).rejects.toMatchObject({
        code: "ST_UNSAFE_REVISION",
      });
      await expect(
        adapter.getChangeInput({ kind: "base", ref: "HEAD", target: `--output=${out}` }),
      ).rejects.toMatchObject({ code: "ST_UNSAFE_REVISION" });
      expect(existsSync(out)).toBe(false);
      expect(await adapter.resolveBase("main")).toMatch(/^[0-9a-f]{40,64}$/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
