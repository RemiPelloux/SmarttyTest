import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  use: { baseURL: "http://127.0.0.1:3123" },
  webServer: { command: "node server.mjs", url: "http://127.0.0.1:3123/api/health", reuseExistingServer: false },
});
