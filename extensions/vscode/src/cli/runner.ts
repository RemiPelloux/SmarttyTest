/**
 * One child process per CLI call, killed on cancellation and on timeout. The
 * runner never retries: a retry would hide a timeout or an infrastructure
 * problem that the user must see.
 */
import { spawn } from "node:child_process";
import { parseCliError } from "../core/contracts.js";
import { CancelledError, SmartTestExtensionError } from "../core/errors.js";

export interface CliRunOptions {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly env?: NodeJS.ProcessEnv;
  /** Hard cap so a runaway runner cannot exhaust the extension host. */
  readonly maxOutputBytes?: number;
}

export interface CliResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

const KILL_GRACE_MS = 3_000;
const DEFAULT_MAX_OUTPUT = 64 * 1024 * 1024;

function categoryOf(
  value: string,
): "usage" | "configuration" | "infrastructure" | "internal" | "policy" {
  switch (value) {
    case "usage":
      return "usage";
    case "config":
    case "configuration":
      return "configuration";
    case "infrastructure":
      return "infrastructure";
    case "policy":
      return "policy";
    default:
      return "internal";
  }
}

function failureFrom(result: CliResult, args: readonly string[]): SmartTestExtensionError {
  const envelope = parseCliError(result.stdout);
  const command = args[0] ?? "smarttest";
  if (envelope)
    return new SmartTestExtensionError(envelope.message, {
      code: envelope.code,
      category: categoryOf(envelope.category),
      ...(envelope.hint === undefined ? {} : { hint: envelope.hint }),
      cliCode: envelope.code,
    });
  const stderr = result.stderr.trim().split("\n").slice(-6).join("\n");
  return new SmartTestExtensionError(
    `smarttest ${command} failed with exit code ${result.exitCode}.`,
    {
      code: "ST_EXT_CLI_FAILED",
      category: "infrastructure",
      hint: stderr
        ? `stderr: ${stderr}`
        : `Run \`smarttest ${args.join(" ")}\` in a terminal to see the error.`,
    },
  );
}

export async function runCli(options: CliRunOptions): Promise<CliResult> {
  options.signal.throwIfAborted();
  const maxOutput = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
  return await new Promise<CliResult>((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(options.executable, [...options.args], {
        cwd: options.cwd,
        env: options.env ?? process.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      reject(
        new SmartTestExtensionError(
          `Could not start smarttest at ${options.executable}: ${
            error instanceof Error ? error.message : String(error)
          }`,
          {
            code: "ST_EXT_SPAWN_FAILED",
            category: "configuration",
            hint: "Set `smarttest.executablePath` to the smarttest executable or install it in the workspace.",
            cause: error,
          },
        ),
      );
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let outputOverflow = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const kill = (): void => {
      if (child.killed) return;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, KILL_GRACE_MS);
      killTimer.unref?.();
    };

    const onAbort = (): void => kill();
    options.signal.addEventListener("abort", onAbort, { once: true });

    const timeout = setTimeout(() => {
      timedOut = true;
      kill();
    }, options.timeoutMs);
    timeout.unref?.();

    const cleanup = (): void => {
      clearTimeout(timeout);
      if (killTimer !== undefined) clearTimeout(killTimer);
      options.signal.removeEventListener("abort", onAbort);
    };

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length + stderr.length > maxOutput && !outputOverflow) {
        outputOverflow = true;
        kill();
      }
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
      if (stdout.length + stderr.length > maxOutput && !outputOverflow) {
        outputOverflow = true;
        kill();
      }
    });

    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };

    child.on("error", (error) => {
      settle(() => {
        reject(
          new SmartTestExtensionError(
            `Could not run smarttest at ${options.executable}: ${error.message}`,
            {
              code:
                (error as NodeJS.ErrnoException).code === "ENOENT"
                  ? "ST_EXT_EXECUTABLE_NOT_FOUND"
                  : "ST_EXT_SPAWN_FAILED",
              category: "configuration",
              hint: "Set `smarttest.executablePath` to the smarttest executable.",
              cause: error,
            },
          ),
        );
      });
    });

    child.on("close", (code, signal) => {
      settle(() => {
        if (options.signal.aborted) {
          reject(new CancelledError());
          return;
        }
        if (timedOut) {
          reject(
            new SmartTestExtensionError(
              `smarttest ${options.args[0] ?? ""} did not finish within ${options.timeoutMs} ms.`,
              {
                code: "ST_EXT_TIMEOUT",
                category: "infrastructure",
                hint: "Raise `smarttest.analysisTimeoutMs` / `smarttest.runTimeoutMs` or narrow the change set.",
              },
            ),
          );
          return;
        }
        if (outputOverflow) {
          reject(
            new SmartTestExtensionError(
              "smarttest produced more output than the extension accepts.",
              {
                code: "ST_EXT_OUTPUT_TOO_LARGE",
                category: "infrastructure",
                hint: "Narrow the change set; the JSON output was truncated.",
              },
            ),
          );
          return;
        }
        const exitCode = code ?? (signal ? 1 : 0);
        const result = { stdout, stderr, exitCode };
        // 1 is "tests failed" for `run` and stays a valid JSON report.
        if (exitCode !== 0 && exitCode !== 1) {
          reject(failureFrom(result, options.args));
          return;
        }
        resolve(result);
      });
    });
  });
}
