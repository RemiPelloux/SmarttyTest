import type { TestAdapter, TestExecution } from "@smarttest/shared";
import { describe, expect, it } from "vitest";
import { aggregateStatus, executeGroups } from "./index.js";

function fakeAdapter(script: Record<string, ("passed" | "failed")[]>): TestAdapter {
  const attempts = new Map<string, number>();
  return {
    apiVersion: 1,
    id: "fake",
    getCapabilities: () => ({
      discovery: false,
      fileSelection: true,
      testCaseSelection: false,
      coverage: false,
      tracing: false,
      parallel: false,
      cancellation: false,
      retry: false,
      sourceMaps: false,
    }),
    discover: async () => [],
    execute: async (selection) => {
      const executions: TestExecution[] = [];
      for (const f of selection.files) {
        const n = (attempts.get(f) ?? 0) + 1;
        attempts.set(f, n);
        const status = script[f]?.[n - 1] ?? "passed";
        executions.push({ testId: `${f}::t`, status, durationMs: 1, attempts: 1 });
      }
      return { adapter: "fake", executions, startedAt: "", finishedAt: "" };
    },
  };
}

describe("executeGroups", () => {
  it("runs groups in parallel within the budget, end-to-end groups alone, and bails", async () => {
    let running = 0;
    let peak = 0;
    const slow = (status: "passed" | "failed"): TestAdapter => ({
      ...fakeAdapter({}),
      execute: async (selection) => {
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 30));
        running--;
        return {
          adapter: "fake",
          executions: selection.files.map((f) => ({
            testId: `${f}::t`,
            status,
            durationMs: 1,
            attempts: 1,
          })),
          startedAt: "",
          finishedAt: "",
        };
      },
    });
    const groups = [
      { adapter: "vitest", dir: "a", files: ["a/1.test.ts"] },
      { adapter: "jest", dir: "b", files: ["b/1.test.js"] },
      { adapter: "node", dir: "c", files: ["c/1.test.js"] },
      { adapter: "playwright", dir: "e", files: ["e/1.spec.ts"] },
    ];
    const res = await executeGroups(groups, {
      createAdapter: () => slow("passed"),
      concurrency: 3,
      exclusive: ["playwright"],
    });
    expect(peak).toBe(3);
    expect(res.files.map((f) => f.status)).toEqual(["passed", "passed", "passed", "passed"]);
    const bailed = await executeGroups(groups, {
      createAdapter: (g) => slow(g.dir === "a" ? "failed" : "passed"),
      concurrency: 1,
      bail: true,
    });
    expect(bailed.files.map((f) => [f.file, f.status])).toEqual([
      ["a/1.test.ts", "failed"],
      ["b/1.test.js", "cancelled"],
      ["c/1.test.js", "cancelled"],
      ["e/1.spec.ts", "cancelled"],
    ]);
  });

  it("marks pass-after-retry as flaky, never plain passed", async () => {
    const adapter = fakeAdapter({
      "a.test.ts": ["failed", "passed"],
      "b.test.ts": ["failed", "failed"],
    });
    const res = await executeGroups(
      [{ adapter: "fake", dir: "", files: ["a.test.ts", "b.test.ts", "c.test.ts"] }],
      { createAdapter: () => adapter, retries: 1 },
    );
    const status = Object.fromEntries(res.files.map((f) => [f.file, f.status]));
    expect(status).toEqual({ "a.test.ts": "flaky", "b.test.ts": "failed", "c.test.ts": "passed" });
  });

  it("treats same-named results in one attempt as two tests, not a retry", async () => {
    let calls = 0;
    const dup: TestAdapter = {
      ...fakeAdapter({}),
      execute: async (selection) => {
        calls++;
        const f = selection.files[0] ?? "";
        // it("dup", fail); it("dup", pass): same id, same attempt, every time.
        return {
          adapter: "fake",
          executions: [
            {
              testId: `${f}::dup`,
              status: "failed",
              durationMs: 1,
              attempts: 1,
              error: { message: "boom" },
            },
            { testId: `${f}::dup`, status: "passed", durationMs: 1, attempts: 1 },
          ],
          startedAt: "",
          finishedAt: "",
        };
      },
    };
    for (const retries of [0, 1]) {
      calls = 0;
      const res = await executeGroups([{ adapter: "fake", dir: "", files: ["d.test.ts"] }], {
        createAdapter: () => dup,
        retries,
      });
      expect(res.files[0]?.status).toBe("failed");
      expect(res.files[0]?.tests[0]?.error?.message).toBe("boom");
      expect(calls).toBe(1 + retries);
    }
  });

  it("reports runner crashes as infrastructure errors", async () => {
    const res = await executeGroups([{ adapter: "x", dir: "", files: ["a.test.ts"] }], {
      createAdapter: () => {
        throw new Error("boom");
      },
    }).catch(() => undefined);
    expect(res).toBeUndefined();
    const crashing: TestAdapter = {
      ...fakeAdapter({}),
      execute: async () => Promise.reject(new Error("runner crashed")),
    };
    const res2 = await executeGroups([{ adapter: "x", dir: "", files: ["a.test.ts"] }], {
      createAdapter: () => crashing,
    });
    expect(res2.files[0]?.status).toBe("infrastructure-error");
    expect(res2.infrastructureErrors).toHaveLength(1);
  });

  /** An adapter that returns scripted runs, one per attempt, like a real adapter with `meta`. */
  const scripted = (
    runs: { executions: TestExecution[]; meta?: Record<string, unknown> }[],
  ): TestAdapter & { calls: string[][] } => {
    const calls: string[][] = [];
    return {
      ...fakeAdapter({}),
      calls,
      execute: async (selection) => {
        calls.push([...selection.files]);
        const run = runs[calls.length - 1] ?? runs.at(-1);
        return {
          adapter: "fake",
          executions: run?.executions ?? [],
          startedAt: "",
          finishedAt: "",
          ...(run?.meta ? { meta: run.meta } : {}),
        } as Awaited<ReturnType<TestAdapter["execute"]>>;
      },
    };
  };
  const ok = (testId: string): TestExecution => ({
    testId,
    status: "passed",
    durationMs: 1,
    attempts: 1,
  });

  it("fails every file of a run the runner failed outside any test (non-zero exit, nothing failed)", async () => {
    // Vitest: an unhandled error thrown from a setTimeout. Every test passed, the report says
    // `success: true`, and Vitest exits 1.
    const adapter = scripted([
      {
        executions: [ok("a.test.ts::adds"), ok("b.test.ts::subs")],
        meta: { exitCode: 1, output: "Error: unhandled boom" },
      },
    ]);
    const res = await executeGroups(
      [{ adapter: "vitest", dir: "", files: ["a.test.ts", "b.test.ts"] }],
      { createAdapter: () => adapter },
    );
    expect(res.files.map((f) => f.status)).toEqual(["failed", "failed"]);
    const run = res.files[0]?.tests.find((t) => t.testId === "a.test.ts::(run)");
    expect(run?.status).toBe("failed");
    expect(run?.error?.message).toContain("vitest exited with code 1 although no test failed");
    expect(run?.error?.message).toContain("Error: unhandled boom");
  });

  it("fails the run on errors the runner reports outside tests (Playwright globalTeardown)", async () => {
    const adapter = scripted([
      {
        executions: [ok("e2e/home.spec.js::home")],
        meta: { exitCode: 1, runErrors: ["Error: teardown boom: leaked state"] },
      },
    ]);
    const res = await executeGroups(
      [{ adapter: "playwright", dir: "", files: ["e2e/home.spec.js"] }],
      { createAdapter: () => adapter },
    );
    expect(res.files[0]?.status).toBe("failed");
    expect(res.files[0]?.error).toContain("teardown boom");
  });

  it("adds no run-level failure when a test explains the exit code, or the run exits 0", async () => {
    const failing = scripted([
      {
        executions: [
          ok("a.test.ts::adds"),
          { testId: "b.test.ts::subs", status: "failed", durationMs: 1, attempts: 1 },
        ],
        meta: { exitCode: 1 },
      },
    ]);
    const res = await executeGroups(
      [{ adapter: "x", dir: "", files: ["a.test.ts", "b.test.ts"] }],
      {
        createAdapter: () => failing,
      },
    );
    expect(res.files.map((f) => f.status)).toEqual(["passed", "failed"]);
    const clean = scripted([{ executions: [ok("a.test.ts::adds")], meta: { exitCode: 0 } }]);
    const res2 = await executeGroups([{ adapter: "x", dir: "", files: ["a.test.ts"] }], {
      createAdapter: () => clean,
    });
    expect(res2.files[0]?.status).toBe("passed");
    expect(res2.files[0]?.tests.map((t) => t.testId)).toEqual(["a.test.ts::adds"]);
  });

  it("reports failures of files the runner ran beyond the selection (a failing setup project)", async () => {
    // Playwright: `setup` fails, the selected spec depending on it is never run.
    const adapter = scripted([
      {
        executions: [
          {
            testId: "e2e/auth.setup.js::authenticate [setup]",
            status: "failed",
            durationMs: 1,
            attempts: 1,
            error: { message: "Error: setup failed" },
          },
          {
            testId: "e2e/home.spec.js::home [main]",
            status: "cancelled",
            durationMs: 0,
            attempts: 1,
          },
          ok("e2e/other.spec.js::passes beyond the selection [main]"),
        ],
        meta: { exitCode: 1 },
      },
    ]);
    const res = await executeGroups(
      [{ adapter: "playwright", dir: "", files: ["e2e/home.spec.js"] }],
      { createAdapter: () => adapter },
    );
    expect(res.files.map((f) => f.file)).toEqual(["e2e/home.spec.js"]);
    expect(res.files[0]?.status).toBe("failed");
    const run = res.files[0]?.tests.find((t) => t.testId === "e2e/home.spec.js::(run)");
    expect(run?.error?.message).toContain("e2e/auth.setup.js › authenticate [setup] failed");
    expect(run?.error?.message).toContain("Error: setup failed");
  });

  it("never lets a skip on a retry overwrite a failure", async () => {
    const adapter = scripted([
      {
        executions: [
          {
            testId: "a.test.ts::t",
            status: "failed",
            durationMs: 1,
            attempts: 1,
            error: { message: "boom" },
          },
        ],
        meta: { exitCode: 1 },
      },
      { executions: [{ testId: "a.test.ts::t", status: "skipped", durationMs: 0, attempts: 1 }] },
    ]);
    const res = await executeGroups([{ adapter: "x", dir: "", files: ["a.test.ts"] }], {
      createAdapter: () => adapter,
      retries: 1,
    });
    expect(adapter.calls).toHaveLength(2);
    expect(res.files[0]?.status).toBe("failed");
    expect(res.files[0]?.tests[0]).toMatchObject({ status: "failed", error: { message: "boom" } });
  });

  it("marks a run-level failure that does not come back on the retry as flaky", async () => {
    const adapter = scripted([
      { executions: [ok("a.test.ts::t")], meta: { exitCode: 1 } },
      { executions: [ok("a.test.ts::t")], meta: { exitCode: 0 } },
    ]);
    const res = await executeGroups([{ adapter: "x", dir: "", files: ["a.test.ts"] }], {
      createAdapter: () => adapter,
      retries: 1,
    });
    expect(adapter.calls).toHaveLength(2);
    expect(res.files[0]?.status).toBe("flaky");
  });

  it("aggregates statuses honestly", () => {
    const t = (status: TestExecution["status"]): TestExecution => ({
      testId: "x",
      status,
      durationMs: 0,
      attempts: 1,
    });
    expect(aggregateStatus([t("passed"), t("skipped")])).toBe("passed");
    expect(aggregateStatus([t("skipped")])).toBe("skipped");
    expect(aggregateStatus([t("passed"), t("flaky")])).toBe("flaky");
    expect(aggregateStatus([t("flaky"), t("failed")])).toBe("failed");
  });
});

