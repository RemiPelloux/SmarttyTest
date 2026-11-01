/**
 * Every built-in adapter passes the Plugin SDK v1 conformance kit (ADR-0005): runners, version
 * control, language analyzers. Edge providers are covered in plugins.test.ts.
 */
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CypressAdapter } from "@smarttest/adapter-cypress";
import { JestAdapter } from "@smarttest/adapter-jest";
import { NodeTestAdapter } from "@smarttest/adapter-node";
import { PlaywrightAdapter } from "@smarttest/adapter-playwright";
import { VitestAdapter } from "@smarttest/adapter-vitest";
import { javascriptAnalyzer } from "@smarttest/language-javascript";
import { typescriptAnalyzer } from "@smarttest/language-typescript";
import { checkTestAdapterConformance } from "@smarttest/plugin-sdk";
import {
  assertConformance,
  type ConformanceReport,
  checkLanguageAnalyzer,
  checkRunnerAdapter,
  checkVcsAdapter,
} from "@smarttest/plugin-sdk/conformance";
import { GitAdapter } from "@smarttest/vcs-git";
import { HgAdapter } from "@smarttest/vcs-hg";
import { SvnAdapter } from "@smarttest/vcs-svn";
import { describe, expect, it } from "vitest";
import { FIXTURES, git, materialize } from "./helpers.js";

