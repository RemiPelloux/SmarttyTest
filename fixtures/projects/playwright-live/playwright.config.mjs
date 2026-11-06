import { defineConfig } from "@playwright/test";

// One port per checkout (the config is read again in every worker, so it must not be random):
// two copies of this fixture tested at the same time never share a server.
const PORT =
  3200 + ([...import.meta.dirname].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 0) % 2000);
const LOCAL = `http://127.0.0.1:${PORT}`;
// The deployed environment. `.invalid` never resolves: a live spec that ran would fail.
const DEPLOYED = "https://staging.example.invalid";

export default defineConfig({
  testDir: "e2e",
  workers: 1,
  use: { baseURL: LOCAL },
  webServer: {
    command: `node server.mjs ${PORT}`,
    url: `${LOCAL}/api/status`,
    reuseExistingServer: false,
  },
  projects: [
    { name: "local-setup", testMatch: /setup\/local\.setup\.js/ },
    { name: "local", testDir: "e2e/local", dependencies: ["local-setup"] },
    {
      name: "live-setup",
      testMatch: /setup\/live\.setup\.js/,
      use: { baseURL: DEPLOYED },
    },
    {
      name: "live",
      testDir: "e2e/live",
      dependencies: ["live-setup"],
      use: { baseURL: DEPLOYED },
    },
  ],
});
