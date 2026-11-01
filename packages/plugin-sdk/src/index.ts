/**
 * @smarttest/plugin-sdk — public plugin contracts (Plugin SDK v1, frozen at 1.0.0; spec §27,
 * ADR-0005, ADR-0006). Published as `smarttest/plugin-sdk`; the conformance kit is
 * `smarttest/plugin-sdk/conformance`. Guide: documentation/guides/plugins.md.
 *
 * Contracts (the types are defined in `@smarttest/shared` and re-exported here):
 *   - runner adapters:          `TestAdapter`
 *   - version-control adapters: `VersionControlAdapter`
 *   - language analyzers:       `LanguageAnalyzer`
 *   - edge providers:           `EdgeProvider`, loaded through a `SmartTestPlugin`
 */
import type { Analyzer, Capability, EdgeProvider, SmartTestPlugin } from "@smarttest/shared";

export type {
  Capability,
  ChangeSet,
  Completeness,
  Confidence,
  CoverageArtifact,
  EdgeProvider,
  EdgeProviderCapabilities,
  EdgeProviderContext,
  EdgeProviderResult,
  ExecutionOptions,
  FileAnalysis,
  FileChange,
  GraphEdgeKind,
  ImportBinding,
  ImportKind,
  ImportRecord,
  ProvidedEdge,
  RevisionRef,
  SmartTestPlugin,
  SourcePosition,
  SourceRange,
  SymbolKind,
  SymbolRecord,
  TestAdapter,
  TestAdapterCapabilities,
  TestCase,
  TestExecution,
  TestRunResult,
  TestSelection,
  TestStatus,
  UnresolvedRelationship,
  VersionControlAdapter,
  VersionControlCapabilities,
  WorkingState,
} from "@smarttest/shared";

/** A language analyzer: turns one source file into a `FileAnalysis`. */
export type LanguageAnalyzer = Analyzer;

export {
  type ConformanceCheck,
  type ConformanceIssue,
  type ConformanceReport,
  type ConformanceStatus,
  checkTestAdapterConformance,
} from "./conformance.js";
export {
  fileOfTestId,
  type JestLikeReport,
  parseJestLikeReport,
  resolvePackageBin,
} from "./runner.js";
export {
  EDGE_PROVIDER_CAPABILITY_KEYS,
  PLUGIN_API_VERSION,
  TEST_ADAPTER_CAPABILITY_KEYS,
  VCS_CAPABILITY_KEYS,
} from "./version.js";

/** A capability counts as supported only when explicitly declared `true` (undeclared = unsupported). */
export function supports(capability: Capability | undefined): boolean {
  return capability === true;
}

export function supportsPartially(capability: Capability | undefined): boolean {
  return capability === true || capability === "partial";
}

/** Identity helper that type-checks a plugin's default export. */
export function definePlugin(plugin: SmartTestPlugin): SmartTestPlugin {
  return plugin;
}

/** Identity helper that type-checks an edge provider. */
export function defineEdgeProvider(provider: EdgeProvider): EdgeProvider {
  return provider;
}
