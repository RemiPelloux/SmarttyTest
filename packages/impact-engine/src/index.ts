/**
 * @smarttest/impact-engine — turns changes into a defensible, explainable test selection (spec §11).
 *
 * Correctness rules (spec §32.2): unknown is never "unrelated"; global changes widen scope;
 * skipped tests are reported as not run; every selection carries its reasons.
 */

import { type DependencyGraph, RESOURCE, type Seed } from "@smarttest/dependency-graph";
import { type RulesEngine, strictestMode } from "@smarttest/rules-engine";
import type { FileSemanticDiff, ResourceChange } from "@smarttest/semantic-diff";
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
import { unitOf } from "@smarttest/source-parser";

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
  /** Key-level changes of resource files (env, Prisma schema, translation catalogs). */
  resources?: ReadonlyMap<string, ResourceChange>;
  /** Generated outputs (`path` glob) and the generator inputs they are built from. */
  generated?: readonly { path: string; from: readonly string[] }[];
  /** Observed execution from runtime traces (optional). */
  traces?: TraceEvidence;
}

/** Runtime traces as seen by the impact engine. */
export interface TraceEvidence {
  /** The test has a trace whose recorded file hashes match the base of the change. */
  isFresh(test: string): boolean;
  /** Whether the test's trace ran a unit (`*`, `X`, `C.m`) of a file. */
  executed(test: string, file: string, unit: string): boolean;
  /** When the test's trace was collected. */
  collectedAt(test: string): string | undefined;
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
  /** Internal dependencies added or removed by the change, per changed file. */
  graphDiff?: { file: string; added: string[]; removed: string[] }[];
  /** Tests that static analysis reached but whose fresh trace never ran the changed code. */
  observedSkips?: { test: string; tracedAt: string }[];
  /** Changed units no test reaches, statically or in a fresh trace. */
  unprotected?: string[];
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

  /** Selects every test under a directory or depending on a file under it. */
  const selectScope = (scope: string, reason: SelectionReason) => {
    if (scope === "") return selectAll(reason);
    reasons.push(reason);
    for (const t of allTests) {
      if (inDir(t, scope) || [...graph.dependenciesOf(t)].some((d) => inDir(d, scope)))
        select(t, reason);
    }
  };
  const resourceSeeded = new Set<string>();
  /** Seeds readers of changed resource keys; returns the keys nobody reads. */
  const seedResources = (rc: ResourceChange): string[] => {
    const { seed, unmatched } = graph.resourceSeeds(rc.kind, rc.keys);
    if (seed) details.seeds.push(seed);
    resourceSeeded.add(rc.file);
    return unmatched;
  };

  // 2. Mandatory triggers (cannot be disabled by rules). An environment file whose changed keys
  // are all read by analysed code selects those readers instead.
  for (const change of changeSet.changes) {
    for (const path of [change.path, change.previousPath].filter((p): p is string => !!p)) {
      const pattern = input.triggers.find((t) => matchGlob(path, t));
      if (!pattern) continue;
      const rc = input.resources?.get(path);
      if (rc?.kind === "env" && change.type === "modified") {
        const { unmatched } = graph.resourceSeeds("env", rc.keys);
        if (!unmatched.length) {
          seedResources(rc);
          details.ignored.push(
            `${path} (keys ${rc.keys.join(", ") || "none"}; readers selected instead of trigger)`,
          );
          continue;
        }
      }
      const scope = dirOf(path);
      details.triggers.push({ file: path, pattern, scope });
      const reason: SelectionReason = {
        kind: "mandatory-trigger",
        message: `${path} changed (mandatory trigger ${pattern})${scope ? ` — scope ${scope}/` : ""}`,
      };
      selectScope(scope, reason);
    }
  }

