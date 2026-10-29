/**
 * 0.6.0 adoption: hook installation, CI detection and history preparation, the adaptive policy,
 * and per-project conventions.
 */
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectCi, prepareCi, SmartTest } from "@smarttest/core";
import { describe, expect, it } from "vitest";
import { planHookInstall, planHookUninstall } from "../packages/smart-init/src/index.js";
import { targetPath } from "../packages/test-generator/src/index.js";
import { git, materialize } from "./helpers.js";

async function repo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "st-adopt-"));
  for (const [p, c] of Object.entries(files)) {
    await mkdir(join(dir, p, ".."), { recursive: true });
    await writeFile(join(dir, p), c);
  }
  git(dir, "init", "-q", "-b", "main");
  return dir;
}

const apply = async (dir: string, path: string, after: string | undefined) => {
  if (after !== undefined) await writeFile(join(dir, path), after);
};

describe("hook install / uninstall", () => {
  const HOOK =
    '#!/bin/sh\n. "$(dirname -- "$0")/_/husky.sh"\nnpx eslint .\ncd backend && npx jest \\\n  --silent\nnpx vitest run\n';

  it("husky: inserts a marked block, comments out replaced steps, and restores them exactly", async () => {
    const dir = await repo({
      "package.json": '{"devDependencies":{"husky":"9"}}\n',
      ".husky/pre-commit": HOOK,
    });
    const commands = [
      {
        source: ".husky/pre-commit",
        line: 4,
        adapter: "jest" as const,
        command: "cd backend && npx jest",
        ignores: [],
      },
      {
        source: ".husky/pre-commit",
        line: 6,
        adapter: "vitest" as const,
        command: "npx vitest run",
        ignores: [],
      },
    ];
    const plan = await planHookInstall(dir, { replace: true, testCommands: commands });
    expect(plan.manager).toBe("husky");
    expect(plan.replaced.map((r) => r.line)).toEqual([4, 6]);
    await apply(dir, plan.file, plan.plan.after);
    const installed = await readFile(join(dir, plan.file), "utf8");
    expect(installed.split("\n").slice(0, 3)).toEqual([
      "#!/bin/sh",
      '. "$(dirname -- "$0")/_/husky.sh"',
      "# >>> smarttest >>>",
    ]);
    expect(installed).toContain(": # smarttest-replaced: npx vitest run");
    execFileSync("sh", ["-n", join(dir, plan.file)]); // still valid shell
    expect((await planHookInstall(dir, { testCommands: commands })).installed).toBe(true);
    const [undo] = await planHookUninstall(dir);
    await apply(dir, undo?.path ?? "", undo?.after);
    expect(await readFile(join(dir, plan.file), "utf8")).toBe(HOOK);
  });

  it("lefthook: adds a command under pre-commit and removes it again", async () => {
    const yml = "pre-commit:\n  commands:\n    lint:\n      run: npx eslint .\n";
    const dir = await repo({ "lefthook.yml": yml });
    const plan = await planHookInstall(dir);
    expect(plan.manager).toBe("lefthook");
    expect(plan.plan.after).toContain(
      "    smarttest: # smarttest\n      run: npx --no-install smarttest run --staged --non-interactive\n    lint:",
    );
    await apply(dir, plan.file, plan.plan.after);
    const [undo] = await planHookUninstall(dir, "lefthook");
    expect(undo?.after).toBe(yml);
  });

  it("simple-git-hooks: prepends to the pre-commit command", async () => {
    const pkg = '{\n  "simple-git-hooks": {\n    "pre-commit": "npx lint-staged"\n  }\n}\n';
    const dir = await repo({ "package.json": pkg });
    const plan = await planHookInstall(dir);
    expect(plan.manager).toBe("simple-git-hooks");
    expect(JSON.parse(plan.plan.after ?? "{}")["simple-git-hooks"]["pre-commit"]).toBe(
      "npx --no-install smarttest run --staged --non-interactive && npx lint-staged",
    );
    await apply(dir, "package.json", plan.plan.after);
    const [undo] = await planHookUninstall(dir, "simple-git-hooks");
    expect(undo?.after).toBe(pkg);
  });

  it("plain Git: creates an executable pre-commit hook", async () => {
    const dir = await repo({ "package.json": "{}\n" });
    const st = await SmartTest.open({ root: dir });
    const plan = await st.hookInstallPlan();
    expect(plan.manager).toBe("git");
    expect(plan.plan.action).toBe("create");
    await st.applyFiles([plan.plan]);
    const s = await stat(join(dir, ".git/hooks/pre-commit"));
    expect(s.mode & 0o111).not.toBe(0);
  });
});