const has = (cmd: string) => {
  try {
    execFileSync(cmd, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

const passes = (report: ConformanceReport) => {
  assertConformance(report);
  return report.checks.filter((c) => c.status === "pass").map((c) => c.name);
};

describe("runner adapters conform to the plugin SDK", () => {
  it("Vitest: discovery and execution, including a failing test", async () => {
    const root = await materialize("nest-auth-vitest");
    await writeFile(
      join(root, "tests/conformance-fail.test.ts"),
      'import { expect, it } from "vitest";\nit("fails", () => expect(1).toBe(2));\n',
    );
    const adapter = new VitestAdapter({ projectRoot: root, cwd: root });
    const report = await checkRunnerAdapter(adapter, {
      expectedFiles: ["test/routes/ProtectedRoutes.test.ts", "tests/conformance-fail.test.ts"],
      run: {
        files: [
          "tests/unit/modules/catalog/CatalogService.test.ts",
          "tests/conformance-fail.test.ts",
        ],
        expect: {
          "tests/unit/modules/catalog/CatalogService.test.ts": "passed",
          "tests/conformance-fail.test.ts": "failed",
        },
      },
    });
    expect(passes(report)).toContain("runner.execute.outcomes");
  }, 120_000);

  it("Jest: discovery and execution, including a failing test", async () => {
    const root = await materialize("express-cjs-jest");
    await writeFile(
      join(root, "__tests__/conformance-fail.test.js"),
      'test("fails", () => { expect(1).toBe(2); });\n',
    );
    const adapter = new JestAdapter({ projectRoot: root, cwd: root });
    const report = await checkRunnerAdapter(adapter, {
      expectedFiles: ["__tests__/app.test.js", "__tests__/format.test.js"],
      run: {
        files: ["__tests__/format.test.js", "__tests__/conformance-fail.test.js"],
        expect: {
          "__tests__/format.test.js": "passed",
          "__tests__/conformance-fail.test.js": "failed",
        },
      },
    });
    expect(passes(report)).toContain("runner.execute.outcomes");
    // The 0.x entry point keeps working.
    expect(await checkTestAdapterConformance(adapter)).toEqual([]);
  }, 120_000);

  it("node --test: discovery and execution, including a failing test", async () => {
    const root = await materialize("node-test-esm");
    await writeFile(
      join(root, "test/conformance-fail.test.js"),
      'import { test } from "node:test";\nimport assert from "node:assert/strict";\ntest("fails", () => assert.equal(1, 2));\n',
    );
    const adapter = new NodeTestAdapter({ projectRoot: root, cwd: root });
    const report = await checkRunnerAdapter(adapter, {
      expectedFiles: ["test/cart.test.js", "test/slug.test.js"],
      run: {
        files: ["test/slug.test.js", "test/conformance-fail.test.js"],
        expect: { "test/slug.test.js": "passed", "test/conformance-fail.test.js": "failed" },
      },
    });
    expect(passes(report)).toContain("runner.execute.outcomes");
  }, 120_000);

  it("Playwright: discovery (execution needs browsers, so it is not exercised here)", async () => {
    const root = join(FIXTURES, "next-playwright");
    const adapter = new PlaywrightAdapter({ projectRoot: root, cwd: root });
    const report = await checkRunnerAdapter(adapter, {
      expectedFiles: ["e2e/home.spec.js", "e2e/users.spec.js"],
    });
    expect(passes(report)).toContain("runner.discovery.expected");
  }, 120_000);

  it("Cypress: static (partial) discovery from the project files", async () => {
    const root = await mkdtemp(join(tmpdir(), "st-cypress-"));
    const files = ["cypress/e2e/login.cy.ts", "cypress/support/e2e.ts", "src/app.ts"];
    const adapter = new CypressAdapter({ projectRoot: root, cwd: root, files: async () => files });
    const report = await checkRunnerAdapter(adapter, {
      expectedFiles: ["cypress/e2e/login.cy.ts"],
    });
    expect(passes(report)).toContain("runner.discovery.cases");
  });
});

describe("version-control adapters conform to the plugin SDK", () => {
  it("Git: detection, working state, changes with a rename, content at the base", async () => {
    const root = await mkdtemp(join(tmpdir(), "st-vcs-git-"));
    await writeFile(join(root, "a.txt"), "one\n");
    await writeFile(join(root, "old.txt"), "moved content that stays the same\n".repeat(5));
    git(root, "init", "-q", "-b", "main");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "base");
    await writeFile(join(root, "a.txt"), "two\n");
    await writeFile(join(root, "b.txt"), "new\n");
    git(root, "mv", "old.txt", "new.txt");
    const report = await checkVcsAdapter(new GitAdapter(root), {
      root,
      outside: await mkdtemp(join(tmpdir(), "st-vcs-none-")),
      base: { provider: "git", ref: "HEAD", kind: "commit" },
      expectedChanges: [
        { path: "a.txt", type: "modified" },
        { path: "b.txt", type: "added" },
        { path: "new.txt", type: "renamed", previousPath: "old.txt" },
      ],
      fileAtBase: { path: "a.txt", content: "one\n" },
    });
    expect(passes(report)).toEqual(
      expect.arrayContaining(["vcs.changes.expected", "vcs.fileContent", "vcs.detect.outside"]),
    );
  }, 60_000);

  it.skipIf(!has("svn") || !has("svnadmin"))(
    "Subversion: detection, working state, changes, content at BASE",
    async () => {
      const repo = await mkdtemp(join(tmpdir(), "st-vcs-svnrepo-"));
      const wc = await mkdtemp(join(tmpdir(), "st-vcs-svnwc-"));
      execFileSync("svnadmin", ["create", repo]);
      execFileSync("svn", ["checkout", "-q", `file://${repo}`, wc]);
      await writeFile(join(wc, "a.txt"), "one\n");
      execFileSync("svn", ["add", "-q", "a.txt"], { cwd: wc });
      execFileSync("svn", ["commit", "-q", "-m", "base"], { cwd: wc });
      await writeFile(join(wc, "a.txt"), "two\n");
      await writeFile(join(wc, "b.txt"), "new\n");
      execFileSync("svn", ["add", "-q", "b.txt"], { cwd: wc });
      const report = await checkVcsAdapter(new SvnAdapter(wc), {
        root: wc,
        outside: await mkdtemp(join(tmpdir(), "st-vcs-none-")),
        base: { provider: "svn", ref: "BASE", kind: "revision" },
        expectedChanges: [
          { path: "a.txt", type: "modified" },
          { path: "b.txt", type: "added" },
        ],
        fileAtBase: { path: "a.txt", content: "one\n" },
      });
      expect(passes(report)).toContain("vcs.changes.expected");
    },
    60_000,
  );

  it.skipIf(!has("hg"))(
    "Mercurial: detection, working state, changes, content at the parent",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "st-vcs-hg-"));
      const hg = (...args: string[]) =>
        execFileSync("hg", ["--config", "ui.username=SmartTest <ci@smarttest.dev>", ...args], {
          cwd: root,
        });
      hg("init");
      await writeFile(join(root, "a.txt"), "one\n");
      hg("add", "a.txt");
      hg("commit", "-q", "-m", "base");
      await writeFile(join(root, "a.txt"), "two\n");
      await writeFile(join(root, "b.txt"), "new\n");
      hg("add", "b.txt");
      const report = await checkVcsAdapter(new HgAdapter(root), {
        root,
        outside: await mkdtemp(join(tmpdir(), "st-vcs-none-")),
        base: { provider: "hg", ref: ".", kind: "commit" },
        expectedChanges: [
          { path: "a.txt", type: "modified" },
          { path: "b.txt", type: "added" },
        ],
        fileAtBase: { path: "a.txt", content: "one\n" },
      });
      expect(passes(report)).toContain("vcs.changes.expected");
    },
    60_000,
  );
});

