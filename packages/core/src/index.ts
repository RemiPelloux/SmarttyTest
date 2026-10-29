/**
 * @smarttest/core — orchestration API used by the CLI (and later Studio).
 */

export type { ProjectProfile } from "@smarttest/project-detector";
export type { FileExecution, RunReport, RunSummary } from "@smarttest/report-engine";
export { ExitCode, SmartTestError, toExitCode, VERSION } from "@smarttest/shared";
export type { FilePlan, Recommendation, SetupPlan } from "@smarttest/smart-init";
export type { GenerationItem, SyncReport } from "@smarttest/test-generator";
export type { ChangeSource } from "@smarttest/vcs-core";
export { type CiContext, type CiPlan, detectCi, prepareCi } from "./ci.js";
export {
  benchmarkHistory,
  benchmarkMarkdown,
  type CommitBenchmark,
  type HistoryBenchmark,
} from "./history.js";
export * from "./smarttest.js";
export { type FlakyEntry, flakyReport, parseShard, shardFiles } from "./speed.js";
export { type Drift, detectDrift, patchConfig, type SyncResult } from "./sync.js";
export { type WatchCycle, type Watcher, watchProject } from "./watch.js";
