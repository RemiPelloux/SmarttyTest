/**
 * @smarttest/impact-engine — turns changes into a defensible, explainable test selection (spec §11).
 *
 * Correctness rules (spec §32.2): unknown is never "unrelated"; global changes widen scope;
 * skipped tests are reported as not run; every selection carries its reasons.
 */

import type { DependencyGraph, Seed } from "@smarttest/dependency-graph";
import { type RulesEngine, strictestMode } from "@smarttest/rules-engine";
import type { FileSemanticDiff } from "@smarttest/semantic-diff";
import type {
  ChangeSet,
  ImpactDecision,
  SafetyMode,
  SelectedTest,
  SelectionReason,
  SkippedTest,
} from "@smarttest/shared";
import { matchGlob } from "@smarttest/shared";
import type { FileAnalysis } from "@smarttest/source-parser";
import { topLevelSymbols } from "@smarttest/source-parser";

export interface ImpactInput {
  changeSet: ChangeSet;
  diffs: ReadonlyMap<string, FileSemanticDiff>;
  graph: DependencyGraph;
  files: ReadonlyMap<string, FileAnalysis>;
  testFiles: readonly string[];
  isTest: (path: string) => boolean;
  mode: SafetyMode;
  triggers: readonly string[];
  rules: RulesEngine;
  packageOf?: (path: string) => string | undefined;
}

export interface TriggerHit {
  file: string;
  pattern: string;
  scope: string; // "" = everything
}

export interface ImpactDetails {
  triggers: TriggerHit[];
  seeds: Seed[];
  trivialSkipped: string[];
  ignored: string[];
  uncertainty: { file: string; reasons: string[] }[];
}

export type ImpactResult = ImpactDecision & { details: ImpactDetails };

const inDir = (path: string, dir: string) =>
  dir === "" || path === dir || path.startsWith(`${dir}/`);
const dirOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

