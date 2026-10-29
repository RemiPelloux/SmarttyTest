/** Zero-based, end-exclusive source position. */
export interface SourcePosition {
  line: number;
  column: number;
}

export interface SourceRange {
  start: SourcePosition;
  end: SourcePosition;
}

/**
 * Where a piece of evidence came from. SmartTest never mixes evidence
 * without keeping its provenance (spec §10.6).
 */
export type Provenance = "static" | "dynamic" | "rule" | "heuristic" | "user";

/** Explicit confidence. "unknown" must never be treated as "unrelated" (spec §32.2). */
export type Confidence = "high" | "medium" | "low" | "unknown";

export type Completeness = "complete" | "partial" | "unknown";

export type SafetyMode = "fast" | "balanced" | "safe";

/** A capability that is not declared as supported must be treated as unsupported (spec §27.5). */
export type Capability = boolean | "partial";
