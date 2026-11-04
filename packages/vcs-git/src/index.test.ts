import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

const repo = async (prefix: string) => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const run = (cwd: string, ...args: string[]) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@t",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "protocol.file.allow=always",
        ...args,
      ],
      { cwd, encoding: "utf8" },
    );
  run(dir, "init", "-q", "-b", "main");
  return { dir, git: (...args: string[]) => run(dir, ...args), gitIn: run };
};

describe("git change sets", () => {
  it("keeps untracked files of a subfolder project, and outside changes, whatever the diff config", async () => {
    const { dir, git } = await repo("st-git-sub-");
    try {
      await mkdir(join(dir, "app/src"), { recursive: true });
      await mkdir(join(dir, "app/test"), { recursive: true });
      await mkdir(join(dir, "shared"), { recursive: true });
      await writeFile(join(dir, "app/src/m.ts"), "export const m = 1;\nexport const n = 2;\n");
      await writeFile(join(dir, "shared/x.ts"), "export const x = 1;\n");
      git("add", "-A");
      git("commit", "-q", "-m", "one");
      // Settings that change paths, prefixes and colours in `git diff` output.
      for (const [k, v] of [
        ["diff.mnemonicPrefix", "true"],
        ["diff.noprefix", "true"],
        ["diff.relative", "true"],
        ["diff.external", "false"],
        ["diff.renames", "false"],
        ["diff.ignoreSubmodules", "all"],
        ["color.diff", "always"],
        ["status.relativePaths", "true"],
      ] as const)
        git("config", k, v);
      await writeFile(join(dir, "app/src/m.ts"), "export const m = 1;\nexport const n = 3;\n");
      await writeFile(join(dir, "app/test/new.test.ts"), "test('x', () => {});\n");
      await writeFile(join(dir, "shared/x.ts"), "export const x = 2;\n");
      await writeFile(join(dir, "shared/y.ts"), "export const y = 1;\n");
      const input = await new GitAdapter(join(dir, "app")).getChangeInput({ kind: "uncommitted" });
      const changes = input.changeSet.changes;
      expect(changes.map((c) => [c.type, c.path]).sort()).toEqual([
        ["added", "test/new.test.ts"],
        ["modified", "src/m.ts"],
      ]);
      expect(changes.find((c) => c.path === "src/m.ts")?.changedRanges?.[0]?.start.line).toBe(1);
      expect(input.changeSet.outside?.map((c) => [c.type, c.path]).sort()).toEqual([
        ["added", "../shared/y.ts"],
        ["modified", "../shared/x.ts"],
      ]);
      expect(await input.readBefore("src/m.ts")).toContain("n = 2");
      await input.close?.();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("expands a submodule bump into the files that changed inside it", async () => {
    const lib = await repo("st-git-lib-");
    const { dir, git, gitIn } = await repo("st-git-super-");
    try {
      await writeFile(join(lib.dir, "x.ts"), "export const x = 1;\n");
      lib.git("add", "-A");
      lib.git("commit", "-q", "-m", "one");
      await writeFile(join(dir, "m.ts"), 'export { x } from "./lib/x";\n');
      git("submodule", "add", "-q", lib.dir, "lib");
      git("add", "-A");
      git("commit", "-q", "-m", "with lib");
      const sub = join(dir, "lib");
      await writeFile(join(sub, "x.ts"), "export const x = 2;\n");
      gitIn(sub, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-am", "two");
      const adapter = new GitAdapter(dir);
      // Uncommitted bump (the checkout moved), then the same bump committed.
      const input = await adapter.getChangeInput({ kind: "uncommitted" });
      expect(input.changeSet.changes).toMatchObject([{ type: "modified", path: "lib/x.ts" }]);
      expect(await input.readBefore("lib/x.ts")).toBe("export const x = 1;\n");
      await input.close?.();
      git("commit", "-q", "-am", "bump");
      const committed = await new GitAdapter(dir).getChangeInput({
        kind: "base",
        ref: "HEAD~1",
        direct: true,
        target: "HEAD",
      });
      expect(committed.changeSet.changes).toMatchObject([{ type: "modified", path: "lib/x.ts" }]);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(lib.dir, { recursive: true, force: true });
    }
  });

  it("flags a submodule bump it cannot expand, so its users are selected", async () => {
    const { dir, git } = await repo("st-git-gitlink-");
    try {
      await writeFile(join(dir, "m.ts"), "export const m = 1;\n");
      git("add", "-A");
      git("update-index", "--add", "--cacheinfo", `160000,${"1".repeat(40)},vendor/lib`);
      git("commit", "-q", "-m", "one");
      git("update-index", "--cacheinfo", `160000,${"2".repeat(40)},vendor/lib`);
      git("commit", "-q", "-m", "two");
      const input = await new GitAdapter(dir).getChangeInput({
        kind: "base",
        ref: "HEAD~1",
        direct: true,
        target: "HEAD",
      });
      expect(input.changeSet.changes).toEqual([
        { type: "modified", path: "vendor/lib", submodule: true },
      ]);
      expect(input.changeSet.warnings.join("\n")).toMatch(/Submodule vendor\/lib changed/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
