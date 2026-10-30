import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // The host-side modules import `vscode`, which only exists inside an
    // extension host; tests get a small stub instead.
    alias: { vscode: fileURLToPath(new URL("./test/vscode-stub.ts", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts", "test/**/*.test.mjs"],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
