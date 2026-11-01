import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vitest/config";
import { shared } from "./vitest.shared";

// What Vitest loads because this configuration names it: the shared settings it imports, a
// setup file (and the mock handlers it imports), and a module an alias maps a specifier to.
export default mergeConfig(
  shared,
  defineConfig({
    resolve: {
      alias: {
        "virtual:flags": fileURLToPath(new URL("./test/support/flags.ts", import.meta.url)),
      },
    },
    test: { setupFiles: ["./test/support/setup.ts"] },
  }),
);
