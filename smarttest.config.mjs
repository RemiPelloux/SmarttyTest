/**
 * SmartTest on its own repository. The root Vitest runs every test (vitest.config.ts); the
 * fixtures' own test files are test data, run by the integration tests. A plugin links each
 * integration test to the fixtures it names and, when it starts the bundled CLI, to every package.
 */
export default {
  mode: "balanced",
  runners: [{ adapter: "vitest", dir: "" }],
  tests: {
    match: [
      "packages/*/src/**/*.test.ts",
      "packages/*/test/**/*.test.ts",
      "integration-tests/**/*.test.ts",
    ],
  },
  plugins: ["./scripts/smarttest/fixture-edges.mjs"],
  hook: { runners: ["vitest"] },
};
