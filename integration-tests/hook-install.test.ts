import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SmartTest } from "../packages/core/src/index.js";
import { detectTestCommands } from "../packages/project-detector/src/commands.js";
import { planHookInstall, planHookUninstall } from "../packages/smart-init/src/index.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function repo(files: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), "smarttest-hook-install-"));
  roots.push(dir);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(dir, path, ".."), { recursive: true });
    await writeFile(join(dir, path), text);
  }
  return dir;
}

describe("0.9 hook installation", () => {
  it("replaces a related background step while preserving PID/wait and restores the exact script", async () => {
    const original =
      '#!/bin/sh\nset -eu\nif [ -n "yes" ]; then\n  npx vitest related --run src/math.ts &\n  PID_TESTS=$!\nfi\nwait "$PID_TESTS" || exit 1\n';
    const root = await repo({
      "package.json": '{"devDependencies":{"husky":"9"}}',
      ".husky/pre-push": original,
    });
    const testCommands = await detectTestCommands(root, []);
    const p = await planHookInstall(root, { stage: "pre-push", replace: true, testCommands });
    expect(p.replaced).toHaveLength(1);
    expect(p.plan.after).toContain("smarttest run --push --hook");
    expect(p.plan.after).toContain("true & # smarttest-replaced:");
    await writeFile(join(root, p.file), p.plan.after as string);
    // Missing local SmartTest is reported by the block; the replaced background job still has a PID.
    execFileSync("sh", [p.file], { cwd: root, stdio: "pipe" });
    const repeat = await planHookInstall(root, {
      stage: "pre-push",
      replace: true,
      testCommands: await detectTestCommands(root, []),
    });
    expect(repeat.plan.action).toBe("skip");
    expect(repeat.remaining).toEqual([]);
    const undo = await planHookUninstall(root, "husky", ["pre-push"]);
    expect(undo[0]?.after).toBe(original);
  });

  it("detects package-script test steps", async () => {
    const root = await repo({
      "package.json": '{"scripts":{"test:unit":"vitest run"},"devDependencies":{"husky":"9"}}',
      ".husky/pre-push": "#!/bin/sh\nnpm run test:unit\n",
    });
    const testCommands = await detectTestCommands(root, []);
    const p = await planHookInstall(root, { stage: "pre-push", replace: true, testCommands });
    expect(p.replaced[0]?.command).toBe("npm run test:unit");
  });

  it("leaves compound commands and package scripts with other checks for review", async () => {
    const original =
      "#!/bin/sh\nif npx vitest run; then\n  echo success\nfi\nnpm test\nnpx vitest run && npm run build\n";
    const root = await repo({
      "package.json":
        '{"scripts":{"test":"eslint . && vitest run"},"devDependencies":{"husky":"9"}}',
      ".husky/pre-commit": original,
    });
    const p = await planHookInstall(root, {
      replace: true,
      testCommands: await detectTestCommands(root, []),
    });
    expect(p.replaced).toEqual([]);
    expect(p.remaining).toHaveLength(3);
    expect(p.plan.after).toContain("if npx vitest run; then");
    await writeFile(join(root, p.file), p.plan.after as string);
    execFileSync("sh", ["-n", p.file], { cwd: root });
  });

  it("installs both lefthook stages independently and removes only the requested one", async () => {
    const root = await repo({
      "lefthook.yml": "pre-commit:\n  commands:\n    lint:\n      run: npx eslint .\n",
    });
    const commit = await planHookInstall(root);
    await writeFile(join(root, commit.file), commit.plan.after as string);
    const push = await planHookInstall(root, { stage: "pre-push" });
    expect(push.installed).toBe(false);
    expect(push.plan.after).toContain("smarttest run --push --hook");
    await writeFile(join(root, push.file), push.plan.after as string);
    expect((await planHookInstall(root)).installed).toBe(true);
    expect((await planHookInstall(root, { stage: "pre-push" })).installed).toBe(true);
    const undo = await planHookUninstall(root, "lefthook", ["pre-push"]);
    expect(undo[0]?.after).toContain("smarttest run --staged --hook");
    expect(undo[0]?.after).not.toContain("smarttest run --push --hook");
  });

  it("keeps an upgraded and uninstalled hook executable", async () => {
    const root = await repo({
      "package.json": '{"devDependencies":{"husky":"9"}}',
      ".husky/pre-commit": "#!/bin/sh\nnpx --no-install smarttest run --staged\n",
    });
    const hook = join(root, ".husky/pre-commit");
    await chmod(hook, 0o750);
    const st = await SmartTest.open({ root });
    await st.applyFiles([(await planHookInstall(root)).plan]);
    if (process.platform !== "win32") expect((await stat(hook)).mode & 0o777).toBe(0o750);
    await st.applyFiles(await planHookUninstall(root, "husky"));
    if (process.platform !== "win32") expect((await stat(hook)).mode & 0o777).toBe(0o750);
  });

  it("preserves shell dollar sequences while upgrading an existing hook", async () => {
    const original =
      "#!/bin/sh\nprintf '%s\\n' \"$STAGED\" | grep -E '\\.(ts|js)$'\n# $& $` $' $$\nnpx --no-install smarttest run --staged --non-interactive\n";
    const root = await repo({
      "package.json": '{"devDependencies":{"husky":"9"}}',
      ".husky/pre-commit": original,
    });
    const plan = await planHookInstall(root);
    expect(plan.plan.after).toBe(original.replace("--non-interactive", "--hook"));
  });

  it("upgrades an old marked hook without losing the other steps", async () => {
    const root = await repo({
      "package.json": '{"devDependencies":{"husky":"9"}}',
      ".husky/pre-commit":
        "#!/bin/sh\n# >>> smarttest >>>\nnpx --no-install smarttest run --staged --non-interactive || exit 1\n# <<< smarttest <<<\nnpx eslint .\n",
    });
    const p = await planHookInstall(root);
    expect(p.installed).toBe(true);
    expect(p.plan.action).toBe("modify");
    expect(p.plan.after).toContain("smarttest run --staged --hook || exit 1");
    expect(p.plan.after).toContain("npx eslint .");
    await writeFile(join(root, p.file), p.plan.after as string);
    expect((await planHookInstall(root)).plan.action).toBe("skip");
  });

  it("reports unreplaced lefthook suite steps honestly when --replace cannot rewrite them", async () => {
    const root = await repo({
      "lefthook.yml": "pre-push:\n  commands:\n    tests:\n      run: npx vitest run\n",
    });
    const testCommands = await detectTestCommands(root, []);
    const p = await planHookInstall(root, { stage: "pre-push", replace: true, testCommands });
    expect(p.replaced).toEqual([]);
    expect(p.remaining).toHaveLength(1);
    expect(p.plan.after).toContain("run: npx vitest run");
  });

  it("uninstalls both simple-git-hooks stages in a single atomic file plan", async () => {
    const original =
      '{\n  "simple-git-hooks": {\n    "pre-commit": "npx lint-staged",\n    "pre-push": "npm run build"\n  }\n}\n';
    const root = await repo({ "package.json": original });
    for (const stage of ["pre-commit", "pre-push"] as const) {
      const p = await planHookInstall(root, { stage });
      await writeFile(join(root, p.file), p.plan.after as string);
    }
    const plans = await planHookUninstall(root, "simple-git-hooks");
    expect(plans).toHaveLength(1);
    expect(plans[0]?.after).toBe(original);
    expect(await readFile(join(root, "package.json"), "utf8")).toContain("--push --hook");
  });
});
