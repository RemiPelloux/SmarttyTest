/**
 * Turns `smarttest explain <file>#<Unit> --json` into the only statement the
 * extension is allowed to make above a symbol.
 *
 * Rules (PRD §1.5, §32.2):
 * - A symbol the graph does not know is "unknown", never "unprotected".
 * - Any recorded uncertainty makes the count "uncertain", never "protected".
 * - Zero test files means "no test reaches this symbol in the static graph",
 *   with a visible caveat; it never means "safe to change".
 */
import type { SourceExplain, Uncertainty } from "./contracts.js";

export type ProtectionState = "protected" | "unknown" | "unprotected";

export interface ProtectionInput {
  readonly unitId: string;
  readonly qualifiedName: string;
  readonly kind: "function" | "method" | "class";
  /** True when the exact `file#Unit` node exists in the graph dump. */
  readonly graphKnowsUnit: boolean;
  readonly explain: SourceExplain | undefined;
  /** Why explain could not be used (CLI error, timeout, malformed JSON). */
  readonly explainError?: string;
  /** Unresolved imports and dynamic imports recorded for this file by `scan`. */
  readonly fileWarnings?: readonly string[];
  /** True when the file was not analysed at all. */
  readonly analysisUnavailable?: boolean;
}

export interface Protection {
  readonly unitId: string;
  readonly qualifiedName: string;
  readonly kind: "function" | "method" | "class";
  readonly state: ProtectionState;
  /** Distinct test files, sorted, as project-relative POSIX paths. */
  readonly testFiles: readonly string[];
  readonly paths: Readonly<Record<string, readonly string[]>>;
  readonly uncertainty: readonly Uncertainty[];
  readonly risk: string;
  readonly rules: readonly string[];
  /** The sentence behind the state, shown in the hover and in the results view. */
  readonly reason: string;
}

export function buildProtection(input: ProtectionInput): Protection {
  const base = {
    unitId: input.unitId,
    qualifiedName: input.qualifiedName,
    kind: input.kind,
  } as const;
  if (input.analysisUnavailable)
    return unknown(base, "SmartTest has not analysed this workspace yet.");
  if (!input.graphKnowsUnit)
    return unknown(
      base,
      "SmartTest's graph has no node for this symbol, so it cannot say which tests reach it.",
    );
  if (input.explainError)
    return unknown(base, `SmartTest could not explain this symbol: ${input.explainError}`);
  if (!input.explain) return unknown(base, "SmartTest returned no explanation for this symbol.");
  if (input.explain.kind !== "source")
    return unknown(base, "SmartTest answered with a test explanation, not a source explanation.");

  const testFiles = [...new Set(input.explain.tests.map((hit) => hit.test))].sort();
  const paths: Record<string, readonly string[]> = {};
  for (const hit of input.explain.tests) {
    if (paths[hit.test] === undefined) paths[hit.test] = [...hit.path];
  }
  const uncertainty = [...input.explain.uncertainty];
  const fileWarnings = [...(input.fileWarnings ?? [])];
  const common = {
    ...base,
    testFiles,
    paths,
    uncertainty,
    risk: input.explain.risk,
    rules: input.explain.rules,
  } as const;

  if (uncertainty.length > 0 || fileWarnings.length > 0) {
    const detail =
      uncertainty.length > 0
        ? `SmartTest records uncertainty on the path from this file (${uncertainty
            .map((entry) => entry.file)
            .join(", ")}).`
        : `SmartTest could not resolve every import or dynamic import in this file (${fileWarnings.join("; ")}).`;
    const found =
      testFiles.length === 0
        ? "No test is statically reachable, but that is not proof there is none."
        : `${testFiles.length} test file${testFiles.length === 1 ? "" : "s"} are statically reachable; there may be more.`;
    return { ...common, state: "unknown", reason: `${detail} ${found}` };
  }
  if (testFiles.length > 0) {
    return {
      ...common,
      state: "protected",
      reason: `${testFiles.length} test file${testFiles.length === 1 ? "" : "s"} reach${
        testFiles.length === 1 ? "es" : ""
      } this symbol through the static graph.`,
    };
  }
  return {
    ...common,
    state: "unprotected",
    reason:
      "No test reaches this symbol through the static graph. A test that reaches it only through code SmartTest cannot resolve would not appear here.",
  };
}

function unknown(
  base: Pick<Protection, "unitId" | "qualifiedName" | "kind">,
  reason: string,
): Protection {
  return {
    ...base,
    state: "unknown",
    testFiles: [],
    paths: {},
    uncertainty: [],
    risk: "unknown",
    rules: [],
    reason,
  };
}

/** CodeLens wording. Never says "Protected by" when the state is uncertain. */
export function lensTitle(protection: Protection): string {
  const count = protection.testFiles.length;
  switch (protection.state) {
    case "protected":
      return `Protected by ${count} test${count === 1 ? "" : "s"}`;
    case "unknown":
      return count > 0
        ? `${count} known test${count === 1 ? "" : "s"} · protection uncertain`
        : "Protection unknown";
    case "unprotected":
      return "No test reaches this symbol";
  }
}

export function shortProtectionSummary(protection: Protection): string {
  const count = protection.testFiles.length;
  switch (protection.state) {
    case "protected":
      return `${count} test file${count === 1 ? "" : "s"}`;
    case "unknown":
      return "protection uncertain";
    case "unprotected":
      return "no static path from a test";
  }
}

/** Aggregate for a file, used by the status bar and the results view. */
export function summarizeFile(protections: readonly Protection[]): {
  protectedUnits: number;
  unprotectedUnits: number;
  unknownUnits: number;
  testFiles: number;
} {
  const tests = new Set<string>();
  let protectedUnits = 0;
  let unprotectedUnits = 0;
  let unknownUnits = 0;
  for (const protection of protections) {
    if (protection.state === "protected") protectedUnits += 1;
    else if (protection.state === "unprotected") unprotectedUnits += 1;
    else unknownUnits += 1;
    for (const test of protection.testFiles) tests.add(test);
  }
  return { protectedUnits, unprotectedUnits, unknownUnits, testFiles: tests.size };
}
