import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

// The tests create throwaway repositories with git. Started from a git hook, an inherited GIT_DIR
// (or GIT_INDEX_FILE, ...) would point every one of those commands at this repository instead.
for (const name of [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_PREFIX",
]) {
  delete process.env[name];
}

// Run in a CI job, the CLI under test would annotate that job (and append to its step summary):
// the tests that check annotations set these variables themselves.
for (const name of [
  "GITHUB_ACTIONS",
  "GITHUB_STEP_SUMMARY",
  "GITHUB_WORKSPACE",
  "GITLAB_CI",
  "CI_PROJECT_DIR",
  "BITBUCKET_BUILD_NUMBER",
  "BITBUCKET_CLONE_DIR",
]) {
  delete process.env[name];
}

// One temporary directory per run, removed at the end (scripts/test-tmp.mjs). Workers and the
// processes the tests start inherit it.
if (!process.env.SMARTTEST_TEST_TMP) {
  const runTmp = mkdtempSync(join(tmpdir(), "st-run-"));
  process.env.SMARTTEST_TEST_TMP = runTmp;
  for (const name of ["TMPDIR", "TEMP", "TMP"]) process.env[name] = runTmp;
}

export default defineConfig({
  // Resolve workspace packages to their TypeScript sources (no build needed for tests). Tests run
  // in the SSR environment, and linked workspace packages are inlined so the condition applies to
  // them instead of Node loading their (possibly stale) dist/.
  resolve: { conditions: ["@smarttest/source"] },
  ssr: { resolve: { conditions: ["@smarttest/source"] } },
  test: {
    server: { deps: { inline: [/@smarttest\//] } },
    include: [
      "packages/*/src/**/*.test.ts",
      "packages/*/test/**/*.test.ts",
      "integration-tests/**/*.test.ts",
    ],
    passWithNoTests: true,
    globalSetup: ["scripts/test-tmp.mjs"],
    // Process start-up, git and Git for Windows' sh are several times slower on Windows runners:
    // tests that take 3-5 s on Linux brush past the 5 s default there.
    testTimeout: process.platform === "win32" ? 30_000 : 5_000,
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**"],
      reporter: ["text", "html", "lcov"],
    },
  },
});
