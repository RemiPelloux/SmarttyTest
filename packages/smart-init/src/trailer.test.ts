import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { planHookUninstall } from "./hooks.js";
import { planTrailerInstall, planTrailerUninstall } from "./trailer.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
beforeEach(() => {
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_PREFIX"])
    vi.stubEnv(key, undefined);
});

async function repo(files: Record<string, string> = {}): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "st-trailer-unit-")));
  roots.push(dir);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir, stdio: "ignore" });
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), text);
  }
  return dir;
}

/** Writes a plan's `after` the way `hook install` would. */
async function apply(root: string, path: string, after: string | undefined) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), after ?? "");
}

describe("commit trailer step", () => {
  it("husky: adds a commit-msg block that never blocks, and uninstall removes it", async () => {
    const root = await repo({
      ".husky/commit-msg": 'npx --no -- commitlint --edit "$1"\n',
      "package.json": '{ "devDependencies": { "husky": "9.0.0" } }\n',
    });
    const plan = await planTrailerInstall(root);
    expect(plan.manager).toBe("husky");
    expect(plan.file).toBe(".husky/commit-msg");
    expect(plan.plan.action).toBe("modify");
    const after = plan.plan.after ?? "";
    // The user's step stays first; SmartTest's step runs only when installed and never fails.
    expect(after.indexOf("commitlint")).toBeLessThan(after.indexOf("smarttest hook trailer"));
    expect(after).toContain('npx --no-install smarttest hook trailer "$1" || true');
    expect(after).toContain("if [ -x 'node_modules/.bin/smarttest' ]; then");
    await apply(root, plan.file, after);
    expect((await planTrailerInstall(root)).installed).toBe(true);
    const removed = await planTrailerUninstall(root);
    expect(removed.get(".husky/commit-msg")).toBe('npx --no -- commitlint --edit "$1"\n');
  });

  it("plain Git hook: created executable, before a final exit", async () => {
    const root = await repo({ ".git/hooks/commit-msg": "#!/bin/sh\necho checked\nexit 0\n" });
    const plan = await planTrailerInstall(root);
    expect(plan.manager).toBe("git");
    expect(plan.plan.mode).toBe(0o755);
    const lines = (plan.plan.after ?? "").trimEnd().split("\n");
    expect(lines.at(-1)).toBe("exit 0");
    expect(lines).toContain("# >>> smarttest trailer >>>");
    const fresh = await repo();
    const created = await planTrailerInstall(fresh);
    expect(created.plan.action).toBe("create");
    expect(created.plan.after?.startsWith("#!/bin/sh\n")).toBe(true);
  });

  it("a project in a subdirectory enters it first", async () => {
    const root = await repo({ "web/package.json": "{}\n" });
    const plan = await planTrailerInstall(join(root, "web"));
    expect(plan.plan.after).toContain(
      `(cd 'web' && npx --no-install smarttest hook trailer "$1") || true`,
    );
  });

  it("lefthook: a commit-msg command with {1}; removed whole when it was SmartTest's own", async () => {
    const before = "pre-commit:\n  commands:\n    lint:\n      run: npm run lint\n";
    const root = await repo({ "lefthook.yml": before });
    const plan = await planTrailerInstall(root);
    expect(plan.manager).toBe("lefthook");
    expect(plan.plan.after).toContain(
      "commit-msg:\n  commands:\n    smarttest-trailer: # smarttest",
    );
    expect(plan.plan.after).toContain("run: npx --no-install smarttest hook trailer {1} || true");
    await apply(root, "lefthook.yml", plan.plan.after);
    expect((await planTrailerInstall(root)).installed).toBe(true);
    expect((await planTrailerUninstall(root)).get("lefthook.yml")).toBe(before);
    // Next to a user's own commit-msg command, only SmartTest's entry goes.
    const mixed = await repo({
      "lefthook.yml": "commit-msg:\n  commands:\n    lint-msg:\n      run: commitlint --edit {1}\n",
    });
    const added = await planTrailerInstall(mixed);
    await apply(mixed, "lefthook.yml", added.plan.after);
    expect((await planTrailerUninstall(mixed)).get("lefthook.yml")).toBe(
      "commit-msg:\n  commands:\n    lint-msg:\n      run: commitlint --edit {1}\n",
    );
  });

  it("simple-git-hooks: after the user's command, which keeps failing the commit", async () => {
    const pkg = {
      devDependencies: { "simple-git-hooks": "2.0.0" },
      "simple-git-hooks": { "commit-msg": 'npx commitlint --edit "$1"' },
    };
    const root = await repo({ "package.json": `${JSON.stringify(pkg, null, 2)}\n` });
    const plan = await planTrailerInstall(root);
    expect(plan.manager).toBe("simple-git-hooks");
    const value = JSON.parse(plan.plan.after ?? "{}")["simple-git-hooks"]["commit-msg"];
    // `|| true` covers SmartTest's step only: a failing commitlint still stops the commit.
    expect(value).toBe(
      'npx commitlint --edit "$1" && (npx --no-install smarttest hook trailer "$1" || true)',
    );
    await apply(root, "package.json", plan.plan.after);
    const removed = JSON.parse((await planTrailerUninstall(root)).get("package.json") ?? "{}");
    expect(removed["simple-git-hooks"]["commit-msg"]).toBe('npx commitlint --edit "$1"');
  });

  it("CaptainHook: an action when SmartTest runs from captainhook.json; removed on uninstall", async () => {
    const config = {
      "pre-commit": {
        enabled: true,
        actions: [{ action: "npx --no-install smarttest run --staged --hook" }],
      },
      "commit-msg": {
        enabled: true,
        actions: [{ action: "\\CaptainHook\\App\\Hook\\Message\\Action\\Regex" }],
      },
    };
    const root = await repo({ "captainhook.json": `${JSON.stringify(config, null, 4)}\n` });
    const plan = await planTrailerInstall(root);
    expect(plan.manager).toBe("captainhook");
    const after = JSON.parse(plan.plan.after ?? "{}");
    expect(after["commit-msg"].actions).toEqual([
      { action: "\\CaptainHook\\App\\Hook\\Message\\Action\\Regex" },
      { action: "npx --yes @tkmremi/smarttest hook trailer {$FILE} || true" },
    ]);
    await apply(root, "captainhook.json", plan.plan.after);
    expect((await planTrailerInstall(root)).installed).toBe(true);
    // `hook uninstall` (pre-commit included) removes the trailer action, nothing else.
    const files = await planHookUninstall(root);
    const captain = files.find((f) => f.path === "captainhook.json");
    expect(JSON.parse(captain?.after ?? "{}")["commit-msg"].actions).toEqual([
      { action: "\\CaptainHook\\App\\Hook\\Message\\Action\\Regex" },
    ]);
    // Without SmartTest in captainhook.json, the trailer goes to the detected hook setup.
    const other = await repo({ "captainhook.json": '{ "pre-commit": { "actions": [] } }\n' });
    expect((await planTrailerInstall(other)).manager).toBe("git");
  });

  it("uninstall of the pre-push hook alone keeps the trailer", async () => {
    const root = await repo({ ".husky/commit-msg": "" });
    const plan = await planTrailerInstall(root, { manager: "husky" });
    await apply(root, ".husky/commit-msg", plan.plan.after);
    expect(await planHookUninstall(root, undefined, ["pre-push"])).toEqual([]);
    const all = await planHookUninstall(root);
    expect(all.map((f) => f.path)).toEqual([".husky/commit-msg"]);
    expect(await readFile(join(root, ".husky/commit-msg"), "utf8")).toContain("smarttest trailer");
  });
});
