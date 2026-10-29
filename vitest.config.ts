import { defineConfig } from "vitest/config";

export default defineConfig({
  // Resolve workspace packages to their TypeScript sources (no build needed for tests).
  resolve: { conditions: ["@smarttest/source"] },
  test: {
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
