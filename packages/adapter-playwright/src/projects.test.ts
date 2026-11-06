import { describe, expect, it } from "vitest";
import {
  isRemoteBaseURL,
  liveProjects,
  liveSpecs,
  type PlaywrightProject,
  type PlaywrightProjects,
} from "./projects.js";

const project = (
  name: string,
  baseURL?: string,
  dependencies: string[] = [],
): PlaywrightProject => ({
  name,
  ...(baseURL ? { baseURL } : {}),
  dependencies,
  testMatch: [],
  testIgnore: [],
});

describe("isRemoteBaseURL", () => {
  it("is remote only for https on a non-loopback host", () => {
    expect(isRemoteBaseURL("https://dev.openpro.ai")).toBe(true);
    expect(isRemoteBaseURL("https://staging.example.com/app/")).toBe(true);
    for (const local of [
      undefined,
      "",
      "http://dev.openpro.ai",
      "http://localhost:3000",
      "https://localhost:3000",
      "https://app.localhost",
      "https://127.0.0.1:8443",
      "https://[::1]:8443",
      "https://0.0.0.0",
      "not a url",
    ])
      expect(isRemoteBaseURL(local), String(local)).toBe(false);
  });

  it("is local when a webServer the config starts serves that origin", () => {
    expect(isRemoteBaseURL("https://app.test:8443", ["https://app.test:8443/health"])).toBe(false);
    expect(isRemoteBaseURL("https://app.test:8443", ["https://other.test:8443"])).toBe(true);
  });
});

describe("live projects and specs", () => {
  const info: PlaywrightProjects = {
    projects: [
      project("setup", "https://dev.example.com"),
      project("remote", "https://dev.example.com", ["setup"]),
      project("local", "http://127.0.0.1:3000"),
      // Local baseURL, but it logs in to the deployed environment first.
      project("local-after-remote-setup", "http://127.0.0.1:3000", ["setup"]),
      project("cycle-a", undefined, ["cycle-b"]),
      project("cycle-b", undefined, ["cycle-a"]),
    ],
    webServers: ["http://127.0.0.1:3000"],
    files: {
      "e2e/fixtures/auth.setup.ts": ["setup"],
      "e2e/remote.spec.ts": ["remote"],
      "e2e/local.spec.ts": ["local"],
      "e2e/both.spec.ts": ["remote", "local"],
      "e2e/after-setup.spec.ts": ["local-after-remote-setup"],
      "e2e/cycle.spec.ts": ["cycle-a"],
      "e2e/no-project.spec.ts": [],
    },
  };

  it("propagates a remote setup project to its dependents and survives cycles", () => {
    expect([...liveProjects(info).keys()].sort()).toEqual([
      "local-after-remote-setup",
      "remote",
      "setup",
    ]);
  });

  it("marks a spec live only when every project that runs it is live", () => {
    expect(liveSpecs(info)).toEqual([
      {
        file: "e2e/after-setup.spec.ts",
        projects: ["local-after-remote-setup"],
        baseURL: "https://dev.example.com",
      },
      {
        file: "e2e/fixtures/auth.setup.ts",
        projects: ["setup"],
        baseURL: "https://dev.example.com",
      },
      { file: "e2e/remote.spec.ts", projects: ["remote"], baseURL: "https://dev.example.com" },
    ]);
  });
});