describe("smarttest ci", () => {
  it("detects providers and merge requests", () => {
    expect(
      detectCi({ GITLAB_CI: "true", CI_MERGE_REQUEST_TARGET_BRANCH_NAME: "main" }),
    ).toMatchObject({
      provider: "gitlab",
      isPullRequest: true,
      targetBranch: "main",
    });
    expect(
      detectCi({ TF_BUILD: "True", SYSTEM_PULLREQUEST_TARGETBRANCH: "refs/heads/develop" }),
    ).toMatchObject({
      provider: "azure",
      targetBranch: "develop",
    });
    expect(detectCi({ JENKINS_URL: "x", GIT_PREVIOUS_SUCCESSFUL_COMMIT: "abc" })).toMatchObject({
      provider: "jenkins",
      baseSha: "abc",
    });
    expect(
      detectCi({ BITBUCKET_BUILD_NUMBER: "1", BITBUCKET_PR_DESTINATION_BRANCH: "main" })
        .targetBranch,
    ).toBe("main");
    expect(detectCi({ CIRCLECI: "true", CIRCLE_BRANCH: "feat" })).toMatchObject({
      provider: "circleci",
      branch: "feat",
    });
    expect(detectCi({ CI: "1" }).provider).toBe("generic");
    expect(detectCi({}).provider).toBe("none");
  });

  it("finds the merge-base in a shallow clone by fetching the target branch and deepening", async () => {
    const origin = await materialize("no-vcs-vitest", { git: true });
    git(origin, "checkout", "-q", "-b", "feature");
    for (let i = 0; i < 3; i++) {
      await writeFile(join(origin, `f${i}.txt`), String(i));
      git(origin, "add", "-A");
      git(origin, "commit", "-qm", `feature ${i}`);
    }
    const clone = await mkdtemp(join(tmpdir(), "st-ci-"));
    execFileSync("git", [
      "clone",
      "-q",
      "--depth=1",
      "--branch",
      "feature",
      `file://${origin}`,
      clone,
    ]);
    const plan = await prepareCi(clone, {
      provider: "gitlab",
      isPullRequest: true,
      targetBranch: "main",
      evidence: "test",
    });
    expect(plan.all).toBe(false);
    expect(plan.base).toBe("origin/main");
    expect(plan.steps.join(" ")).toMatch(/shallow/);
  });

  it("uses the parent commit on a branch build", async () => {
    const dir = await materialize("no-vcs-vitest", { git: true });
    await writeFile(join(dir, "x.txt"), "x");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "second");
    const plan = await prepareCi(dir, {
      provider: "generic",
      isPullRequest: false,
      evidence: "test",
    });
    expect(plan).toMatchObject({ base: "HEAD^", direct: true, all: false });
  });
});

describe("adaptive policy", () => {
  it("runs everything when the full suite was faster than a typical analysis", async () => {
    const dir = await materialize("node-test-esm", { git: true });
    const st = await SmartTest.open({ root: dir });
    await mkdir(join(st.storeDir, "state"), { recursive: true });
    await writeFile(
      join(st.storeDir, "state/timings.json"),
      JSON.stringify({ analysisMs: [5000, 5000, 5000], fullRunMs: 10 }),
    );
    const out = await st.run({});
    expect(out.report.decision.reasons[0]?.message).toMatch(/^Adaptive:/);
    expect(out.report.decision.skippedTests).toEqual([]);
    const off = await SmartTest.open({ root: dir });
    off.config.adaptive = false;
    const again = await off.run({});
    expect(again.report.decision.reasons.some((r) => r.message.startsWith("Adaptive:"))).toBe(
      false,
    );
  }, 120_000);
});

describe("per-project conventions", () => {
  it("generated tests follow the project's own layout", () => {
    const opts = {
      layout: "mirror" as const,
      directory: "tests",
      type: "unit" as const,
      projects: [
        {
          dir: "backend",
          layout: "custom" as const,
          path: "backend/src/__tests__/{FileName}.test.{Extension}",
        },
        { dir: "app", layout: "colocated" as const, naming: "{FileName}.server.test.{Extension}" },
      ],
    };
    expect(targetPath("backend/src/routes/users.js", undefined, opts)).toBe(
      "backend/src/__tests__/users.test.js",
    );
    expect(targetPath("app/src/pay/price.ts", undefined, opts)).toBe(
      "app/src/pay/price.server.test.ts",
    );
    expect(targetPath("src/x.ts", undefined, opts)).toBe("tests/unit/x.test.ts");
  });

  it("init proposes per-project conventions when sub-projects differ", async () => {
    const dir = await repo({
      "backend/package.json":
        '{"name":"b","scripts":{"test":"jest"},"devDependencies":{"jest":"30"}}\n',
      "backend/src/a.js": "module.exports = 1;\n",
      "backend/src/b.js": "module.exports = 2;\n",
      "backend/src/c.js": "module.exports = 3;\n",
      "backend/src/__tests__/a.test.js": "test('a', () => {});\n",
      "backend/src/__tests__/b.test.js": "test('b', () => {});\n",
      "backend/src/__tests__/c.test.js": "test('c', () => {});\n",
      "app/package.json":
        '{"name":"a","type":"module","scripts":{"test":"vitest run"},"devDependencies":{"vitest":"5"}}\n',
      "app/src/x.ts": "export const x = 1;\n",
      "app/src/y.ts": "export const y = 1;\n",
      "app/src/z.ts": "export const z = 1;\n",
      "app/src/x.server.test.ts": "import { x } from './x';\n",
      "app/src/y.server.test.ts": "import { y } from './y';\n",
      "app/src/z.server.test.ts": "import { z } from './z';\n",
    });
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "init");
    const plan = await (await SmartTest.open({ root: dir })).initPlan();
    expect(plan.config.projects).toEqual({
      backend: {
        tests: { layout: "custom", path: "backend/src/__tests__/{FileName}.test.{Extension}" },
      },
      app: { tests: { layout: "colocated", naming: "{FileName}.server.test.{Extension}" } },
    });
  }, 120_000);
});
