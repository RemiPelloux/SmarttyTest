import { describe, expect, it } from "vitest";
import { decodeDecisionRecord, encodeDecisionRecord } from "./decision-store.js";

/** Tests selected through long chains that share their beginning, like a real decision. */
function decision(tests: number, depth: number) {
  const chain = Array.from({ length: depth }, (_, i) => `src/layer${i}/module${i}.ts#fn${i}`);
  return {
    selectedTests: Array.from({ length: tests }, (_, t) => ({
      testId: `test/t${t}.test.ts`,
      filePath: `test/t${t}.test.ts`,
      reasons: [
        {
          kind: "transitive-dependency",
          message: `Depends on ${chain[0]}`,
          path: [...chain.slice(0, 1 + (t % depth)), `test/t${t}.test.ts`],
          confidence: "high",
        },
        { kind: "rule-match", message: "rule", path: [] },
      ],
    })),
    skippedTests: [{ testId: "x", filePath: "x", reasons: ["no path"] }],
    affectedFiles: chain.map((c) => c.split("#")[0]),
    reasons: [{ kind: "fallback", message: "m" }],
    details: { runnerHits: [{ file: "a.ts", tests: ["t"], path: ["a.ts", "b.ts"] }] },
    generated: [{ path: "gen.ts", from: ["a.ts"] }],
  };
}

describe("last-decision.json", () => {
  it("gives back exactly the decision it stored, in a fraction of the size", () => {
    const record = {
      createdAt: "2026-11-01T00:00:00.000Z",
      description: "git · HEAD…working tree",
      fingerprint: "f",
      decision: decision(1200, 60),
    };
    const text = encodeDecisionRecord(record);
    expect(decodeDecisionRecord(text)).toEqual(record);
    expect(text.length).toBeLessThan(JSON.stringify(record).length / 4);
  });

  it("reads a decision stored before (paths as they are), and refuses a damaged table", () => {
    const record = { description: "d", decision: decision(3, 4) };
    expect(decodeDecisionRecord(JSON.stringify(record))).toEqual(record);
    const text = encodeDecisionRecord(record);
    const damaged = JSON.parse(text) as { paths: { nodes: number[] } };
    damaged.paths.nodes = damaged.paths.nodes.map((n, i) => (i % 2 ? n : n + 1000));
    expect(decodeDecisionRecord(JSON.stringify(damaged))).toBeUndefined();
    expect(decodeDecisionRecord("{not json")).toBeUndefined();
    expect(decodeDecisionRecord(JSON.stringify({ format: 99, decision: {} }))).toBeUndefined();
  });
});
