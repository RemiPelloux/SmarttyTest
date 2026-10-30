import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/runner.js";
import { CancelledError, SmartTestExtensionError } from "../src/core/errors.js";

function options(script: string, timeoutMs = 5_000) {
  return {
    executable: process.execPath,
    args: ["-e", script],
    cwd: process.cwd(),
    signal: new AbortController().signal,
    timeoutMs,
  } as const;
}

describe("CLI runner", () => {
  it("returns stdout for a successful process", async () => {
    const result = await runCli(options("process.stdout.write('ok')"));
    expect(result.stdout).toBe("ok");
    expect(result.exitCode).toBe(0);
  });

  it("returns exit code 1 so a failing test report can still be parsed", async () => {
    const result = await runCli(options("process.stdout.write('report');process.exit(1)"));
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("report");
  });

  it("maps a CLI error envelope and preserves the stable code", async () => {
    const script = `process.stdout.write(JSON.stringify({schemaVersion:1,error:{code:"ST_CONFIG",category:"config",message:"bad config",hint:"fix it"}}));process.exit(3)`;
    await expect(runCli(options(script))).rejects.toMatchObject({
      code: "ST_CONFIG",
      category: "configuration",
      cliCode: "ST_CONFIG",
    });
  });

  it("turns a non-envelope failure into a readable error", async () => {
    await expect(
      runCli(options("process.stderr.write('boom');process.exit(4)")),
    ).rejects.toBeInstanceOf(SmartTestExtensionError);
  });

  it("kills the process on cancellation", async () => {
    const controller = new AbortController();
    const running = runCli({
      ...options("setTimeout(() => {}, 10000)"),
      signal: controller.signal,
      timeoutMs: 20_000,
    });
    setTimeout(() => controller.abort(), 50);
    await expect(running).rejects.toBeInstanceOf(CancelledError);
  });

  it("kills the process on timeout and says which limit was hit", async () => {
    await expect(runCli(options("setTimeout(() => {}, 10000)", 150))).rejects.toMatchObject({
      code: "ST_EXT_TIMEOUT",
      category: "infrastructure",
    });
  });
});
