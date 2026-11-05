import type { SelectionReasonKind } from "@smarttest/shared";
import type { FileAnalysis } from "@smarttest/source-parser";
import { describe, expect, it } from "vitest";
import { measurePrecision, sumPrecision } from "./precision.js";
import { TraceView } from "./traces.js";

const analysis = (symbols: { name: string; kind: string }[]) =>
  ({
    symbols: symbols.map((s) => ({ ...s, qualifiedName: s.name })),
  }) as unknown as FileAnalysis;

const files = new Map<string, FileAnalysis>([
  [
    "src/pricing.ts",
    analysis([
      { name: "price", kind: "function" },
      { name: "discount", kind: "function" },
      { name: "Price", kind: "type" },
    ]),
  ],
]);

const trace = (executed: Record<string, string[]>, known: Record<string, string[]>) => ({
  at: "2026-11-05T00:00:00Z",
  status: "passed" as const,
  fileHashes: {},
  executed,
  known,
});

const view = new TraceView(
  {
    version: 3,
    env: "e",
    tests: {
      "price.test.ts": trace(
        { "src/pricing.ts": ["", "price"] },
        { "src/pricing.ts": ["", "price", "discount"] },
      ),
      "discount.test.ts": trace(
        { "src/pricing.ts": ["", "discount"] },
        { "src/pricing.ts": ["", "price", "discount"] },
      ),
      "other.test.ts": trace({ "src/other.ts": [""] }, { "src/other.ts": [""] }),
      "anonymous.test.ts": trace({ "src/pricing.ts": [""] }, { "src/pricing.ts": [""] }),
    },
  },
  "e",
  () => undefined,
  files,
);

const selected = (tests: string[], kind: SelectionReasonKind = "transitive-dependency") =>
  tests.map((filePath) => ({ filePath, reasons: [{ kind }] }));

const measure = (
  tests: ReturnType<typeof selected>,
  seeds = [{ file: "src/pricing.ts", units: ["price"] }],
  traces: TraceView | null = view,
) =>
  measurePrecision({
    selected: tests,
    seeds,
    files,
    dependentsOf: () => ({ tests: new Map([["unseen.test.ts", {}]]) }),
    traces,
  });

describe("selection precision", () => {
  it("counts the selected files whose trace ran the change, and those whose trace did not", () => {
    expect(measure(selected(["price.test.ts", "discount.test.ts", "other.test.ts"]))).toEqual({
      ran: 1,
      notRan: 2,
      unmeasured: 0,
      pct: 33,
    });
  });

  it("is unmeasured without traces, never 100%", () => {
    expect(measure(selected(["price.test.ts"]), undefined, null)).toEqual({
      ran: 0,
      notRan: 0,
      unmeasured: 1,
      pct: null,
    });
  });

  it("leaves what a trace cannot tell unmeasured", () => {
    // No trace; a function V8 never named; a non-code seed's test; a trigger; a type change.
    expect(measure(selected(["untraced.test.ts", "anonymous.test.ts"])).unmeasured).toBe(2);
    expect(
      measure(selected(["unseen.test.ts"]), [{ file: "src/pricing.ts", units: ["price", "@any"] }])
        .unmeasured,
    ).toBe(1);
    expect(measure(selected(["discount.test.ts"], "mandatory-trigger")).unmeasured).toBe(1);
    expect(
      measure(selected(["discount.test.ts"]), [{ file: "src/pricing.ts", units: ["Price"] }]),
    ).toEqual({ ran: 0, notRan: 0, unmeasured: 1, pct: null });
  });

  it("module code ran when the file was loaded", () => {
    expect(
      measure(selected(["discount.test.ts", "other.test.ts"]), [
        { file: "src/pricing.ts", units: ["*"] },
      ]),
    ).toEqual({ ran: 1, notRan: 1, unmeasured: 0, pct: 50 });
  });

  it("sums commits, counting a commit without a measure as unmeasured", () => {
    expect(
      sumPrecision([
        { selectedTests: 3, precision: { ran: 1, notRan: 2, unmeasured: 0, pct: 33 } },
        { selectedTests: 4 },
      ]),
    ).toEqual({ ran: 1, notRan: 2, unmeasured: 4, pct: 33 });
    expect(sumPrecision([{ selectedTests: 2 }]).pct).toBeNull();
  });
});
