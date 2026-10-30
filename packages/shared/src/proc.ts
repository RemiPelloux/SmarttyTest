import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
  input?: string;
  /** Maximum captured bytes per stream. */
  maxBuffer?: number;
}

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
}

/** Environment variables to set (string) or remove (`undefined`) for child processes. */
export type EnvScope = Readonly<Record<string, string | undefined>>;

const envScope = new AsyncLocalStorage<EnvScope>();

/**
 * Runs `fn` with environment overrides applied to every child process spawned through
 * `runProcess`, including async work started by `fn`. `process.env` is never mutated, so
 * concurrent work outside the scope keeps the ambient environment.
 *
 * Scopes nest: the innermost value for a key wins. A scope override always wins over an
 * explicit `env` option, so callers cannot accidentally reintroduce a leaked hook variable.
 */
export function runWithEnvScope<T>(overrides: EnvScope, fn: () => T): T {
  const parent = envScope.getStore();
  return envScope.run({ ...parent, ...overrides }, fn);
}

/** The environment a child receives: the explicit environment (or `process.env`) plus scope. */
function childEnv(explicit: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  const scope = envScope.getStore();
  if (!scope) return explicit ?? process.env;
  const env: NodeJS.ProcessEnv = { ...(explicit ?? process.env) };
  for (const [key, value] of Object.entries(scope)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

/** Kills the whole process tree, not only the immediate child (e.g. `sh -c` grandchildren). */
function killTree(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (!pid) {
    child.kill(signal);
    return;
  }
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.on("error", () => {
      try {
        child.kill(signal);
      } catch {
        // The process is already gone.
      }
    });
    return;
  }
  try {
    // The child is a process-group leader (`detached`), so a negative pid reaches descendants.
    process.kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The process is already gone.
    }
  }
}

/** Spawns a process without a shell (no command injection via arguments). */
export function runProcess(
  command: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<RunResult> {
  const started = performance.now();
  const max = options.maxBuffer ?? 64 * 1024 * 1024;
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: childEnv(options.env),
      stdio: ["pipe", "pipe", "pipe"],
      // A new process group lets timeout/cancellation kill grandchildren spawned by `sh -c`.
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let cancelled = false;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < max) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < max) stderr += chunk.toString("utf8");
    });
    const terminate = () => {
      killTree(child, "SIGTERM");
      if (process.platform !== "win32" && !killTimer) {
        // Keep the timer referenced: if the shell exits but a grandchild ignores SIGTERM, the
        // process must not be allowed to exit before SIGKILL reaches the remaining group.
        killTimer = setTimeout(() => killTree(child, "SIGKILL"), 1500);
      }
    };
    if (options.timeoutMs)
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        terminate();
      }, options.timeoutMs);
    const onAbort = () => {
      cancelled = true;
      terminate();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (error) => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.on("close", (code, signal) => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      options.signal?.removeEventListener("abort", onAbort);
      // Do not clear killTimer while the process group still exists: a surviving grandchild
      // still needs SIGKILL after the grace period, even when the shell has already exited.
      if (killTimer && child.pid) {
        try {
          process.kill(-child.pid, 0);
        } catch {
          clearTimeout(killTimer);
          killTimer = undefined;
        }
      }
      resolvePromise({
        code,
        signal,
        stdout,
        stderr,
        timedOut,
        cancelled,
        durationMs: performance.now() - started,
      });
    });
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}