describe("language analyzers conform to the plugin SDK", () => {
  it("TypeScript", async () => {
    const report = await checkLanguageAnalyzer(typescriptAnalyzer, {
      files: {
        "src/a.ts":
          'import { b } from "./b.js";\nexport function a(): number { return b(); }\nexport class K { m(): number { return a(); } }\n',
        "src/dyn.ts": "export const load = (name: string) => import(name);\n",
      },
      expect: {
        imports: { "src/a.ts": ["./b.js"] },
        symbols: { "src/a.ts": ["a", "K", "K.m"] },
        uncertain: ["src/dyn.ts"],
      },
    });
    expect(passes(report)).toContain("language.uncertainty");
  });

  it("JavaScript (ESM and CommonJS)", async () => {
    const report = await checkLanguageAnalyzer(javascriptAnalyzer, {
      files: {
        "lib/a.js":
          'const { b } = require("./b");\nfunction a() { return b(); }\nmodule.exports = { a };\n',
        "lib/c.mjs": 'import { a } from "./a.js";\nexport const c = () => a();\n',
        "lib/dyn.js": "module.exports = (name) => require(name);\n",
      },
      expect: {
        imports: { "lib/a.js": ["./b"], "lib/c.mjs": ["./a.js"] },
        symbols: { "lib/c.mjs": ["c"] },
        uncertain: ["lib/dyn.js"],
      },
    });
    expect(passes(report)).toContain("language.uncertainty");
  });
});

describe("the conformance kit catches broken adapters", () => {
  it("reports an undeclared capability, a bad path and a wrong outcome", async () => {
    const report = await checkRunnerAdapter(
      {
        apiVersion: 1,
        id: "broken",
        getCapabilities: () =>
          ({ discovery: true, fileSelection: true }) as unknown as ReturnType<
            VitestAdapter["getCapabilities"]
          >,
        discover: async () => [
          { id: "x", filePath: "/abs/x.test.ts", suitePath: [], name: "x", tags: [] },
        ],
        execute: async () => ({
          adapter: "broken",
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          executions: [{ testId: "a.test.ts::t", status: "passed", durationMs: 1, attempts: 1 }],
        }),
      },
      { run: { files: ["a.test.ts"], expect: { "a.test.ts": "failed" } } },
    );
    expect(report.ok).toBe(false);
    const failed = report.checks.filter((c) => c.status === "fail").map((c) => c.name);
    expect(failed).toEqual([
      "runner.capabilities",
      "runner.discovery.cases",
      "runner.execute.outcomes",
    ]);
    expect(() => assertConformance(report)).toThrow(/does NOT conform/);
  });

  it("a VCS adapter that loses a change fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "st-vcs-lossy-"));
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src/a.ts"), "export {};\n");
    git(root, "init", "-q", "-b", "main");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "base");
    await writeFile(join(root, "src/a.ts"), "export const a = 1;\n");
    const real = new GitAdapter(root);
    const lossy = Object.assign(Object.create(real), {
      getChanges: async (...args: Parameters<GitAdapter["getChanges"]>) => ({
        ...(await real.getChanges(...args)),
        changes: [],
      }),
    }) as GitAdapter;
    const report = await checkVcsAdapter(lossy, {
      root,
      base: { provider: "git", ref: "HEAD", kind: "commit" },
      expectedChanges: [{ path: "src/a.ts", type: "modified" }],
    });
    expect(report.checks.find((c) => c.name === "vcs.changes.expected")?.status).toBe("fail");
  });
});
