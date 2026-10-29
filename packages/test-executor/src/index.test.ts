import type { TestAdapter, TestExecution } from "@smarttest/shared";
import { describe, expect, it } from "vitest";
import { aggregateStatus, executeGroups } from "./index.js";

function fakeAdapter(script: Record<string, ("passed" | "failed")[]>): TestAdapter {
  const attempts = new Map<string, number>();
  return {
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