export function decideImpact(input: ImpactInput): ImpactResult {
  const { changeSet, graph, isTest } = input;
  const selected = new Map<string, SelectionReason[]>();
  const select = (test: string, reason: SelectionReason) => {
    const list = selected.get(test) ?? [];
    if (!list.some((r) => r.kind === reason.kind && r.message === reason.message))
      list.push(reason);
    selected.set(test, list);
  };
  const warnings = [...changeSet.warnings];
  const reasons: SelectionReason[] = [];
  const details: ImpactDetails = {
    triggers: [],
    seeds: [],
    trivialSkipped: [],
    ignored: [],
    uncertainty: [],
  };
  let mode = input.mode;
  let fallback = false;
  let partial = changeSet.completeness !== "complete";
  const allTests = [...input.testFiles].sort();
  let lastTraversal: ReturnType<DependencyGraph["dependentsOf"]> | undefined;

  const selectAll = (reason: SelectionReason) => {
    fallback = true;
    reasons.push(reason);
    for (const t of allTests) select(t, reason);
  };

  // 1. No baseline at all → full suite.
  if (changeSet.completeness === "unknown") {
    selectAll({
      kind: "fallback",
      message: changeSet.warnings[0] ?? "No baseline to compare against — running the full suite",
    });
    return finish();
  }

  // 2. Mandatory triggers (cannot be disabled by rules).
  for (const change of changeSet.changes) {
    for (const path of [change.path, change.previousPath].filter((p): p is string => !!p)) {
      const pattern = input.triggers.find((t) => matchGlob(path, t));
      if (!pattern) continue;
      const scope = dirOf(path);
      details.triggers.push({ file: path, pattern, scope });
      const reason: SelectionReason = {
        kind: "mandatory-trigger",
        message: `${path} changed (mandatory trigger ${pattern})${scope ? ` — scope ${scope}/` : ""}`,
      };
      if (scope === "") selectAll(reason);
      else {
        reasons.push(reason);
        for (const t of allTests) {
          if (inDir(t, scope) || [...graph.dependenciesOf(t)].some((d) => inDir(d, scope)))
            select(t, reason);
        }
      }
    }
  }

  // 3. Seeds from changed files.
  for (const change of changeSet.changes) {
    const path = change.path;
    if (details.triggers.some((t) => t.file === path)) continue;
    if (isTest(path)) {
      if (change.type !== "deleted")
        select(path, { kind: "test-file-changed", message: `Test file ${change.type}` });
      if (change.previousPath && change.type === "renamed")
        details.ignored.push(`${change.previousPath} (renamed test)`);
      continue;
    }
    if (change.type === "deleted" || change.type === "renamed") {
      const old = change.type === "renamed" ? (change.previousPath as string) : path;
      if (graph.hasFile(old) || input.files.has(old))
        details.seeds.push({ file: old, units: ["*"] });
      else if (!input.diffs.has(old))
        details.ignored.push(`${old} (${change.type}; not referenced by analysed code)`);
      if (change.type === "deleted") continue;
    }
    const diff = input.diffs.get(path);
    if (diff) {
      if (diff.trivialOnly && diff.changes.length) {
        if (mode === "fast") {
          details.trivialSkipped.push(path);
          continue;
        }
      }
      if (diff.units.length) details.seeds.push({ file: path, units: diff.units });
      else if (!diff.trivialOnly) details.seeds.push({ file: path, units: ["*"] });
      else
        details.seeds.push({
          file: path,
          units: topLevelSymbols(input.files.get(path) as FileAnalysis)
            .filter((s) => diff.changes.some((c) => c.symbolId === s.id))
            .map((s) => s.qualifiedName),
        });
      if (diff.confidence === "low") partial = true;
      continue;
    }
    if (graph.hasFile(path)) {
      details.seeds.push({ file: path, units: ["*"] });
      continue;
    }
    // A non-source file referenced by analysed code (json, css…) is still tracked through the graph.
    const traversal = graph.dependentsOf([{ file: path, units: ["*"] }]);
    if (traversal.affectedFiles.size > 1 || traversal.tests.size)
      details.seeds.push({ file: path, units: ["*"] });
    else details.ignored.push(`${path} (not part of the analysed sources)`);
  }

  // 4. Traverse the graph.
  const traversal = graph.dependentsOf(details.seeds);
  lastTraversal = traversal;
  for (const hit of traversal.tests.values()) {
    const direct = hit.depth <= 1;
    const [origin] = hit.path;
    select(hit.test, {
      kind: direct ? "direct-dependency" : "transitive-dependency",
      message: direct
        ? `Directly depends on ${origin}`
        : `Transitively depends on ${origin} (${hit.depth} hops)`,
      path: hit.path,
    });
  }

  // 5. Rules: risk, mode upgrades, always-run.
  const affectedFiles = [...traversal.affectedFiles].filter((f) => !isTest(f)).sort();
  for (const file of affectedFiles) {
    const a = input.files.get(file);
    const pkg = input.packageOf?.(file);
    const targets = [
      { path: file, ...(pkg ? { package: pkg } : {}) },
      ...(a
        ? a.symbols.map((s) => ({
            path: file,
            ...(pkg ? { package: pkg } : {}),
            symbol: {
              name: s.name,
              qualifiedName: s.qualifiedName,
              kind: s.kind,
              decorators: s.decorators,
              ...(s.visibility ? { visibility: s.visibility } : {}),
              ...(s.parent ? { parent: s.parent } : {}),
              ...(s.extends ? { extends: s.extends } : {}),
              ...(s.implements ? { implements: s.implements } : {}),
            },
          }))
        : []),
    ];
    const policy = input.rules.evaluateAll(targets);
    if (policy.mode) {
      const next = strictestMode(mode, policy.mode);
      if (next !== mode) {
        reasons.push({
          kind: "rule-match",
          message: `Mode upgraded to ${next} by rule(s) ${policy.matched.map((m) => m.rule.name).join(", ")} (${file})`,
        });
        mode = next;
      }
    }
    for (const m of policy.matched) {
      if (!m.rule.execution?.alwaysRunOnAffected) continue;
      for (const t of allTests) {
        const deps = graph.dependenciesOf(t);
        const touches =
          [...deps].some((d) => matchesRuleScope(m.rule.match.path, d)) ||
          (m.rule.match.path ? matchGlob(t, m.rule.match.path) : false);
        if (touches)
          select(t, {
            kind: "rule-match",
            message: `Rule "${m.rule.name}" always runs its tests when its scope is affected`,
            ruleName: m.rule.name,
          });
      }
    }
    for (const m of policy.matched) {
      for (const t of selected.keys()) {
        const sel = selected.get(t);
        if (
          sel?.some((r) => r.path?.[0]?.startsWith(file)) &&
          !sel.some((r) => r.ruleName === m.rule.name)
        ) {
          sel.push({
            kind: "rule-match",
            message: `Matched rule: ${m.rule.name}${m.rule.risk ? ` (risk: ${m.rule.risk})` : ""}`,
            ruleName: m.rule.name,
          });
        }
      }
    }
  }

  // 6. Uncertainty handling, per (effective) mode.
  const relevantUncertainty = new Map<string, string[]>();
  for (const f of affectedFiles) {
    const u = graph.uncertainty.get(f);
    if (u) relevantUncertainty.set(f, u);
  }
  const uncertainTests: { test: string; files: string[] }[] = [];
  for (const t of allTests) {
    if (selected.has(t)) continue;
    const u = graph.uncertaintyReachableFrom(t);
    if (u.length) uncertainTests.push({ test: t, files: u.map((x) => x.file) });
  }
  details.uncertainty = [...relevantUncertainty].map(([file, rs]) => ({ file, reasons: rs }));
  if (
    mode === "safe" &&
    (partial || relevantUncertainty.size || uncertainTests.length) &&
    !fallback
  ) {
    selectAll({
      kind: "fallback",
      message: partial
        ? "SAFE mode: change analysis is incomplete — running the full suite"
        : "SAFE mode: unresolved dependencies could hide relationships — running the full suite",
    });
  } else if (mode === "balanced") {
    for (const { test, files } of uncertainTests) {
      select(test, {
        kind: "uncertainty",
        message: `Cannot be ruled out: unresolved/dynamic imports in ${files.slice(0, 3).join(", ")}${files.length > 3 ? "…" : ""}`,
      });
    }
    if (uncertainTests.length) partial = true;
  } else if (mode === "fast" && uncertainTests.length) {
    warnings.push(
      `FAST mode: ${uncertainTests.length} test(s) with unresolved/dynamic dependencies were not selected — use balanced or safe to include them`,
    );
  }
  if (details.trivialSkipped.length)
    warnings.push(
      `FAST mode: comment/formatting-only changes ignored in ${details.trivialSkipped.join(", ")}`,
    );

  return finish();

  function finish(): ImpactResult {
    const selectedTests: SelectedTest[] = [...selected]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([test, rs]) => ({ testId: test, filePath: test, reasons: rs }));
    const unresolvedTotal = (t: string) => graph.uncertaintyReachableFrom(t).length;
    const skippedTests: SkippedTest[] = allTests
      .filter((t) => !selected.has(t))
      .map((t) => {
        const n = unresolvedTotal(t);
        return {
          testId: t,
          filePath: t,
          reasons: [
            "No static dependency path from changed code",
            "No mandatory trigger matched",
            "No rule requires it",
          ],
          confidence: `Limited to the analysed dependency model (${n} file(s) with unresolved imports in its dependencies)`,
        };
      });
    const affectedSymbols = [...traversal_units()].sort();
    return {
      selectedTests,
      skippedTests,
      affectedFiles: [...new Set([...changeSet.changes.map((c) => c.path), ...affected()])].sort(),
      affectedSymbols,
      analysisStatus: fallback ? "fallback" : partial ? "partial" : "complete",
      safetyMode: mode,
      requestedMode: input.mode,
      reasons,
      warnings,
      fallbackApplied: fallback,
      details,
    };
  }
  function affected(): string[] {
    return lastTraversal ? [...lastTraversal.affectedFiles] : [];
  }
  function traversal_units(): Set<string> {
    return new Set(
      [...(lastTraversal?.affectedUnits ?? [])].filter(
        (u) => !u.endsWith("#*") && !u.endsWith("#@any"),
      ),
    );
  }
}

function matchesRuleScope(pattern: string | undefined, path: string): boolean {
  return pattern ? matchGlob(path, pattern) : false;
}

/** Explanation for one test, for `smarttest explain`. */
export function explainTest(
  decision: ImpactDecision,
  test: string,
): {
  status: "selected" | "skipped" | "unknown";
  reasons: string[];
  confidence?: string;
  path?: string[];
} {
  const norm = (p: string) => p.replace(/^\.\//, "");
  const s = decision.selectedTests.find(
    (t) => t.filePath === norm(test) || t.filePath.endsWith(`/${norm(test)}`),
  );
  if (s)
    return {
      status: "selected",
      reasons: s.reasons.map((r) => r.message),
      ...(s.reasons.find((r) => r.path)?.path
        ? { path: s.reasons.find((r) => r.path)?.path as string[] }
        : {}),
    };
  const k = decision.skippedTests.find(
    (t) => t.filePath === norm(test) || t.filePath.endsWith(`/${norm(test)}`),
  );
  if (k)
    return {
      status: "skipped",
      reasons: k.reasons,
      ...(k.confidence ? { confidence: k.confidence } : {}),
    };
  return { status: "unknown", reasons: ["Not a known test file in the last analysis"] };
}
