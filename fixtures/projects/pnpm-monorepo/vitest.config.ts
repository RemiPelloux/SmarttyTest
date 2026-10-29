import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@demo/core-lib": fileURLToPath(new URL("./packages/core-lib/src/index.ts", import.meta.url)) } },
  test: { include: ["packages/*/test/**/*.test.ts"] },
});
