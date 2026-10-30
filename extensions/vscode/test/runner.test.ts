import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runCli, windowsShellCommand } from "../src/cli/runner.js";
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

  const runReport = readFileSync(new URL("./fixtures/run.json", import.meta.url), "utf8");

  it("keeps the report of a run that exits 4 or 70", async () => {
    for (const code of [4, 70]) {
      const script = `process.stdout.write(${JSON.stringify(runReport)});process.exit(${code})`;
      const result = await runCli({
        ...options(script),
        leadingArgs: ["-e", script],
        args: ["run"],
      });
      expect(result.exitCode).toBe(code);
      expect(result.stdout).toContain('"command": "run"');
    }
  });

  it("reads the error envelope when an exit-4 run has no report", async () => {
    const script = `process.stdout.write(JSON.stringify({schemaVersion:1,error:{code:"ST_INFRA",category:"infrastructure",message:"git failed"}}));process.exit(4)`;
    await expect(
      runCli({ ...options(script), leadingArgs: ["-e", script], args: ["run"] }),
    ).rejects.toMatchObject({ code: "ST_INFRA", category: "infrastructure" });
  });

  it("does not accept a run report from another command's failure", async () => {
    const script = `process.stdout.write(${JSON.stringify(runReport)});process.exit(4)`;
    await expect(runCli(options(script))).rejects.toBeInstanceOf(SmartTestExtensionError);
  });

  it("escalates to SIGKILL when the CLI ignores SIGTERM", async () => {
    const started = Date.now();
    const script = "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)";
    await expect(runCli({ ...options(script, 150), killGraceMs: 200 })).rejects.toMatchObject({
      code: "ST_EXT_TIMEOUT",
    });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it.skipIf(process.platform === "win32")(
    "kills the test runners the CLI started, not only the CLI",
    async () => {
      // The grandchild inherits stdout, so the CLI cannot settle until it is gone too.
      const script = `require("node:child_process").spawn(process.execPath,["-e","process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:"inherit"});process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`;
      const started = Date.now();
      await expect(runCli({ ...options(script, 200), killGraceMs: 200 })).rejects.toMatchObject({
        code: "ST_EXT_TIMEOUT",
      });
      expect(Date.now() - started).toBeLessThan(5_000);
    },
  );

  it("quotes every argument for cmd.exe and refuses characters it would expand", () => {
    expect(windowsShellCommand("C:\\bin\\smarttest.cmd", ["explain", "src/a b.ts#A.run"])).toBe(
      '"C:\\bin\\smarttest.cmd" "explain" "src/a b.ts#A.run"',
    );
    for (const bad of ["a&b", "%PATH%", "a|b", 'a"b', "a^b", "a<b", "a>b", "a!b", "a\nb"])
      expect(() => windowsShellCommand("smarttest.cmd", [bad])).toThrow(SmartTestExtensionError);
  });
});
