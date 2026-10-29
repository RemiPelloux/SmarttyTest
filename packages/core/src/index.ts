/**
 * @smarttest/core — orchestration API used by the CLI (and later Studio).
 */

export type { ProjectProfile } from "@smarttest/project-detector";
export type { FileExecution, RunReport, RunSummary } from "@smarttest/report-engine";
export { ExitCode, SmartTestError, toExitCode, VERSION } from "@smarttest/shared";
export type { FilePlan, Recommendation, SetupPlan } from "@smarttest/smart-init";
export type { GenerationItem, SyncReport } from "@smarttest/test-generator";
export type { ChangeSource } from "@smarttest/vcs-core";
export {
  benchmarkHistory,
  benchmarkMarkdown,
  type CommitBenchmark,
  type HistoryBenchmark,
} from "./history.js";
export * from "./smarttest.js";
