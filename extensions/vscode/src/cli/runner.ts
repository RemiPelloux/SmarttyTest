/**
 * One child process per CLI call, killed on cancellation and on timeout. The
 * runner never retries: a retry would hide a timeout or an infrastructure
 * problem that the user must see.
 */
import { spawn } from "node:child_process";
import { hasRunReport, parseCliError } from "../core/contracts.js";
import { CancelledError, SmartTestExtensionError } from "../core/errors.js";

export interface CliRunOptions {
  readonly executable: string;
  /** Placed before `args`: the CLI's JS entry when Node runs it. Not part of the command. */
  readonly leadingArgs?: readonly string[];
  /** The smarttest command and its options; `args[0]` names the command. */
  readonly args: readonly string[];
  readonly cwd: string;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly env?: NodeJS.ProcessEnv;
  /** Hard cap so a runaway runner cannot exhaust the extension host. */
  readonly maxOutputBytes?: number;
  /**
   * Windows batch shim (`smarttest.cmd`) with no JS entry to run directly: start
   * it through cmd.exe, with every argument quoted and unsafe ones refused.
   */
  readonly shell?: boolean;
  /** Time between SIGTERM and SIGKILL. */
  readonly killGraceMs?: number;
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

/**
 * One cmd.exe command line for a batch shim. Node no longer starts `.cmd` files
 * without a shell (CVE-2024-27980), and cmd.exe expands `%`, `^`, `&`, `|`, `<`,
 * `>` and `!` even inside quotes, so an argument containing one is refused rather
 * than escaped.
 */
export function windowsShellCommand(executable: string, args: readonly string[]): string {
  const unsafe = /["%^&|<>!\r\n]/;
  for (const value of [executable, ...args])
    if (unsafe.test(value))
      throw new SmartTestExtensionError(
        `Cannot pass ${JSON.stringify(value)} to ${executable} through cmd.exe safely.`,
        {
          code: "ST_EXT_UNSAFE_ARGUMENT",
          category: "configuration",
          hint: "Set `smarttest.executablePath` to the CLI's JavaScript entry (for example node_modules/smarttest/dist/bin.js) so no shell is needed.",
        },
      );
  return [executable, ...args].map((value) => `"${value}"`).join(" ");
}

export async function runCli(options: CliRunOptions): Promise<CliResult> {
  options.signal.throwIfAborted();
  const maxOutput = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
  const killGraceMs = options.killGraceMs ?? KILL_GRACE_MS;
  // Its own process group on POSIX, so a kill also reaches the test runners it started.
  const group = process.platform !== "win32";
  return await new Promise<CliResult>((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      const spawnOptions = {
        cwd: options.cwd,
        env: options.env ?? process.env,
        stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"],
        windowsHide: true,
        detached: group,
      };
      const argv = [...(options.leadingArgs ?? []), ...options.args];
      child = options.shell
        ? spawn(windowsShellCommand(options.executable, argv), { ...spawnOptions, shell: true })
        : spawn(options.executable, argv, spawnOptions);
    } catch (error) {
      if (error instanceof SmartTestExtensionError) {
        reject(error);
        return;
      }
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

    // `child.killed` only says a signal was sent; whether the process exited is
    // read from its exit code and signal.
    const exited = (): boolean => child.exitCode !== null || child.signalCode !== null;
    const signalChild = (signal: NodeJS.Signals): void => {
      if (group && child.pid !== undefined) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          // The group is gone or was never created; signal the child itself.
        }
      }
      if (process.platform === "win32" && child.pid !== undefined && !exited()) {
        // Windows has no process groups and `kill` ends only cmd.exe or node:
        // end the whole tree, test runners included.
        const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        });
        killer.on("error", () => child.kill(signal));
        return;
      }
      child.kill(signal);
    };
    const kill = (): void => {
      if (killTimer !== undefined) return;
      if (exited() && !group) {
        // Windows: the CLI is gone, so `taskkill /T` can no longer find the runners it
        // started, and one of them may still hold stdout open. Stop waiting for it.
        child.stdout?.destroy();
        child.stderr?.destroy();
        return;
      }
      signalChild("SIGTERM");
      killTimer = setTimeout(() => {
        // The CLI may have exited while a runner it started still holds stdout open.
        signalChild("SIGKILL");
      }, killGraceMs);
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
        // 1 is "tests failed" for `run` and stays a valid JSON report. A run that
        // exits 4 (infrastructure) or 70 (integrity) still writes its report, and
        // that report is what the user must see; the envelope is the fallback.
        if (
          exitCode !== 0 &&
          exitCode !== 1 &&
          !(options.args[0] === "run" && hasRunReport(stdout))
        ) {
          reject(failureFrom(result, options.args));
          return;
        }
        resolve(result);
      });
    });
  });
}
