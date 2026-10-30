/**
 * @smarttest/studio — the local SmartTest web app.
 *
 * `startStudio` binds a loopback server, analyses the project's current change and serves the
 * Studio UI. It never binds a public interface and every API call needs the session token that is
 * printed in the URL fragment.
 */

export {
  STUDIO_SCHEMA_VERSION,
  type StudioAnalysisInfo,
  type StudioChange,
  type StudioChangeFile,
  type StudioChangeSourceRequest,
  type StudioCounts,
  type StudioFileIndex,
  type StudioImpact,
  type StudioOverview,
  type StudioProject,
  type StudioRun,
  type StudioRunEvent,
  type StudioRunFile,
  type StudioRunState,
  type StudioRunVerdict,
  type StudioSelectedTest,
  type StudioSelectionReason,
  type StudioSkippedTest,
  type StudioSource,
  type StudioSourceUnit,
  type StudioTestResult,
  type StudioTestRow,
  type StudioTests,
  type StudioTraces,
  type StudioTrust,
} from "./contracts.js";
export { isLoopbackHostname, originAllowed, tokensMatch } from "./security.js";
export type { StartStudioOptions, StudioServerHandle } from "./server.js";
export { findAssetDir, startStudio } from "./server.js";
export { runVerdictOf } from "./snapshot.js";
