import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

// Loads .env.test into process.env for the tests (no dotenv dependency).
const env = Object.fromEntries(
  readFileSync(new URL("./.env.test", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);

export default defineConfig({
  resolve: { alias: { "wasp/client/operations": new URL("./src/wasp-operations.ts", import.meta.url).pathname } },
  test: { env },
});
