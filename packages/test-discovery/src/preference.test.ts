import { describe, expect, it } from "vitest";
import { type RunnerRoot, runnerPreference } from "./index.js";

const vitest: RunnerRoot = { adapter: "vitest", dir: "" };
const jest: RunnerRoot = { adapter: "jest", dir: "", configFile: "jest.config.js" };
const angular: RunnerRoot = { adapter: "angular", dir: "", configFile: "angular.json" };

describe("runnerPreference", () => {
  it("prefers the runner the test script starts, then one with a config", () => {
    expect(runnerPreference(jest, "jest")).toBeLessThan(runnerPreference(vitest, "jest"));
    expect(runnerPreference(vitest, "vitest run")).toBeLessThan(
      runnerPreference(jest, "vitest run"),
    );
    expect(runnerPreference(angular, "ng test")).toBeLessThan(runnerPreference(vitest, "ng test"));
    expect(runnerPreference(jest, "")).toBeLessThan(runnerPreference(vitest, ""));
  });

  it("the configured adapters order comes first", () => {
    expect(runnerPreference(vitest, "jest", ["vitest", "jest"])).toBeLessThan(
      runnerPreference(jest, "jest", ["vitest", "jest"]),
    );
  });
});
