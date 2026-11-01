import { posix } from "node:path";
import type { ImpactResult } from "@smarttest/impact-engine";
import type { ChangeScope, Completeness, FileChange, SafetyMode } from "@smarttest/shared";
import { SmartTestError } from "@smarttest/shared";
import type { ChangeAnalysisInput } from "@smarttest/vcs-core";

/**
 * `--only`: restricts the *changed set* to some paths before selection. The dependency graph,
 * uncertainty and triggers are computed exactly as without it, so a test that cannot be ruled out
 * for the kept changes (an unresolved or dynamic import) is still selected.
 */

/** Normalises a project-relative path: forward slashes, no `./` prefix, no trailing slash. */
export function normalizeScopePath(path: string): string {
  // Normalised first: `src/../../x` must not slip past the `../` check below.
  const p = posix
    .normalize(path.replace(/\\/g, "/"))
    .replace(/^(\.\/)+/, "")
    .replace(/\/+$/, "");
  if (
    !p ||
    p === "." ||
    p.startsWith("../") ||
    p === ".." ||
    p.startsWith("/") ||
    /^[a-z]:/i.test(p)
  )
    throw new SmartTestError(`--only ${path} is not a path inside the project`, {
      code: "ST_USAGE",
      category: "usage",
      hint: "Pass a project-relative file or directory, e.g. --only src/cart.ts",
    });
  return p;
}

const covers = (scope: string, path: string) => path === scope || path.startsWith(`${scope}/`);

function matches(change: FileChange, scope: string): boolean {
  return (
    covers(scope, change.path) || (!!change.previousPath && covers(scope, change.previousPath))
  );
}

/** The input with only the changes under `paths`, and what was kept, left out and unmatched. */
export function restrictChanges(
  input: ChangeAnalysisInput,
  paths: readonly string[],
): { input: ChangeAnalysisInput; scope: ChangeScope } {
  const wanted = [...new Set(paths.map(normalizeScopePath))];
  const kept = input.changeSet.changes.filter((c) => wanted.some((w) => matches(c, w)));
  const keptSet = new Set(kept);
  const scope: ChangeScope = {
    paths: wanted,
    matched: kept.map((c) => c.path),
    unchanged: wanted.filter((w) => !kept.some((c) => matches(c, w))),
    excluded: input.changeSet.changes.filter((c) => !keptSet.has(c)).map((c) => c.path),
  };
  return {
    input: {
      ...input,
      description: `${input.description} · only ${wanted.join(", ")}`,
      changeSet: { ...input.changeSet, changes: kept },
    },
    scope,
  };
}

/** Warnings that keep a scoped selection from being read as the whole change set's. */
export function scopeWarnings(scope: ChangeScope, completeness: Completeness): string[] {
  const warnings: string[] = [];
  if (scope.unchanged.length && completeness === "unknown")
    warnings.push(
      `--only: there is no baseline to compare against, so SmartTest cannot tell whether ${scope.unchanged.join(", ")} changed`,
    );
  else if (scope.unchanged.length)
    warnings.push(
      `--only: ${scope.unchanged.join(", ")} ${scope.unchanged.length === 1 ? "has" : "have"} no change in this change set, so no test is selected for ${scope.unchanged.length === 1 ? "it" : "them"} (nothing to test is not a pass)`,
    );
  if (scope.excluded.length)
    warnings.push(
      `--only: ${scope.excluded.length} other changed file(s) were not considered (${scope.excluded.slice(0, 3).join(", ")}${scope.excluded.length > 3 ? "…" : ""}); tests affected only by them were not selected — run without --only for the whole change set`,
    );
  return warnings;
}

/**
 * Nothing under the requested paths changed (and the change set is known): no test can be
 * affected by them. Tests the engine selects for any change because an unresolved import could
 * reach it are not selected either: there is no change in scope for them to reach.
 */
export function nothingInScope(scope: ChangeScope, completeness: Completeness): boolean {
  return scope.matched.length === 0 && completeness !== "unknown";
}

/** The decision for a scope with no change: every test skipped, with the reason. */
export function unchangedScopeDecision(
  tests: readonly string[],
  scope: ChangeScope,
  mode: SafetyMode,
): ImpactResult {
  const reason = `no change in ${scope.paths.join(", ")} (--only)`;
  return {
    selectedTests: [],
    skippedTests: tests.map((t) => ({ testId: t, filePath: t, reasons: [reason] })),
    affectedFiles: [],
    affectedSymbols: [],
    analysisStatus: "complete",
    safetyMode: mode,
    requestedMode: mode,
    reasons: [],
    warnings: [],
    fallbackApplied: false,
    details: { triggers: [], seeds: [], trivialSkipped: [], ignored: [], uncertainty: [] },
  };
}
