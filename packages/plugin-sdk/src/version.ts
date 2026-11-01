import type {
  EdgeProviderCapabilities,
  TestAdapterCapabilities,
  VersionControlCapabilities,
} from "@smarttest/shared";

/**
 * Version of the plugin API (the contracts exported by this package). Every adapter, analyzer,
 * edge provider and plugin declares the version it implements as `apiVersion`. It changes only in
 * a major release of SmartTest; additions within a version are optional members.
 */
export const PLUGIN_API_VERSION = 1 as const;

export const TEST_ADAPTER_CAPABILITY_KEYS: readonly (keyof TestAdapterCapabilities)[] = [
  "discovery",
  "fileSelection",
  "testCaseSelection",
  "coverage",
  "tracing",
  "parallel",
  "cancellation",
  "retry",
  "sourceMaps",
];

export const VCS_CAPABILITY_KEYS: readonly (keyof VersionControlCapabilities)[] = [
  "branches",
  "stagedChanges",
  "untrackedFiles",
  "renameDetection",
  "mergeBase",
  "fileContentAtRevision",
];

export const EDGE_PROVIDER_CAPABILITY_KEYS: readonly (keyof EdgeProviderCapabilities)[] = [
  "fileEdges",
  "unresolved",
  "nonSourceFiles",
];