describe("tests that share a name", () => {
  const rows = (statuses: ("passed" | "failed")[][]): TestAdapter => {
    let attempt = 0;
    return {
      ...fakeAdapter({}),
      execute: async () => {
        const now = statuses[attempt++] ?? [];
        return {
          adapter: "fake",
          executions: now.map((status) => ({
            testId: "a.test.ts::adds",
            status,
            durationMs: 1,
            attempts: 1,
          })),
          startedAt: "",
          finishedAt: "",
        };
      },
    };
  };
  const group = [{ adapter: "fake", dir: "", files: ["a.test.ts"] }];

  it("each row keeps its own id, and a failing row is not hidden by a passing one", async () => {
    const run = await executeGroups(group, {
      createAdapter: () => rows([["passed", "failed", "passed"]]),
    });
    const tests = run.files[0]?.tests ?? [];
    expect(tests.map((t) => [t.testId, t.status])).toEqual([
      ["a.test.ts::adds", "passed"],
      ["a.test.ts::adds (2)", "failed"],
      ["a.test.ts::adds (3)", "passed"],
    ]);
    expect(run.files[0]?.status).toBe("failed");
  });

  it("a retried row keeps its number, so a pass on retry is flaky for that row only", async () => {
    const run = await executeGroups(group, {
      retries: 1,
      createAdapter: () =>
        rows([
          ["passed", "failed"],
          ["passed", "passed"],
        ]),
    });
    expect(run.files[0]?.tests.map((t) => [t.testId, t.status])).toEqual([
      ["a.test.ts::adds", "passed"],
      ["a.test.ts::adds (2)", "flaky"],
    ]);
  });
});
