import { describe, expect, it } from "vitest";
import { ExitCode, SmartTestError, toExitCode } from "./errors.js";

describe("SmartTestError", () => {
  it("maps categories to the documented exit codes", () => {
    const error = new SmartTestError("bad config", {
      code: "ST_CONFIG_INVALID",
      category: "configuration",
      hint: "Run smarttest doctor",
    });
    expect(error.exitCode).toBe(ExitCode.ConfigurationFailure);
    expect(error.hint).toBe("Run smarttest doctor");
  });

  it("treats unknown errors as internal failures", () => {
    expect(toExitCode(new Error("boom"))).toBe(ExitCode.Internal);
  });

  it("keeps the exit-code contract stable", () => {
    expect(ExitCode).toEqual({
      Success: 0,
      TestFailure: 1,
      InvalidUsage: 2,
      ConfigurationFailure: 3,
      InfrastructureFailure: 4,
      PolicyFailure: 5,
      Internal: 70,
    });
  });
});
