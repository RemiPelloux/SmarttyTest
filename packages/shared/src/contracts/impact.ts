import type { Confidence, SafetyMode } from "../primitives.js";

export type SelectionReasonKind =
  | "modified-symbol"
  | "direct-dependency"
  | "transitive-dependency"
  | "observed-execution"
  | "rule-match"
  | "mandatory-trigger"
  | "fallback"
  | "uncertainty"
  | "test-file-changed";

export interface SelectionReason {
  kind: SelectionReasonKind;
  message: string;
  /** Path through the graph that justifies the reason, if any. */
  path?: string[];
  ruleName?: string;
  /** Lowest edge confidence along the path. */
  confidence?: Confidence;
}

export interface SelectedTest {
  testId: string;
  filePath: string;
  reasons: SelectionReason[];
}

export interface SkippedTest {
  testId: string;
  filePath: string;
  /** Why the test was not selected — skipped tests are never reported as passed (spec §1.5). */
  reasons: string[];
  confidence?: string;
}

export interface ImpactDecision {
  selectedTests: SelectedTest[];
  skippedTests: SkippedTest[];
  affectedFiles: string[];
  affectedSymbols: string[];
  analysisStatus: "complete" | "partial" | "fallback";
  /** Effective mode after rule/risk upgrades. */
  safetyMode: SafetyMode;
  requestedMode?: SafetyMode;
  reasons: SelectionReason[];
  warnings: string[];
  fallbackApplied: boolean;
}
