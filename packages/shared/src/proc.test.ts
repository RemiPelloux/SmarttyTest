import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { mapLimit, runProcess, runWithEnvScope } from "./proc.js";

const dumpEnv = [
  "-e",
  "process.stdout.write(JSON.stringify([process.env.GIT_INDEX_FILE ?? null, process.env.GIT_DIR ?? null, process.env.KEEP ?? null]))",
];

describe("runWithEnvScope", () => {
  it("removes scoped keys from the ambient and explicit child environment", async () => {
    const before = {
      index: process.env.GIT_INDEX_FILE,
      dir: process.env.GIT_DIR,
      keep: process.env.KEEP,
    };
    const seen = await runWithEnvScope(
      { GIT_INDEX_FILE: undefined, GIT_DIR: undefined },
      async () => {
        const result = await runProcess(process.execPath, dumpEnv, {
          env: {
            ...process.env,
            GIT_INDEX_FILE: "/leaked/index",
            GIT_DIR: "/leaked/git",
            KEEP: "yes",
          },
        });
        return JSON.parse(result.stdout) as (string | null)[];
      },
    );
    expect(seen).toEqual([null, null, "yes"]);
    expect({
      index: process.env.GIT_INDEX_FILE,
      dir: process.env.GIT_DIR,
      keep: process.env.KEEP,
    }).toEqual(before);
  });

  it("lets an inner scope override and set values", async () => {
    const seen = await runWithEnvScope({ GIT_DIR: undefined }, () =>
      runWithEnvScope({ GIT_DIR: "/scoped/git" }, async () => {
        const result = await runProcess(process.execPath, dumpEnv, {
          env: { ...process.env, GIT_DIR: "/explicit/git" },
        });
        return JSON.parse(result.stdout) as (string | null)[];
      }),
    );
    expect(seen[1]).toBe("/scoped/git");
  });
});

describe("runProcess cancellation", () => {
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
    } catch {
      return false;
    }
    // A zombie still answers kill(0); on Linux it has already terminated.
    if (process.platform === "linux") {
      try {
        return !/\) Z /.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
      } catch {
        return true;
      }
    }
    return true;
  };

  it.skipIf(process.platform === "win32")(
    "kills the whole shell process group, including a SIGTERM-ignoring grandchild",
    async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 100);
      const result = await runProcess("sh", ["-c", 'trap "" TERM; sleep 30 & echo $!; wait'], {
        signal: controller.signal,
      });
      clearTimeout(timer);
      expect(result.cancelled).toBe(true);

      const pid = Number(result.stdout.trim().split("\n")[0]);
      expect(Number.isInteger(pid)).toBe(true);
      let running = true;
      for (let i = 0; i < 80 && running; i++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        running = alive(pid);
      }
      expect(running).toBe(false);
    },
    15_000,
  );
});

describe("mapLimit", () => {
  it("keeps input order and never exceeds the limit", async () => {
    let active = 0;
    let peak = 0;
    const out = await mapLimit([5, 1, 4, 2, 3], 2, async (n) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, n));
      active--;
      return n * 10;
    });
    expect(out).toEqual([50, 10, 40, 20, 30]);
    expect(peak).toBe(2);
  });

  it("handles an empty list", async () => {
    expect(await mapLimit([], 4, async () => 1)).toEqual([]);
  });
});
