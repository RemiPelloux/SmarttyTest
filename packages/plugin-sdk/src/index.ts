/**
 * @smarttest/plugin-sdk — public plugin contracts and capability helpers (spec §27, ADR-0005).
 */
import type {
  Capability,
  TestAdapter,
  TestAdapterCapabilities,
  VersionControlCapabilities,
} from "@smarttest/shared";

export type {
  Capability,
  ChangeSet,
  CoverageArtifact,
  ExecutionOptions,
  FileChange,
  LanguageAdapter,
  RevisionRef,
  SourceSymbol,
  SymbolGraph,
  TestAdapter,
  TestAdapterCapabilities,
  TestCase,
  TestExecution,
  TestRunResult,
  TestSelection,
  TestStatus,
  TestTarget,
  VersionControlAdapter,
  VersionControlCapabilities,
  WorkingState,
} from "@smarttest/shared";

/** A capability counts as supported only when explicitly declared `true` (undeclared = unsupported). */
export function supports(capability: Capability | undefined): boolean {
  return capability === true;
}

export function supportsPartially(capability: Capability | undefined): boolean {
  return capability === true || capability === "partial";
}

export {
  fileOfTestId,
  type JestLikeReport,
  parseJestLikeReport,
  resolvePackageBin,
} from "./runner.js";

export const TEST_ADAPTER_CAPABILITY_KEYS: (keyof TestAdapterCapabilities)[] = [
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

export const VCS_CAPABILITY_KEYS: (keyof VersionControlCapabilities)[] = [
  "branches",
  "stagedChanges",
  "untrackedFiles",
  "renameDetection",
  "mergeBase",
  "fileContentAtRevision",
];

export interface ConformanceIssue {
  capability: string;
  message: string;
}

/**
 * Minimal conformance kit: verifies that an adapter declares every capability explicitly
 * and that declared discovery actually works.
 */
export async function checkTestAdapterConformance(
  adapter: TestAdapter,
): Promise<ConformanceIssue[]> {
  const issues: ConformanceIssue[] = [];
  const caps = adapter.getCapabilities() as unknown as Record<string, unknown>;
  for (const key of TEST_ADAPTER_CAPABILITY_KEYS) {
    const v = caps[key];
    if (v !== true && v !== false && v !== "partial")
      issues.push({
        capability: key,
        message: 'capability must be declared as true, false or "partial"',
      });
  }
  if (caps.discovery === true) {
    try {
      const cases = await adapter.discover();
      if (!Array.isArray(cases))
        issues.push({ capability: "discovery", message: "discover() must return an array" });
    } catch (error) {
      issues.push({
        capability: "discovery",
        message: `discover() threw: ${(error as Error).message}`,
      });
    }
  }
  return issues;
}