  // 3. Seeds from changed files.
  for (const change of changeSet.changes) {
    const path = change.path;
    if (details.triggers.some((t) => t.file === path) || resourceSeeded.has(path)) continue;
    // Generated outputs: a generator input change stands for its outputs (rebuild required).
    const gens = (input.generated ?? []).filter((g) => g.from.some((f) => matchGlob(path, f)));
    if (gens.length) {
      for (const g of gens) {
        const outputs = [...input.files.keys()].filter((f) => matchGlob(f, g.path));
        warnings.push(
          `${path} changed: regenerate ${g.path} before running tests (rebuild-required)`,
        );
        if (outputs.length) for (const o of outputs) details.seeds.push({ file: o, units: ["*"] });
        else
          selectScope(dirOf(path), {
            kind: "fallback",
            message: `${path} generates ${g.path}, which is not analysed — scope ${dirOf(path) || "."}/`,
          });
      }
      continue;
    }
    const rc = input.resources?.get(path);
    if (rc && rc.kind !== "i18n") {
      const unmatched = seedResources(rc);
      if (unmatched.length)
        details.ignored.push(`${path}: ${unmatched.join(", ")} (not read by analysed code)`);
      if (rc.global)
        selectScope(dirOf(path), {
          kind: "fallback",
          message: `${path}: datasource/generator settings changed — scope ${dirOf(path) || "."}/`,
        });
      continue;
    }
    if (rc) seedResources(rc); // translations: key readers, plus the catalog's own importers below
    // Snapshot files belong to their test; manual mocks to the module they replace.
    const snap = /^(.*\/)?__snapshots__\/(.+)\.snap$/.exec(path);
    if (snap) {
      const test = `${snap[1] ?? ""}${snap[2]}`;
      if (allTests.includes(test))
        select(test, { kind: "test-file-changed", message: `Snapshot ${path} changed` });
      else details.ignored.push(`${path} (snapshot of an unknown test)`);
      continue;
    }
    const mock = /^(.*?)(?:^|\/)__mocks__\/(.+)$/.exec(path);
    if (mock) {
      const dir = mock[1] ?? "";
      const stem = (mock[2] as string).replace(/\.[cm]?[jt]sx?$/, "");
      const real = [...input.files.keys()].find(
        (f) => f.replace(/\.[cm]?[jt]sx?$/, "") === (dir ? `${dir}/${stem}` : stem) && !isTest(f),
      );
      if (real) details.seeds.push({ file: real, units: ["*"] });
      else
        selectScope(dir, {
          kind: "fallback",
          message: `Manual mock ${path} changed (mocks a dependency) — scope ${dir || "."}/`,
        });
      continue;
    }
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
      const signature = diff.changes.some((c) =>
        ["signature", "exported-api", "interface", "unclassifiable"].includes(c.kind),
      );
      const flags = {
        ...(signature ? { signature } : {}),
        ...(rc ? { referencesOnly: true } : {}),
      };
      if (diff.units.length) details.seeds.push({ file: path, units: diff.units, ...flags });
      else if (!diff.trivialOnly) details.seeds.push({ file: path, units: ["*"], ...flags });
      else
        details.seeds.push({
          file: path,
          units: [
            ...new Set(
              (input.files.get(path) as FileAnalysis).symbols
                .filter((s) => diff.changes.some((c) => c.symbolId === s.id))
                .map((s) => unitOf(s)),
            ),
          ],
        });
      if (diff.confidence === "low") partial = true;
      continue;
    }
    if (graph.hasFile(path)) {
      details.seeds.push({ file: path, units: ["*"] });
      continue;
    }
    // A non-source file referenced by analysed code (json, css…) is still tracked through the graph,
    // and so are files read through fs with a path built from the reader's location.
    const readers = graph.assetReaders(path);
    details.seeds.push(...readers);
    const traversal = graph.dependentsOf([
      { file: path, units: ["*"], ...(rc ? { referencesOnly: true } : {}) },
    ]);
    if (traversal.affectedFiles.size > 1 || traversal.tests.size)
      details.seeds.push({ file: path, units: ["*"], ...(rc ? { referencesOnly: true } : {}) });
    else if (!readers.length && !rc)
      details.ignored.push(`${path} (not part of the analysed sources)`);
  }

  // 4. Traverse the graph.
  const traversal = graph.dependentsOf(details.seeds);
  lastTraversal = traversal;
  for (const hit of traversal.tests.values()) {
    const direct = hit.depth <= 1;
    const [origin] = hit.path;
    select(hit.test, {
      kind: direct ? "direct-dependency" : "transitive-dependency",
      message: `${direct ? `Directly depends on ${origin}` : `Transitively depends on ${origin} (${hit.depth} hops)`}${hit.confidence !== "high" ? `, confidence ${hit.confidence}` : ""}`,
      path: hit.path,
      confidence: hit.confidence,
    });
  }

  // 4b. Observed evidence. Code seeds only: traces do not see env, catalogs or assets.
  const codeSeeds = details.seeds.filter((s) => s.file !== RESOURCE && input.files.has(s.file));
  const nonCodeSeeds = details.seeds.filter((s) => !codeSeeds.includes(s));
  const nonCodeTests = nonCodeSeeds.length ? graph.dependentsOf(nonCodeSeeds).tests : new Map();
  const traces = input.traces;
  const ranChange = (test: string) =>
    codeSeeds.some((s) => s.units.some((u) => traces?.executed(test, s.file, u)));
  if (traces) {
    for (const test of allTests) {
      if (selected.has(test) || !traces.isFresh(test) || !ranChange(test)) continue;
      const s = codeSeeds.find((x) => x.units.some((u) => traces.executed(test, x.file, u)));
      select(test, {
        kind: "observed-execution",
        message: `Ran ${s?.file} when traced (${traces.collectedAt(test)?.slice(0, 10)})`,
      });
    }
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

  // 5b. In BALANCED and FAST, a fresh trace that never ran the changed code rules a test out when
  // static analysis is the only reason it was selected. SAFE keeps static selections.
  const STATIC_KINDS = new Set(["direct-dependency", "transitive-dependency", "rule-match"]);
  if (traces && mode !== "safe") {
    const skips: { test: string; tracedAt: string }[] = [];
    for (const [test, rs] of [...selected]) {
      const onlyStatic = rs.every(
        (r) =>
          STATIC_KINDS.has(r.kind) && !(r.kind === "rule-match" && r.message.startsWith("Rule ")),
      );
      if (!onlyStatic || nonCodeTests.has(test) || !traces.isFresh(test) || ranChange(test))
        continue;
      selected.delete(test);
      skips.push({ test, tracedAt: traces.collectedAt(test) ?? "" });
    }
    if (skips.length) details.observedSkips = skips;
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
    if (details.observedSkips?.some((s) => s.test === t)) continue;
    // A fresh trace shows what the dynamic imports actually loaded.
    if (traces && mode !== "safe" && traces.isFresh(t) && !ranChange(t) && !nonCodeTests.has(t))
      continue;
    const u = graph.uncertaintyReachableFrom(t);
    if (u.length) uncertainTests.push({ test: t, files: u.map((x) => x.file) });
  }
  details.uncertainty = [...relevantUncertainty].map(([file, rs]) => ({ file, reasons: rs }));
  // Uncertain tests can't be ruled out: BALANCED and SAFE select them (individually, not the whole suite).
  if (mode !== "fast") {
    for (const { test, files } of uncertainTests) {
      select(test, {
        kind: "uncertainty",
        message: `Cannot be ruled out: unresolved/dynamic imports in ${files.slice(0, 3).join(", ")}${files.length > 3 ? "…" : ""}`,
      });
    }
    if (uncertainTests.length) partial = true;
  }
  // SAFE: an incomplete change analysis (unknown ranges, low-confidence diff) means the full suite.
  if (
    mode === "safe" &&
    partial &&
    !fallback &&
    (changeSet.completeness !== "complete" ||
      [...input.diffs.values()].some((d) => d.confidence === "low"))
  ) {
    selectAll({
      kind: "fallback",
      message: "SAFE mode: change analysis is incomplete — running the full suite",
    });
  } else if (mode === "fast" && uncertainTests.length) {
    warnings.push(
      `FAST mode: ${uncertainTests.length} test(s) with unresolved/dynamic dependencies were not selected — use balanced or safe to include them`,
    );
  }
  if (details.trivialSkipped.length)
    warnings.push(
      `FAST mode: comment/formatting-only changes ignored in ${details.trivialSkipped.join(", ")}`,
    );

  // 7. Changed code that no test reaches (statically or in a fresh trace).
  const unitList = codeSeeds.flatMap((s) => s.units.map((u) => ({ file: s.file, unit: u })));
  if (!fallback && unitList.length && unitList.length <= 200) {
    const unprotected: string[] = [];
    for (const { file, unit } of unitList) {
      if (unit === "*") continue;
      const reached = graph.dependentsOf([{ file, units: [unit] }]).tests.size > 0;
      const observed = traces
        ? allTests.some((t) => traces.isFresh(t) && traces.executed(t, file, unit))
        : false;
      if (!reached && !observed) unprotected.push(`${file}#${unit}`);
    }
    if (unprotected.length) details.unprotected = unprotected;
  }

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
        const obs = details.observedSkips?.find((s) => s.test === t);
        if (obs)
          return {
            testId: t,
            filePath: t,
            reasons: [
              `Reachable statically, but its trace (${obs.tracedAt.slice(0, 10)}) never ran the changed code`,
              "No mandatory trigger matched",
            ],
            confidence: "Observed execution: trace fresh for every file the test loaded",
          };
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
