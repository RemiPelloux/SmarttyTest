import { spawn, spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { SmartTest } from "@smarttest/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { edit, FIXTURES, git, materialize } from "./helpers.js";

const stringsTest = "test/strings.test.ts";

/** A repository with no commit yet (the index is the only content). */
async function init(dir: string): Promise<void> {
  await writeFile(join(dir, ".gitignore"), "node_modules\n.smarttest/\n");
  git(dir, "init", "-q", "-b", "main");
}

async function commitAll(dir: string, message: string): Promise<void> {
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", message);
}

async function writeConfig(dir: string, checks: { name: string; run: string; stage?: string }[]) {
  await writeFile(
    join(dir, "smarttest.config.json"),
    `${JSON.stringify({ hook: { checks } }, null, 2)}\n`,
  );
}

// The suite also runs inside this repository's own pre-push hook. Each fixture starts
// as an ordinary shell; Git supplies fresh hook variables to the real-hook children.
beforeEach(() => {
  for (const key of [
    "GIT_PREFIX",
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_EXEC_PATH",
  ])
    vi.stubEnv(key, undefined);
});

const originalSkip = process.env.SMARTTEST_SKIP;
afterEach(() => {
  vi.unstubAllEnvs();
  if (originalSkip === undefined) delete process.env.SMARTTEST_SKIP;
  else process.env.SMARTTEST_SKIP = originalSkip;
});

describe("commit hooks run the staged content", () => {
  it("fails for a staged broken test even when the working tree fixed it", async () => {
    const dir = await materialize("ts-lib-vitest", { git: true });
    const original = await readFile(join(dir, stringsTest), "utf8");
    await edit(dir, stringsTest, 'toBe("Ada")', 'toBe("Adah")');
    git(dir, "add", stringsTest);
    await writeFile(join(dir, stringsTest), original);
    const indexBefore = git(dir, "diff", "--cached", "--binary");
    const statusBefore = git(dir, "status", "--porcelain");

    const st = await SmartTest.open({ root: dir });
    const result = await st.runHook("pre-commit", { cache: false });

    expect(result.skipped).toBe(false);
    expect(result.outcome?.exitCode).not.toBe(0);
    expect(result.outcome?.report.summary.failed).toBeGreaterThan(0);
    // The hook did not stash, reset or otherwise touch the real index and working tree.
    expect(git(dir, "diff", "--cached", "--binary")).toBe(indexBefore);
    expect(git(dir, "status", "--porcelain")).toBe(statusBefore);
    expect(git(dir, "worktree", "list").trim().split("\n")).toHaveLength(1);
  }, 120_000);

  it("passes for a staged fix even when the working tree reintroduced the failure", async () => {
    const dir = await materialize("ts-lib-vitest", { git: true });
    await edit(dir, stringsTest, 'toBe("Ada")', 'toBe("Adah")');
    await commitAll(dir, "broken test committed");

    const broken = await readFile(join(dir, stringsTest), "utf8");
    await writeFile(join(dir, stringsTest), broken.replace('toBe("Adah")', 'toBe("Ada")'));
    git(dir, "add", stringsTest);
    await writeFile(join(dir, stringsTest), broken);

    const result = await (await SmartTest.open({ root: dir })).runHook("pre-commit", {
      cache: false,
    });
    expect(result.outcome?.exitCode).toBe(0);
    expect(result.outcome?.report.summary.failed).toBe(0);
  }, 120_000);

  it("keeps the working tree's index stats across an isolated run", async () => {
    const dir = await materialize("ts-lib-vitest", { git: true });
    await (await SmartTest.open({ root: dir })).analyze();
    await edit(dir, stringsTest, 'toBe("Ada")', 'toBe("Adah")');
    git(dir, "add", stringsTest);
    await writeFile(join(dir, "scratch.txt"), "untracked\n");

    await (await SmartTest.open({ root: dir })).runHook("pre-commit", { cache: false });

    const { stats } = JSON.parse(
      await readFile(join(dir, ".smarttest", "state", "index.json"), "utf8"),
    ) as { stats: Record<string, [number, number]> };
    const files = Object.keys(stats);
    expect(files.length).toBeGreaterThan(1);
    // Every recorded stat is the working tree's, never the temporary checkout's.
    for (const f of files) {
      const s = statSync(join(dir, f));
      expect(stats[f], f).toEqual([s.mtimeMs, s.size]);
    }
    // The next run in the working tree reuses every file it did not change.
    const after = await (await SmartTest.open({ root: dir })).analyze();
    expect(after.indexStats.parsed).toBe(0);
  }, 120_000);

  it("uses the staged config, not the dirty working-tree copy", async () => {
    const dir = await materialize("ts-lib-vitest", { git: true });
    await writeConfig(dir, [{ name: "head", run: "true" }]);
    await commitAll(dir, "config");

    // Staged config fails the project check; the working-tree copy would pass.
    await writeConfig(dir, [{ name: "staged", run: "exit 1" }]);
    git(dir, "add", "smarttest.config.json");
    await writeConfig(dir, [{ name: "dirty", run: "true" }]);

    const result = await (await SmartTest.open({ root: dir })).runHook("pre-commit", {
      cache: false,
    });
    expect(result.outcome?.exitCode).toBe(0);
    expect(result.checks.map((c) => c.name)).toEqual(["staged"]);
    expect(result.checks[0]?.status).toBe("failed");
  }, 120_000);

  it("runs project checks in the isolated tree even when no tests are selected", async () => {
    const dir = await materialize("ts-lib-vitest", { git: true });
    await writeConfig(dir, [{ name: "staged notes", run: "grep -q NOTES_MARKER notes.md" }]);
    await commitAll(dir, "config");

    await writeFile(join(dir, "notes.md"), "NOTES_MARKER\n");
    git(dir, "add", "notes.md");
    await rm(join(dir, "notes.md"));

    const result = await (await SmartTest.open({ root: dir })).runHook("pre-commit", {
      cache: false,
    });
    expect(result.outcome?.report.decision.selectedTests).toHaveLength(0);
    expect(result.outcome?.exitCode).toBe(0);
    expect(result.checks).toEqual([
      expect.objectContaining({ name: "staged notes", project: "", status: "passed" }),
    ]);
  }, 120_000);

  it("preserves modes, symlinks, binary content and renames from the index", async () => {
    const dir = await materialize("ts-lib-vitest", { git: true });
    await writeFile(join(dir, "src/util/legacy.ts"), "export const legacy = 1;\n");
    await commitAll(dir, "legacy file");

    await writeConfig(dir, [
      {
        name: "index shape",
        run: [
          "test -x bin/run.sh",
          "test -L link-to-strings",
          "test -f src/util/current.ts",
          "test ! -e src/util/legacy.ts",
          'node -e \'const b=require("node:fs").readFileSync("asset.bin");process.exit(b.length===4&&b[3]===255?0:1)\'',
        ].join(" && "),
      },
    ]);
    git(dir, "add", "smarttest.config.json");
    await commitAll(dir, "checks");

    // Stage: an executable, a symlink, a binary and a rename.
    await mkdir(join(dir, "bin"), { recursive: true });
    await writeFile(join(dir, "bin/run.sh"), "#!/bin/sh\necho staged\n");
    await chmod(join(dir, "bin/run.sh"), 0o755);
    await symlink("src/util/strings.ts", join(dir, "link-to-strings"));
    await writeFile(join(dir, "asset.bin"), Buffer.from([0, 1, 2, 255]));
    await rename(join(dir, "src/util/legacy.ts"), join(dir, "src/util/current.ts"));
    git(dir, "add", "-A");

    // Then disturb every one of them in the working tree.
    await chmod(join(dir, "bin/run.sh"), 0o644);
    await rm(join(dir, "link-to-strings"));
    await writeFile(join(dir, "link-to-strings"), "not a link\n");
    await writeFile(join(dir, "asset.bin"), Buffer.from([9, 9, 9, 9]));
    await rename(join(dir, "src/util/current.ts"), join(dir, "src/util/legacy.ts"));

    const result = await (await SmartTest.open({ root: dir })).runHook("pre-commit", {
      cache: false,
    });
    expect(result.checks.map((c) => [c.name, c.status])).toEqual([["index shape", "passed"]]);
  }, 120_000);

  it("materializes file/directory replacements before overlaying the index", async () => {
    const dir = await materialize("ts-lib-vitest", { git: true });
    await writeFile(join(dir, "shape"), "same content\n");
    await mkdir(join(dir, "other/deep"), { recursive: true });
    await writeFile(join(dir, "other/deep/child"), "other content\n");
    await commitAll(dir, "old shapes");
    await rm(join(dir, "shape"));
    await mkdir(join(dir, "shape"));
    await writeFile(join(dir, "shape/child"), "same content\n");
    await rm(join(dir, "other"), { recursive: true });
    await writeFile(join(dir, "other"), "other content\n");
    await writeConfig(dir, [{ name: "shapes", run: "test -f shape/child && test -f other" }]);
    git(dir, "add", "-A");
    await writeFile(join(dir, "dirty.md"), "force isolation\n");
    const before = git(dir, "diff", "--cached", "--binary");
    const result = await (await SmartTest.open({ root: dir })).runHook("pre-commit", {
      cache: false,
    });
    expect(result.outcome?.exitCode).toBe(0);
    expect(result.checks.map((c) => c.status)).toEqual(["passed"]);
    expect(git(dir, "diff", "--cached", "--binary")).toBe(before);
    expect(git(dir, "worktree", "list").trim().split("\n")).toHaveLength(1);
  }, 120_000);

  it("isolates staged content when the repository has no commits yet", async () => {
    const dir = await materialize("ts-lib-vitest");
    await init(dir);
    expect(spawnSync("git", ["rev-parse", "--verify", "HEAD"], { cwd: dir }).status).not.toBe(0);
    await writeConfig(dir, [{ name: "unborn", run: "grep -q UNBORN_MARKER notes.md" }]);
    await writeFile(join(dir, "notes.md"), "UNBORN_MARKER\n");
    git(dir, "add", "-A");
    await rm(join(dir, "notes.md"));

    const result = await (await SmartTest.open({ root: dir })).runHook("pre-commit", {
      cache: false,
    });
    expect(result.outcome?.exitCode).toBe(0);
    expect(result.checks.map((c) => c.status)).toEqual(["passed"]);
    expect(git(dir, "status", "--porcelain", "notes.md")).toBe("AD notes.md\n");
  }, 120_000);
});

describe("pre-push runs the commits being pushed", () => {
  it("compares against the whole unpushed history, not only the previous commit", async () => {
    const dir = await materialize("ts-lib-vitest", { git: true });
    // The failure is in an earlier unpushed commit; the last commit only touches notes.
    await edit(dir, stringsTest, 'toBe("Ada")', 'toBe("Adah")');
    await commitAll(dir, "broken earlier");
    await writeFile(join(dir, "notes.md"), "unrelated\n");
    await commitAll(dir, "later, unrelated");

    const result = await (await SmartTest.open({ root: dir })).runHook("pre-push", {
      cache: false,
    });
    expect(result.outcome?.report.decision.selectedTests.map((t) => t.filePath)).toContain(
      stringsTest,
    );
    expect(result.outcome?.exitCode).not.toBe(0);
    expect(result.outcome?.report.summary.failed).toBeGreaterThan(0);
  }, 120_000);

  it("fails on a committed failure even when the working tree fixed it", async () => {
    const dir = await materialize("ts-lib-vitest", { git: true });
    await edit(dir, stringsTest, 'toBe("Ada")', 'toBe("Adah")');
    await commitAll(dir, "broken");
    await writeFile(
      join(dir, stringsTest),
      (await readFile(join(dir, stringsTest), "utf8")).replace('toBe("Adah")', 'toBe("Ada")'),
    );

    const result = await (await SmartTest.open({ root: dir })).runHook("pre-push", {
      cache: false,
    });
    expect(result.outcome?.exitCode).not.toBe(0);
    expect(result.outcome?.report.summary.failed).toBeGreaterThan(0);
  }, 120_000);

  it("passes for committed fixes even when the working tree is dirty and broken", async () => {
    const dir = await materialize("ts-lib-vitest", { git: true });
    await edit(dir, stringsTest, 'toBe("Ada")', 'toBe("Adah")');
    await commitAll(dir, "broken");
    await writeFile(
      join(dir, stringsTest),
      (await readFile(join(dir, stringsTest), "utf8")).replace('toBe("Adah")', 'toBe("Ada")'),
    );
    await commitAll(dir, "fix");
    await edit(dir, stringsTest, 'toBe("Ada")', 'toBe("Adah")');

    const result = await (await SmartTest.open({ root: dir })).runHook("pre-push", {
      cache: false,
    });
    expect(result.outcome?.exitCode).toBe(0);
    expect(result.outcome?.report.summary.failed).toBe(0);
  }, 120_000);
});

describe("hook records", () => {
  it("records a bypass without running tests or checks", async () => {
    const dir = await materialize("ts-lib-vitest", { git: true });
    await writeConfig(dir, [{ name: "always fails", run: "exit 1" }]);
    await commitAll(dir, "config");
    process.env.SMARTTEST_SKIP = "1";

    const st = await SmartTest.open({ root: dir });
    const result = await st.runHook("pre-commit", { cache: false });
    expect(result.skipped).toBe(true);
    expect(result.checks).toEqual([]);
    const history = await st.hookHistory();
    expect(history.bypasses.at(-1)?.reason).toBe("SMARTTEST_SKIP=1");
  }, 120_000);
});

describe("hook setup findings", () => {
  const hookBlock = (stage: "pre-commit" | "pre-push") =>
    [
      "# >>> smarttest >>>",
      "if [ -x node_modules/.bin/smarttest ]; then",
      `  smarttest run ${stage === "pre-commit" ? "--staged" : "--push"} --hook || exit 1`,
      "fi",
      "# <<< smarttest <<<",
      "",
    ].join("\n");

  it("plans install for either stage and uninstalls stages independently", async () => {
    const dir = await materialize("ts-lib-vitest", { git: true });
    const st = await SmartTest.open({ root: dir });
    const pre = await st.hookInstallPlan({ stage: "pre-commit", replace: true });
    const push = await st.hookInstallPlan({ stage: "pre-push", replace: true });
    expect(pre.stage).toBe("pre-commit");
    expect(push.stage).toBe("pre-push");
    expect(push.plan.after).toContain("smarttest run --push --hook");

    await mkdir(join(dir, ".git/hooks"), { recursive: true });
    await writeFile(join(dir, ".git/hooks/pre-commit"), hookBlock("pre-commit"), { mode: 0o755 });
    await writeFile(join(dir, ".git/hooks/pre-push"), hookBlock("pre-push"), { mode: 0o755 });

    const onlyPush = await st.hookUninstallPlan(undefined, ["pre-push"]);
    expect(onlyPush.map((p) => p.path)).toEqual([".git/hooks/pre-push"]);
    const both = await st.hookUninstallPlan();
    expect(new Set(both.map((p) => p.path))).toEqual(
      new Set([".git/hooks/pre-commit", ".git/hooks/pre-push"]),
    );
  }, 120_000);

  it("doctor reports both stages and leftover whole-suite steps", async () => {
    const dir = await materialize("ts-lib-vitest", { git: true });
    await mkdir(join(dir, ".git/hooks"), { recursive: true });
    await writeFile(
      join(dir, ".git/hooks/pre-commit"),
      `${hookBlock("pre-commit")}${hookBlock("pre-commit")}npx vitest run\n`,
      { mode: 0o755 },
    );
    const st = await SmartTest.open({ root: dir });
    const hook = (await st.doctor()).filter((f) => f.check === "hook");
    const text = hook.map((f) => f.message).join("\n");
    expect(text).toContain("pre-commit hook installed");
    expect(text).toContain("pre-push hook not installed");
    expect(text).toContain("runs SmartTest 2 times");
    expect(text).toContain("whole-suite step");
    expect(
      hook.every(
        (f) => f.severity !== "error" || f.message.includes("node_modules/.bin/smarttest"),
      ),
    ).toBe(true);
  }, 120_000);
});

describe("configuration inside the checkout", () => {
  it("follows a staged switch from smarttest.config.ts to JSON", async () => {
    const dir = await materialize("ts-lib-vitest", { git: true });
    const tsConfig = 'export default { hook: { checks: [{ name: "head", run: "true" }] } };\n';
    await writeFile(join(dir, "smarttest.config.ts"), tsConfig);
    await commitAll(dir, "TypeScript config");

    // Stage: delete the .ts config and add a JSON config whose check fails.
    await rm(join(dir, "smarttest.config.ts"));
    await writeConfig(dir, [{ name: "staged json", run: "exit 1" }]);
    git(dir, "add", "-A");
    // The dirty working-tree .ts config would pass if it were the one loaded.
    await writeFile(join(dir, "smarttest.config.ts"), tsConfig);

    const result = await (await SmartTest.open({ root: dir })).runHook("pre-commit", {
      cache: false,
    });
    expect(result.outcome?.exitCode).toBe(0);
    expect(result.checks.map((c) => [c.name, c.status])).toEqual([["staged json", "failed"]]);
  }, 120_000);

  it("does not load a staged-deleted config from the working tree", async () => {
    const dir = await materialize("ts-lib-vitest", { git: true });
    const failing =
      'export default { hook: { checks: [{ name: "head fails", run: "exit 1" }] } };\n';
    await writeFile(join(dir, "smarttest.config.ts"), failing);
    await commitAll(dir, "failing config");

    git(dir, "rm", "-q", "smarttest.config.ts");
    await writeFile(join(dir, "smarttest.config.ts"), failing);

    const result = await (await SmartTest.open({ root: dir })).runHook("pre-commit", {
      cache: false,
    });
    expect(result.outcome?.exitCode).toBe(0);
    expect(result.checks).toEqual([]);
  }, 120_000);
});

describe("pre-push refs", () => {
  const ref = (localSha: string) => ({
    localRef: "refs/heads/other",
    localSha,
    remoteRef: "refs/heads/other",
    remoteSha: "0000000000000000000000000000000000000000",
  });

  it.each(["known", "unknown", "multiple"])(
    "uses %s remote bases instead of upstream",
    async (kind) => {
      const dir = await materialize("ts-lib-vitest", { git: true });
      const base = git(dir, "rev-parse", "HEAD").trim();
      await edit(dir, stringsTest, 'toBe("Ada")', 'toBe("Adah")');
      await commitAll(dir, "broken");
      const head = git(dir, "rev-parse", "HEAD").trim();
      git(dir, "branch", "upstream");
      git(dir, "branch", "--set-upstream-to=upstream", "main");
      const refs =
        kind === "multiple"
          ? [
              { ...ref(head), remoteSha: head },
              { ...ref(head), remoteRef: "refs/heads/second", remoteSha: base },
            ]
          : [{ ...ref(head), remoteSha: kind === "known" ? base : "1".repeat(40) }];
      const result = await (await SmartTest.open({ root: dir })).runHook("pre-push", {
        cache: false,
        refs,
      });
      expect(result.outcome?.report.decision.selectedTests.map((t) => t.filePath)).toContain(
        stringsTest,
      );
      expect(result.outcome?.report.summary.failed).toBeGreaterThan(0);
    },
    120_000,
  );

  it("refuses to pass when the push sends a commit other than HEAD", async () => {
    const dir = await materialize("ts-lib-vitest", { git: true });
    await writeFile(join(dir, "notes.md"), "later\n");
    await commitAll(dir, "later");
    const old = git(dir, "rev-parse", "HEAD^").trim();

    const st = await SmartTest.open({ root: dir });
    await expect(st.runHook("pre-push", { cache: false, refs: [ref(old)] })).rejects.toMatchObject({
      code: "ST_HOOK_PUSH_REF_UNSUPPORTED",
      category: "usage",
    });
    expect((await st.hookHistory()).runs).toBe(0);
  }, 120_000);

  it("runs when every pushed ref points at HEAD", async () => {
    const dir = await materialize("ts-lib-vitest", { git: true });
    const head = git(dir, "rev-parse", "HEAD").trim();
    const result = await (await SmartTest.open({ root: dir })).runHook("pre-push", {
      cache: false,
      refs: [ref(head)],
    });
    expect(result.outcome?.exitCode).toBe(0);
  }, 120_000);
});

const core = pathToFileURL(resolve(import.meta.dirname, "../packages/core/dist/index.js")).href;

/** Installs a shell hook that runs the compiled core API, exactly as the CLI hook does. */
async function installRealHook(dir: string, stage: "pre-commit" | "pre-push"): Promise<void> {
  const wrapperDir = await mkdtemp(join(tmpdir(), "st-hook-"));
  const wrapper = join(wrapperDir, "hook.mjs");
  await writeFile(
    wrapper,
    `const { SmartTest } = await import(${JSON.stringify(core)});
try {
  const st = await SmartTest.open({ root: process.cwd() });
  const r = await st.runHook(${JSON.stringify(stage)}, { cache: false });
  if (r.skipped || r.nothingPushed) process.exit(0);
  if (r.checks.some((c) => c.status === "failed")) process.exit(1);
  process.exit(r.outcome?.exitCode ?? 1);
} catch (error) {
  console.error(error?.code ?? error?.message ?? String(error));
  process.exit(1);
}
`,
  );
  await mkdir(join(dir, ".git/hooks"), { recursive: true });
  await writeFile(
    join(dir, `.git/hooks/${stage}`),
    `#!/bin/sh\nexec node ${JSON.stringify(wrapper)} "$@"\n`,
    { mode: 0o755 },
  );
  git(dir, "config", "core.hooksPath", join(dir, ".git/hooks"));
}

describe("a real pre-push hook", () => {
  async function setup(): Promise<{ dir: string; remote: string }> {
    const dir = await materialize("ts-lib-vitest", { git: true });
    const remote = join(await mkdtemp(join(tmpdir(), "st-remote-")), "remote.git");
    git(dir, "init", "--bare", "-q", remote);
    git(dir, "remote", "add", "origin", remote);
    await installRealHook(dir, "pre-push");
    return { dir, remote };
  }

  const push = (dir: string, ...refspec: string[]) =>
    spawnSync("git", ["push", "origin", ...refspec], {
      cwd: dir,
      encoding: "utf8",
      env: process.env,
    });

  it("runs the hook and accepts a push of HEAD", async () => {
    const { dir, remote } = await setup();
    const result = push(dir, "main");
    expect(result.status, result.stderr).toBe(0);
    expect(git(remote, "rev-parse", "main").trim()).toBe(git(dir, "rev-parse", "HEAD").trim());
    expect((await (await SmartTest.open({ root: dir })).hookHistory()).runs).toBe(1);
  }, 120_000);

  it.each([false, true])(
    "checks a new target despite upstream equalling HEAD (isolated=%s)",
    async (isolated) => {
      const { dir, remote } = await setup();
      await edit(dir, stringsTest, 'toBe("Ada")', 'toBe("Adah")');
      git(dir, "add", "-A");
      git(dir, "-c", "core.hooksPath=/dev/null", "commit", "-m", "bypassed broken test");
      git(dir, "-c", "core.hooksPath=/dev/null", "push", "-u", "origin", "main");
      expect(git(dir, "rev-parse", "@{upstream}").trim()).toBe(
        git(dir, "rev-parse", "HEAD").trim(),
      );
      if (isolated) await edit(dir, stringsTest, 'toBe("Adah")', 'toBe("Ada")');
      const result = push(dir, "HEAD:refs/heads/new-target");
      expect(result.status, result.stderr).not.toBe(0);
      expect(
        spawnSync("git", ["--git-dir", remote, "rev-parse", "--verify", "refs/heads/new-target"])
          .status,
      ).not.toBe(0);
      const records = JSON.parse(await readFile(join(dir, ".smarttest/state/hooks.json"), "utf8"));
      expect(records.runs.at(-1).selected).toBeGreaterThan(0);
      expect(records.runs.at(-1).passed).toBe(false);
    },
    120_000,
  );

  it("runs the committed content and rejects a failing push", async () => {
    const { dir, remote } = await setup();
    expect(push(dir, "main").status).toBe(0);
    await edit(dir, stringsTest, 'toBe("Ada")', 'toBe("Adah")');
    await commitAll(dir, "broken");
    const failed = push(dir, "main");
    expect(failed.status).not.toBe(0);
    // The remote was not updated: the hook tested the commit and refused it.
    expect(git(remote, "rev-parse", "main").trim()).not.toBe(git(dir, "rev-parse", "HEAD").trim());
  }, 120_000);

  it("rejects a push that sends a non-HEAD ref without testing anything", async () => {
    const { dir, remote } = await setup();
    expect(push(dir, "main").status).toBe(0);
    await writeFile(join(dir, "notes.md"), "later\n");
    await commitAll(dir, "later");
    const old = git(dir, "rev-parse", "HEAD^").trim();
    git(dir, "branch", "other", old);

    const result = push(dir, `other:refs/heads/other`);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("ST_HOOK_PUSH_REF_UNSUPPORTED");
    expect(
      spawnSync("git", ["--git-dir", remote, "rev-parse", "--verify", "refs/heads/other"]).status,
    ).not.toBe(0);
    // The rejected ref was never tested.
    expect((await (await SmartTest.open({ root: dir })).hookHistory()).runs).toBe(1);
  }, 120_000);
});

describe("a real pre-commit hook with an alternate index", () => {
  it("strips the hook's Git env from the isolated engine and its tests", async () => {
    const dir = await materialize("ts-lib-vitest", { git: true });
    await installRealHook(dir, "pre-commit");

    // Git is told to commit from an absolute alternate index. The hook inherits it.
    const alt = join(await mkdtemp(join(tmpdir(), "st-alt-index-")), "index");
    await copyFile(join(dir, ".git/index"), alt);
    const env = {
      ...process.env,
      GIT_INDEX_FILE: alt,
      SMARTTEST_TEST_ALT_INDEX: alt,
    };
    const testFile = "test/hook-env.test.ts";
    await writeFile(
      join(dir, testFile),
      `import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

it("does not inherit the pre-commit Git environment", () => {
  expect(process.env.GIT_INDEX_FILE).toBeUndefined();
  expect(process.env.GIT_DIR).toBeUndefined();
  expect(process.env.GIT_WORK_TREE).toBeUndefined();
  const top = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  expect(top).toContain("smarttest-hook-");
  const index = execFileSync("git", ["rev-parse", "--git-path", "index"], {
    encoding: "utf8",
  }).trim();
  expect(index).not.toBe(process.env.SMARTTEST_TEST_ALT_INDEX);
});
`,
    );
    const added = spawnSync("git", ["add", testFile], { cwd: dir, encoding: "utf8", env });
    expect(added.status, added.stderr).toBe(0);
    // An unstaged edit forces the hook to use a temporary checkout.
    await writeFile(join(dir, "notes.md"), "dirty\n");

    const commit = spawnSync("git", ["commit", "-m", "hook env"], {
      cwd: dir,
      encoding: "utf8",
      env,
    });
    expect(commit.status, commit.stderr).toBe(0);
    expect(git(dir, "log", "-1", "--format=%s").trim()).toBe("hook env");
    expect((await (await SmartTest.open({ root: dir })).hookHistory()).runs).toBe(1);
    const records = JSON.parse(
      await readFile(join(dir, ".smarttest/state/hooks.json"), "utf8"),
    ) as { runs: { selected: number; passed: boolean }[] };
    expect(records.runs.at(-1)?.passed).toBe(true);
    // The hook executed the staged test that inspects its environment.
    expect(records.runs.at(-1)?.selected).toBeGreaterThan(0);
  }, 120_000);
});

/**
 * A pnpm-style workspace whose app imports `@demo/core-lib` through a real node_modules
 * directory (`node_modules/@demo/core-lib -> ../../packages/core-lib`), with no alias.
 */
async function linkedWorkspace(): Promise<string> {
  const dir = await materialize("pnpm-monorepo");
  const installed = join(FIXTURES, "pnpm-monorepo", "node_modules");
  await rm(join(dir, "node_modules"));
  await mkdir(join(dir, "node_modules/@demo"), { recursive: true });
  for (const entry of ["vitest", ".bin"])
    await symlink(join(installed, entry), join(dir, "node_modules", entry));
  await symlink("../../packages/core-lib", join(dir, "node_modules/@demo/core-lib"));
  await writeFile(
    join(dir, "vitest.config.ts"),
    'import { defineConfig } from "vitest/config";\nexport default defineConfig({ test: { include: ["packages/*/test/**/*.test.ts"] } });\n',
  );
  await edit(dir, "packages/core-lib/package.json", "./dist/index.js", "./src/index.ts");
  // Only the app's test reaches core-lib, through the workspace link.
  await rm(join(dir, "packages/core-lib/test/price.test.ts"));
  await writeFile(join(dir, ".gitignore"), "node_modules\n.smarttest/\n");
  git(dir, "init", "-q", "-b", "main");
  await commitAll(dir, "initial");
  return dir;
}

describe("the temporary checkout is the content under test", () => {
  it("resolves workspace packages to the staged content, not the working tree", async () => {
    const dir = await linkedWorkspace();
    const price = "packages/core-lib/src/price.ts";
    const original = await readFile(join(dir, price), "utf8");
    await edit(dir, price, "VAT = 0.2", "VAT = 0.5");
    git(dir, "add", price);
    // The unstaged revert would make the app's test pass if it leaked into the run.
    await writeFile(join(dir, price), original);

    const result = await (await SmartTest.open({ root: dir })).runHook("pre-commit", {
      cache: false,
    });
    expect(result.outcome?.report.decision.selectedTests.map((t) => t.filePath)).toContain(
      "packages/app/test/checkout.test.ts",
    );
    expect(result.outcome?.exitCode).not.toBe(0);
    expect(result.outcome?.report.summary.failed).toBeGreaterThan(0);
  }, 120_000);

  it("reports a link from pnpm's store into the working tree", async () => {
    const dir = await linkedWorkspace();
    // An installed package depending on the workspace package: pnpm links it inside its store.
    const nested = join(dir, "node_modules/.pnpm/consumer@1.0.0/node_modules/@demo");
    await mkdir(nested, { recursive: true });
    await symlink("../../../../../packages/core-lib", join(nested, "core-lib"));
    await edit(dir, "packages/core-lib/src/price.ts", "VAT = 0.2", "VAT = 0.25");
    git(dir, "add", "packages/core-lib/src/price.ts");
    await writeFile(join(dir, "notes.md"), "force isolation\n");

    const result = await (await SmartTest.open({ root: dir })).runHook("pre-commit", {
      cache: false,
    });
    expect(result.outcome?.report.warnings.join("\n")).toContain(
      "installed packages in node_modules/.pnpm link to the working tree's packages/core-lib",
    );
  }, 120_000);

  it("lets Vite load an installed package's file by URL in the checkout", async () => {
    // A real node_modules (not a link to the fixture's): the package is inside the project.
    const dir = await materialize("ts-lib-vitest");
    await rm(join(dir, "node_modules"));
    await mkdir(join(dir, "node_modules/asset-pkg"), { recursive: true });
    for (const entry of ["vitest", ".bin"])
      await symlink(
        join(FIXTURES, "ts-lib-vitest/node_modules", entry),
        join(dir, "node_modules", entry),
      );
    await writeFile(join(dir, "node_modules/asset-pkg/package.json"), '{"name":"asset-pkg"}\n');
    await writeFile(join(dir, "node_modules/asset-pkg/greeting.txt"), "hello\n");
    // Vite checks file access for the browser-like transform that DOM environments use.
    await mkdir(join(dir, "node_modules/vitest-environment-client"));
    await writeFile(
      join(dir, "node_modules/vitest-environment-client/package.json"),
      '{"name":"vitest-environment-client","type":"module","main":"index.js"}\n',
    );
    await writeFile(
      join(dir, "node_modules/vitest-environment-client/index.js"),
      'export default { name: "client", viteEnvironment: "client", setup: () => ({ teardown() {} }) };\n',
    );
    await writeFile(join(dir, ".gitignore"), "node_modules\n.smarttest/\n");
    git(dir, "init", "-q", "-b", "main");
    await commitAll(dir, "initial");
    await writeFile(
      join(dir, "test/asset.test.ts"),
      // The docblock is split so this suite's own runner does not read it.
      `// @vitest-${"environment"} client\nimport greeting from "asset-pkg/greeting.txt?raw";\nimport { expect, it } from "vitest";\nit("reads the asset", () => expect(greeting).toBe("hello\\n"));\n`,
    );
    git(dir, "add", "test/asset.test.ts");
    await writeFile(join(dir, "notes.md"), "force isolation\n");

    const result = await (await SmartTest.open({ root: dir })).runHook("pre-commit", {
      cache: false,
    });
    const asset = result.outcome?.report.executions.find((e) => e.file === "test/asset.test.ts");
    expect(asset?.status, JSON.stringify(asset)).toBe("passed");
  }, 120_000);

  it("gives the checkout an index matching the staged tree", async () => {
    const dir = await materialize("ts-lib-vitest", { git: true });
    await writeConfig(dir, [
      {
        name: "index",
        run: "git diff --cached --name-only | grep -qx notes.md && git diff --quiet",
      },
    ]);
    await commitAll(dir, "config");
    await writeFile(join(dir, "notes.md"), "staged\n");
    git(dir, "add", "notes.md");
    await writeFile(join(dir, "notes.md"), "unstaged\n");

    const result = await (await SmartTest.open({ root: dir })).runHook("pre-commit", {
      cache: false,
    });
    expect(result.outcome?.report.warnings.join("\n")).toContain("temporary checkout");
    expect(result.checks.map((c) => [c.name, c.status, c.output])).toEqual([
      ["index", "passed", undefined],
    ]);
  }, 120_000);

  it("does not run the user's post-checkout hook", async () => {
    const dir = await materialize("ts-lib-vitest", { git: true });
    const marker = join(await mkdtemp(join(tmpdir(), "st-post-checkout-")), "ran");
    await writeFile(join(dir, ".git/hooks/post-checkout"), `#!/bin/sh\npwd >> "${marker}"\n`, {
      mode: 0o755,
    });
    await edit(dir, stringsTest, 'toBe("Ada")', 'toBe("Adah")');
    git(dir, "add", stringsTest);
    await writeFile(join(dir, "notes.md"), "force isolation\n");

    const result = await (await SmartTest.open({ root: dir })).runHook("pre-commit", {
      cache: false,
    });
    expect(result.outcome?.report.summary.failed).toBeGreaterThan(0);
    expect(await readFile(marker, "utf8").catch(() => "")).toBe("");
  }, 120_000);

  it("removes checkouts abandoned by a killed run, and keeps a live run's", async () => {
    const dir = await materialize("ts-lib-vitest", { git: true });
    const fake = async (pid: number) => {
      const tmp = await mkdtemp(join(tmpdir(), "smarttest-hook-"));
      git(dir, "worktree", "add", "-q", "--detach", join(tmp, "repo"), "HEAD");
      await writeFile(join(tmp, "owner"), `${pid}\n`);
      return tmp;
    };
    const dead = spawnSync(process.execPath, ["-e", ""]).pid as number;
    const stale = await fake(dead);
    const live = await fake(process.pid);
    // Registered, but its directory is already gone.
    const gone = await fake(dead);
    await rm(gone, { recursive: true, force: true });
    // The user's own worktree on a drive that is not mounted right now: never forgotten.
    const unmounted = join(await mkdtemp(join(tmpdir(), "st-user-wt-")), "feature");
    git(dir, "worktree", "add", "-q", "--detach", unmounted, "HEAD");
    await rm(unmounted, { recursive: true, force: true });

    await writeFile(join(dir, "notes.md"), "staged\n");
    git(dir, "add", "notes.md");
    await writeFile(join(dir, "notes.md"), "unstaged\n");
    await (await SmartTest.open({ root: dir })).runHook("pre-commit", { cache: false });

    const list = git(dir, "worktree", "list", "--porcelain");
    expect(list).not.toContain(stale);
    expect(list).not.toContain(gone);
    expect(list).toContain(live);
    expect(list).toContain(unmounted);
    expect(existsSync(stale)).toBe(false);
    git(dir, "worktree", "remove", "--force", join(live, "repo"));
  }, 120_000);
});

describe("project checks in a workspace", () => {
  it("runs a check scoped to a workspace package and reports an unknown project", async () => {
    const dir = await materialize("pnpm-monorepo", { git: true });
    await writeFile(
      join(dir, "smarttest.config.json"),
      `${JSON.stringify({
        hook: {
          checks: [
            { name: "app", run: "test -f package.json && pwd", projects: ["./packages/app/"] },
            { name: "typo", run: "true", projects: ["packages/ap"] },
          ],
        },
      })}\n`,
    );
    await commitAll(dir, "config");
    await edit(dir, "packages/app/src/banner.ts", "today", "only today");
    git(dir, "add", "-A");

    const result = await (await SmartTest.open({ root: dir })).runHook("pre-commit", {
      cache: false,
    });
    expect(result.checks.map((c) => [c.name, c.project, c.status])).toEqual([
      ["app", "packages/app", "passed"],
    ]);
    expect(result.warnings.join("\n")).toContain('"packages/ap"');
  }, 120_000);
});

describe("a push that only deletes refs", () => {
  it("runs no tests, exits 0 and records it", async () => {
    const dir = await materialize("ts-lib-vitest", { git: true });
    await edit(dir, stringsTest, 'toBe("Ada")', 'toBe("Adah")');
    await commitAll(dir, "broken");
    const st = await SmartTest.open({ root: dir });
    const result = await st.runHook("pre-push", {
      cache: false,
      refs: [
        {
          localRef: "(delete)",
          localSha: "0".repeat(40),
          remoteRef: "refs/heads/feature",
          remoteSha: git(dir, "rev-parse", "HEAD").trim(),
        },
      ],
    });
    expect(result.nothingPushed).toBe(true);
    expect(result.outcome).toBeUndefined();
    const records = JSON.parse(await readFile(join(dir, ".smarttest/state/hooks.json"), "utf8"));
    expect(records.runs.at(-1)).toMatchObject({ selected: 0, nothingPushed: true });
  }, 120_000);

  it("lets a real `git push --delete` through although the history has a failing test", async () => {
    const dir = await materialize("ts-lib-vitest", { git: true });
    const remote = join(await mkdtemp(join(tmpdir(), "st-remote-")), "remote.git");
    git(dir, "init", "--bare", "-q", remote);
    git(dir, "remote", "add", "origin", remote);
    await edit(dir, stringsTest, 'toBe("Ada")', 'toBe("Adah")');
    await commitAll(dir, "broken");
    git(dir, "push", "-q", "origin", "HEAD:refs/heads/feature");
    await installRealHook(dir, "pre-push");

    const r = spawnSync("git", ["push", "origin", "--delete", "feature"], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(r.status, r.stderr).toBe(0);
    expect(
      spawnSync("git", ["--git-dir", remote, "rev-parse", "--verify", "refs/heads/feature"]).status,
    ).not.toBe(0);
  }, 120_000);
});

describe("a hook run that is terminated", () => {
  const bin = resolve(import.meta.dirname, "../packages/cli/dist/bin.js");

  it.each(["SIGTERM", "SIGHUP"] as const)(
    "removes its temporary checkout on %s",
    async (signal) => {
      const dir = await materialize("ts-lib-vitest", { git: true });
      await writeFile(
        join(dir, "test/slow.test.ts"),
        'import { it } from "vitest";\nit("waits", () => new Promise((r) => setTimeout(r, 60_000)), 90_000);\n',
      );
      git(dir, "add", "test/slow.test.ts");
      await writeFile(join(dir, "notes.md"), "force isolation\n");

      const child = spawn(process.execPath, [bin, "run", "--staged", "--hook", "--no-cache"], {
        cwd: dir,
        stdio: "ignore",
      });
      const exited = new Promise<number | null>((done) => child.on("exit", (code) => done(code)));
      const deadline = Date.now() + 60_000;
      while (git(dir, "worktree", "list").trim().split("\n").length < 2) {
        if (Date.now() > deadline) throw new Error("the hook never created its checkout");
        await new Promise((r) => setTimeout(r, 100));
      }
      const checkout = git(dir, "worktree", "list", "--porcelain")
        .split("\n")
        .filter((l) => l.startsWith("worktree "))
        .map((l) => l.slice("worktree ".length))
        .find((p) => p.includes("smarttest-hook-")) as string;
      // Let the runner start, then end the hook the way a closing terminal or CI would.
      await new Promise((r) => setTimeout(r, 1_500));
      child.kill(signal);
      expect(await exited).not.toBe(0);
      expect(git(dir, "worktree", "list").trim().split("\n")).toHaveLength(1);
      expect(existsSync(checkout)).toBe(false);
    },
    120_000,
  );
});
