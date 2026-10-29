export interface TraceRecord {
  testId: string;
  runId: string;
  sourceFingerprint: string;
  environmentFingerprint: string;
  granularity: "suite" | "test" | "file" | "symbol";
  coveredFiles: string[];
  coveredSymbols: string[];
  collectedAt: string;
  valid: boolean;
}
