import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type HookStage, planHookInstall, planHookUninstall } from "./hooks.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
// The suite can run inside this repository's own hooks; each fixture is an ordinary shell.
beforeEach(() => {
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_PREFIX"])
    vi.stubEnv(key, undefined);
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );

async function repo(files: Record<string, string> = {}): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "st-hooks-unit-")));
  roots.push(dir);
  git(dir, "init", "-q", "-b", "main");
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), text);
  }
  return dir;
}

/**
 * A stand-in for `npx` that records what SmartTest would have received: its directory and stdin.
 * The block only runs it when `node_modules/.bin/smarttest` exists in the project.
 */
async function fakeSmartTest(project: string, exit = 0) {
  const bin = await mkdtemp(join(tmpdir(), "st-fake-npx-"));
  roots.push(bin);
  const log = join(bin, "log");
  await writeFile(
    join(bin, "npx"),
    `#!/bin/sh\npwd > "${log}.pwd"\ncat > "${log}.stdin"\nexit ${exit}\n`,
    { mode: 0o755 },
  );
  await mkdir(join(project, "node_modules/.bin"), { recursive: true });
  await writeFile(join(project, "node_modules/.bin/smarttest"), "#!/bin/sh\n", { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  return {
    env,
    pwd: async () => (await readFile(`${log}.pwd`, "utf8").catch(() => "")).trim(),
    stdin: () => readFile(`${log}.stdin`, "utf8").catch(() => undefined),
  };
}

async function install(root: string, stage: HookStage = "pre-commit") {
  const plan = await planHookInstall(root, { stage });
  await mkdir(dirname(join(root, plan.file)), { recursive: true });
  await writeFile(join(root, plan.file), plan.plan.after as string);
  await chmod(join(root, plan.file), 0o755);
  return plan;
}

const REFS =
  "refs/heads/main 1111111111111111111111111111111111111111 refs/heads/protected 2222222222222222222222222222222222222222\n";

const guard = `#!/bin/sh
while read local_ref local_sha remote_ref remote_sha; do
  if [ "$remote_ref" = "refs/heads/protected" ]; then
    echo "refusing to push to protected" >&2
    exit 1
  fi
done
exit 0
`;

describe("pre-push stdin", () => {
  it("passes the refs to SmartTest and still gives them to the user's guard", async () => {
    const root = await repo({ "package.json": "{}", ".git/hooks/pre-push": guard });
    const fake = await fakeSmartTest(root);
    const plan = await install(root, "pre-push");
    expect(plan.file).toBe(".git/hooks/pre-push");

    const refused = spawnSync("sh", [plan.file], { cwd: root, input: REFS, env: fake.env });
    expect(refused.status).toBe(1);
    expect(refused.stderr.toString()).toContain("refusing to push to protected");
    expect(await fake.stdin()).toBe(REFS);

    const allowed = spawnSync("sh", [plan.file], {
      cwd: root,
      input: REFS.replace("protected", "feature"),
      env: fake.env,
    });
    expect(allowed.status).toBe(0);
  });

  it("fails the hook when SmartTest fails, before the user's steps", async () => {
    const root = await repo({ "package.json": "{}", ".git/hooks/pre-push": guard });
    const fake = await fakeSmartTest(root, 1);
    const plan = await install(root, "pre-push");
    const r = spawnSync("sh", [plan.file], { cwd: root, input: REFS, env: fake.env });
    expect(r.status).toBe(1);
    expect(r.stderr.toString()).not.toContain("refusing");
  });

  it("upgrades a block that consumed stdin", async () => {
    const old = [
      "#!/bin/sh",
      "# >>> smarttest >>>",
      "if [ -x node_modules/.bin/smarttest ]; then",
      "  npx --no-install smarttest run --push --hook || exit 1",
      "fi",
      "# <<< smarttest <<<",
      ...guard.split("\n").slice(1),
    ].join("\n");
    const root = await repo({ "package.json": "{}", ".git/hooks/pre-push": old });
    const plan = await planHookInstall(root, { stage: "pre-push" });
    expect(plan.installed).toBe(true);
    expect(plan.plan.action).toBe("modify");
    expect(plan.plan.after).toContain("smarttest_refs=$(cat)");
    await writeFile(join(root, plan.file), plan.plan.after as string);
    expect((await planHookInstall(root, { stage: "pre-push" })).plan.action).toBe("skip");
  });

  it("simple-git-hooks: the existing command still reads the refs, and uninstall restores it", async () => {
    const existing = 'while read a b c d; do echo "$c" >> pushed.txt; done';
    const pkg = `${JSON.stringify({ "simple-git-hooks": { "pre-push": existing } }, null, 2)}\n`;
    const root = await repo({ "package.json": pkg });
    const fake = await fakeSmartTest(root);
    const plan = await planHookInstall(root, { stage: "pre-push" });
    const value = (JSON.parse(plan.plan.after as string) as Record<string, Record<string, string>>)[
      "simple-git-hooks"
    ]?.["pre-push"] as string;
    const r = spawnSync("sh", ["-c", value], { cwd: root, input: REFS, env: fake.env });
    expect(r.status, r.stderr.toString()).toBe(0);
    expect(await fake.stdin()).toBe(REFS);
    expect(await readFile(join(root, "pushed.txt"), "utf8")).toBe("refs/heads/protected\n");

    await writeFile(join(root, "package.json"), plan.plan.after as string);
    expect((await planHookInstall(root, { stage: "pre-push" })).plan.action).toBe("skip");
    const undo = await planHookUninstall(root, "simple-git-hooks", ["pre-push"]);
    expect(undo[0]?.after).toBe(pkg);
  });

  it("lefthook: the pre-push command asks for stdin, and uninstall removes the whole entry", async () => {
    const original = "pre-push:\n  commands:\n    lint:\n      run: npx eslint .\n";
    const root = await repo({ "lefthook.yml": original });
    const plan = await planHookInstall(root, { stage: "pre-push" });
    expect(plan.plan.after).toMatch(
      /smarttest: # smarttest\n\s+run: npx --no-install smarttest run --push --hook\n\s+use_stdin: true\n/,
    );
    await writeFile(join(root, "lefthook.yml"), plan.plan.after as string);
    const undo = await planHookUninstall(root, "lefthook", ["pre-push"]);
    expect(undo[0]?.after).toBe(original);
  });

  it("lefthook: reinstalling adds use_stdin to an entry installed without it", async () => {
    const root = await repo({
      "lefthook.yml":
        "pre-push:\n  commands:\n    smarttest: # smarttest\n      run: npx --no-install smarttest run --push --hook\n",
    });
    const plan = await planHookInstall(root, { stage: "pre-push" });
    expect(plan.plan.action).toBe("modify");
    expect(plan.plan.after).toContain("      use_stdin: true\n");
  });
});

describe("where the hook lives", () => {
  it("enters a project in a subdirectory of the repository", async () => {
    const top = await repo({ "app/package.json": "{}" });
    const app = join(top, "app");
    const fake = await fakeSmartTest(app);
    const plan = await install(app);
    expect(plan.file).toBe("../.git/hooks/pre-commit");
    // Git runs hooks at the top-level of the worktree.
    const r = spawnSync("sh", [".git/hooks/pre-commit"], { cwd: top, env: fake.env });
    expect(r.status, r.stderr.toString()).toBe(0);
    expect(await fake.pwd()).toBe(app);
  });

  it("simple-git-hooks: enters a project in a subdirectory, and uninstall restores the command", async () => {
    const existing = 'while read a b c d; do echo "$c" >> pushed.txt; done';
    const pkg = `${JSON.stringify({ "simple-git-hooks": { "pre-push": existing } }, null, 2)}\n`;
    const top = await repo({ "app/package.json": pkg });
    const app = join(top, "app");
    const fake = await fakeSmartTest(app);
    const plan = await planHookInstall(app, { stage: "pre-push" });
    const value = (JSON.parse(plan.plan.after as string) as Record<string, Record<string, string>>)[
      "simple-git-hooks"
    ]?.["pre-push"] as string;
    // simple-git-hooks runs the command at the top-level of the worktree.
    const r = spawnSync("sh", ["-c", value], { cwd: top, input: REFS, env: fake.env });
    expect(r.status, r.stderr.toString()).toBe(0);
    expect(await fake.pwd()).toBe(app);
    expect(await fake.stdin()).toBe(REFS);
    expect(await readFile(join(top, "pushed.txt"), "utf8")).toBe("refs/heads/protected\n");

    await writeFile(join(app, "package.json"), plan.plan.after as string);
    expect((await planHookInstall(app, { stage: "pre-push" })).plan.action).toBe("skip");
    const undo = await planHookUninstall(app, "simple-git-hooks", ["pre-push"]);
    expect(undo[0]?.after).toBe(pkg);
  });

  it("lefthook: says the top-level configuration is needed for a project in a subdirectory", async () => {
    const top = await repo({ "app/lefthook.yml": "pre-commit:\n  commands: {}\n" });
    const plan = await planHookInstall(join(top, "app"), { stage: "pre-commit" });
    expect(plan.notes.join("\n")).toContain("top-level of the repository");
  });

  it("installs into the shared hooks of a linked worktree, and Git runs it there", async () => {
    const main = await repo({ "package.json": "{}", "a.txt": "a\n" });
    git(main, "add", "-A");
    git(main, "commit", "-q", "-m", "init");
    const wt = join(dirname(main), `${main.split("/").pop()}-wt`);
    roots.push(wt);
    git(main, "worktree", "add", "-q", "--detach", wt);
    const fake = await fakeSmartTest(wt);
    const plan = await install(wt);
    expect(join(wt, plan.file)).toBe(join(main, ".git/hooks/pre-commit"));
    await writeFile(join(wt, "a.txt"), "b\n");
    git(wt, "add", "a.txt");
    const commit = spawnSync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "x"],
      {
        cwd: wt,
        env: fake.env,
      },
    );
    expect(commit.status, commit.stderr.toString()).toBe(0);
    expect(await fake.pwd()).toBe(wt);
  });

  it("follows an absolute core.hooksPath inside the repository", async () => {
    const root = await repo({ "package.json": "{}" });
    git(root, "config", "core.hooksPath", join(root, "tools/hooks"));
    const plan = await planHookInstall(root);
    expect(plan.file).toBe("tools/hooks/pre-commit");
    git(root, "config", "core.hooksPath", "tools/hooks2");
    expect((await planHookInstall(root)).file).toBe("tools/hooks2/pre-commit");
  });

  it("refuses a core.hooksPath outside the repository", async () => {
    const root = await repo({ "package.json": "{}" });
    const shared = await mkdtemp(join(tmpdir(), "st-shared-hooks-"));
    roots.push(shared);
    git(root, "config", "core.hooksPath", shared);
    await expect(planHookInstall(root)).rejects.toMatchObject({
      code: "ST_HOOK_PATH_OUTSIDE_REPO",
      category: "usage",
    });
  });
});

describe("existing hook scripts", () => {
  it("refuses to insert shell into a hook written in another language", async () => {
    const root = await repo({
      "package.json": "{}",
      ".git/hooks/pre-commit": "#!/usr/bin/env node\nconsole.log('lint');\n",
    });
    await expect(planHookInstall(root)).rejects.toMatchObject({ code: "ST_HOOK_NOT_SHELL" });
  });

  it.each(["#!/bin/sh", "#!/usr/bin/env bash", "#!/bin/bash -e", "#!/usr/bin/env -S zsh -e"])(
    "accepts the shell shebang %s",
    async (shebang) => {
      const root = await repo({
        "package.json": "{}",
        ".git/hooks/pre-commit": `${shebang}\necho hi\n`,
      });
      expect((await planHookInstall(root)).plan.after).toContain("# >>> smarttest >>>");
    },
  );

  it("does not take a commented-out SmartTest line for an installed hook", async () => {
    const root = await repo({
      "package.json": "{}",
      ".git/hooks/pre-commit": "#!/bin/sh\n# npx --no-install smarttest run --staged --hook\n",
    });
    const plan = await planHookInstall(root);
    expect(plan.installed).toBe(false);
    expect(plan.plan.after).toContain("# >>> smarttest >>>");
  });
});
