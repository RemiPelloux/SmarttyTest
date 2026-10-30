import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts", "test/**/*.test.mjs"],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
