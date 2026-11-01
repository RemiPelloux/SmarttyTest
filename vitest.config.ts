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
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**"],
      reporter: ["text", "html", "lcov"],
    },
  },
});
