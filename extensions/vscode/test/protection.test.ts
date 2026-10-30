import { describe, expect, it } from "vitest";
import type { SourceExplain } from "../src/core/contracts.js";
import {
  buildProtection,
  lensTitle,
  type ProtectionInput,
  summarizeFile,
} from "../src/core/protection.js";

const explain: SourceExplain = {
  kind: "source",
  target: "src/a.ts#A.run",
  description: "2 tests reach A.run",
  tests: [
    { test: "test/b.test.ts", path: ["src/a.ts", "test/b.test.ts"] },
    { test: "test/a.test.ts", path: ["src/a.ts", "test/a.test.ts"] },
    { test: "test/b.test.ts", path: ["src/a.ts", "test/b.test.ts"] },
  ],
  uncertainty: [],
  rules: ["transitive-dependency"],
  risk: "medium",
};

function input(overrides: Partial<ProtectionInput> = {}): ProtectionInput {
  return {
    unitId: "src/a.ts#A.run",
    qualifiedName: "A.run",
    kind: "method",
    graphKnowsUnit: true,
    explain,
    ...overrides,
  };
}

describe("protection", () => {
  it("deduplicates test files and reports protected", () => {
    const protection = buildProtection(input());
    expect(protection.state).toBe("protected");
    expect(protection.testFiles).toEqual(["test/a.test.ts", "test/b.test.ts"]);
    expect(protection.paths["test/b.test.ts"]).toEqual(["src/a.ts", "test/b.test.ts"]);
    expect(lensTitle(protection)).toBe("Protected by 2 tests");
  });

  it("never calls an unknown graph unit unprotected", () => {
    const protection = buildProtection(input({ graphKnowsUnit: false }));
    expect(protection.state).toBe("unknown");
    expect(lensTitle(protection)).toBe("Protection unknown");
    expect(protection.reason).toContain("cannot say");
  });

  it("turns any recorded uncertainty into unknown, even with tests", () => {
    const protection = buildProtection(
      input({
        explain: {
          ...explain,
          uncertainty: [{ file: "src/a.ts", reasons: ["dynamic import"] }],
        },
      }),
    );
    expect(protection.state).toBe("unknown");
    expect(protection.testFiles).toHaveLength(2);
    expect(lensTitle(protection)).toBe("2 known tests · protection uncertain");
  });

  it("treats unresolved imports in the file as uncertainty", () => {
    const protection = buildProtection(input({ fileWarnings: ["unresolved import ./x"] }));
    expect(protection.state).toBe("unknown");
    expect(protection.reason).toContain("unresolved import");
  });

  it("reports no static path without promising safety", () => {
    const protection = buildProtection(
      input({ explain: { ...explain, tests: [], rules: [], risk: "low" } }),
    );
    expect(protection.state).toBe("unprotected");
    expect(lensTitle(protection)).toBe("No test reaches this symbol");
    expect(protection.reason).toContain("would not appear here");
  });

  it("stays unknown when explain failed or analysis was never run", () => {
    expect(buildProtection(input({ explain: undefined, explainError: "timeout" })).state).toBe(
      "unknown",
    );
    expect(buildProtection(input({ analysisUnavailable: true })).state).toBe("unknown");
    expect(buildProtection(input({ explain: undefined })).state).toBe("unknown");
  });

  it("summarises a file without merging unknown into unprotected", () => {
    const protections = [
      buildProtection(input()),
      buildProtection(input({ graphKnowsUnit: false, unitId: "src/a.ts#B" })),
      buildProtection(
        input({
          unitId: "src/a.ts#C",
          explain: { ...explain, tests: [], uncertainty: [] },
        }),
      ),
    ];
    expect(summarizeFile(protections)).toEqual({
      protectedUnits: 1,
      unprotectedUnits: 1,
      unknownUnits: 1,
      testFiles: 2,
    });
  });
});
