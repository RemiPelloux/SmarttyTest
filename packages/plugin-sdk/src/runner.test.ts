import { describe, expect, it } from "vitest";
import { parseJestLikeReport } from "./runner.js";

// Shapes recorded from Vitest 5's JSON reporter.
const file = (status: string, message: string, assertions: [string, string][]) => ({
  testResults: [
    {
      name: "/p/test/numbers.test.ts",
      status,
      message,
      startTime: 1,
      endTime: 3,
      assertionResults: assertions.map(([title, s]) => ({
        ancestorTitles: ["d"],
        fullName: `d ${title}`,
        title,
        status: s,
        failureMessages: [],
      })),
    },
  ],
});

describe("parseJestLikeReport", () => {
  it("records a failing beforeAll as a failure, and its skipped tests as not run", () => {
    // beforeAll throws inside describe: the file is failed with an empty message, the test skipped.
    const r = parseJestLikeReport(file("failed", "", [["clamps", "skipped"]]), "/p");
    expect(r.map((e) => [e.testId, e.status])).toEqual([
      ["test/numbers.test.ts::(suite)", "failed"],
      ["test/numbers.test.ts::d clamps", "cancelled"],
    ]);
    expect(r[0]?.error?.message).toContain("failed outside its tests");
  });

  it("records a failing afterAll as a failure even though every test passed", () => {
    for (const message of ["", "afterAll boom"]) {
      const r = parseJestLikeReport(file("failed", message, [["clamps", "passed"]]), "/p");
      expect(r.map((e) => [e.testId, e.status])).toEqual([
        ["test/numbers.test.ts::(suite)", "failed"],
        ["test/numbers.test.ts::d clamps", "passed"],
      ]);
    }
  });

  it("adds nothing when an assertion explains the failure, and keeps real skips in passing files", () => {
    const failing = parseJestLikeReport(
      file("failed", "", [
        ["a", "failed"],
        ["b", "skipped"],
      ]),
      "/p",
    );
    expect(failing.map((e) => e.status)).toEqual(["failed", "skipped"]);
    const passing = parseJestLikeReport(
      file("passed", "", [
        ["a", "passed"],
        ["b", "skipped"],
      ]),
      "/p",
    );
    expect(passing.map((e) => e.status)).toEqual(["passed", "skipped"]);
  });
});
