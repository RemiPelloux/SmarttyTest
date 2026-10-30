import { defineConfig } from "vitest/config";

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
