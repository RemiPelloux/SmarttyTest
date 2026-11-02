/**
 * @smarttest/impact-engine — turns changes into a defensible, explainable test selection (spec §11).
 *
 * Correctness rules (spec §32.2): unknown is never "unrelated"; global changes widen scope;
 * skipped tests are reported as not run; every selection carries its reasons.
 */

import { posix } from "node:path";
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
  /** Triggers whose change widens to the whole project, not only their directory (plugin modules). */
  globalTriggers?: readonly string[];
  rules: RulesEngine;
  packageOf?: (path: string) => string | undefined;
  /** Key-level changes of resource files (env, Prisma schema, translation catalogs). */
  resources?: ReadonlyMap<string, ResourceChange>;
  /** Generated outputs (`path` glob) and the generator inputs they are built from. */
  generated?: readonly { path: string; from: readonly string[] }[];
  /** Observed execution from runtime traces (optional). */
  traces?: TraceEvidence;
  /**
   * Project files importing a package linked to a folder outside the project (a workspace sibling):
   * importer → linked folders, relative to the project (`../shared`). A change under one of those
   * folders (`changeSet.outside`) selects the importer's tests.
   */
  outsideLinks?: ReadonlyMap<string, readonly string[]>;
  /**
   * Files a runner loads for its tests because its configuration names them (setup files, the
   * configuration's own imports, mapped modules), with the tests that depend on them.
   */
  runnerInputs?: readonly RunnerHit[];
  /**
   * Changed stylesheet → the project stylesheets that import it, directly or transitively (Sass
   * `@use`/`@import`). A partial reaches code through the stylesheets that load it.
   */
  stylesheetImporters?: ReadonlyMap<string, readonly string[]>;
  /**
   * Tests whose runner compiles and type-checks every file they import before running them
   * (Angular's `ng test`): a type error anywhere in that set fails them, whichever unit changed.
   */
  typeCheckedTests?: ReadonlySet<string>;
}

/** A changed file that a runner's configuration makes a dependency of some of its tests. */
export interface RunnerHit {
  file: string;
  tests: readonly string[];
  /** Why, for `explain`: "test/setup.ts changed — setup file of vitest (setupFiles in …)". */
  message: string;
  /** Import chain from the changed file to the file the configuration names. */
  path?: string[];
  /** The file is read by these runners only: it replaces the file's directory-wide trigger. */
  narrow?: boolean;
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
  /** Changed files a runner loads for its tests (setup files, config imports, mapped modules). */
  runnerInputs?: { file: string; message: string; tests: number }[];
}

export type ImpactResult = ImpactDecision & { details: ImpactDetails };

const inDir = (path: string, dir: string) =>
  dir === "" || path === dir || path.startsWith(`${dir}/`);
const dirOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
/** `./x`, `./x.js` and `./x.ts` can all name `x.ts`: compare paths without a module extension. */
const stripModuleExt = (path: string) => path.replace(/\.(?:[cm]?[jt]sx?|json)$/, "");

export function decideImpact(input: ImpactInput): ImpactResult {
  const { changeSet, graph, isTest } = input;
  const selected = new Map<string, SelectionReason[]>();
  /** Per selected test: `kind\0message` of its reasons and the rule names among them. */
  const reasonKeys = new Map<string, { keys: Set<string>; rules: Set<string> }>();
  /** Adds a reason to a test, selecting it; `dedupe` skips a reason of the same kind and message. */
  const addReason = (test: string, reason: SelectionReason, dedupe: boolean) => {
    let list = selected.get(test);
    let seen = reasonKeys.get(test);
    if (!list || !seen) {
      list = [];
      seen = { keys: new Set(), rules: new Set() };
      selected.set(test, list);
      reasonKeys.set(test, seen);
    }
    const k = `${reason.kind}\0${reason.message}`;
    if (dedupe && seen.keys.has(k)) return;
    seen.keys.add(k);
    if (reason.ruleName !== undefined) seen.rules.add(reason.ruleName);
    list.push(reason);
  };
  const select = (test: string, reason: SelectionReason) => addReason(test, reason, true);
  const unselect = (test: string) => {
    selected.delete(test);
    reasonKeys.delete(test);
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
  let imported: Set<string> | undefined;
  /** Files another analysed file imports (computed on first use). */
  const importedFiles = (): Set<string> => {
    if (!imported) {
      imported = new Set();
      for (const [file, a] of input.files)
        for (const i of a.imports) if (i.resolved && i.resolved !== file) imported.add(i.resolved);
    }
    return imported;
  };

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
    const users = graph.filesDependingOn((d) => inDir(d, scope));
    for (const t of allTests) if (inDir(t, scope) || users.has(t)) select(t, reason);
  };
  /**
   * Seeds for the stylesheets that import a changed stylesheet: the code that reads them by path
   * (`styleUrl`) and the modules that import them. True when there was at least one.
   */
  const stylesheetUsers = (path: string): boolean => {
    let any = false;
    for (const sheet of input.stylesheetImporters?.get(path) ?? []) {
      const readers = graph.assetReaders(sheet);
      details.seeds.push(...readers);
      const reach = graph.dependentsOf([{ file: sheet, units: ["*"] }]);
      if (reach.affectedFiles.size > 1 || reach.tests.size) {
        details.seeds.push({ file: sheet, units: ["*"] });
        any = true;
      }
      if (readers.length) any = true;
    }
    return any;
  };
  /**
   * Files whose imports name a path, read from the import specifiers rather than from resolution:
   * a deleted file no longer resolves, and a file outside the project never does.
   */
  let specifierIndex: Map<string, Set<string>> | undefined;
  const importersOf = (target: string, underDir = false): string[] => {
    if (!specifierIndex) {
      specifierIndex = new Map();
      const add = (k: string, file: string) => {
        const set = specifierIndex?.get(k) ?? new Set<string>();
        set.add(file);
        specifierIndex?.set(k, set);
      };
      for (const [file, a] of input.files) {
        for (const imp of a.imports) {
          if (imp.resolved) add(imp.resolved, file);
          const spec = imp.specifier.split("?")[0] as string;
          if (!spec.startsWith("./") && !spec.startsWith("../") && spec !== "." && spec !== "..")
            continue;
          const n = posix.normalize(posix.join(dirOf(file), spec)).replace(/\/$/, "");
          add(n, file);
          add(stripModuleExt(n), file);
        }
      }
    }
    const out = new Set<string>();
    if (underDir) {
      for (const [k, files] of specifierIndex)
        if (inDir(k, target)) for (const f of files) out.add(f);
    } else {
      const keys = [target, stripModuleExt(target)];
      if (/(^|\/)index\.[cm]?[jt]sx?$/.test(target)) keys.push(dirOf(target) || ".");
      for (const k of keys) for (const f of specifierIndex.get(k) ?? []) out.add(f);
    }
    for (const [file, dirs] of input.outsideLinks ?? [])
      if (dirs.some((d) => inDir(target, d) || (underDir && inDir(d, target)))) out.add(file);
    out.delete(target);
    return [...out].sort();
  };
  const resourceSeeded = new Set<string>();
  /** Seeds readers of changed resource keys; returns the keys nobody reads. */
  const seedResources = (rc: ResourceChange): string[] => {
    const { seed, unmatched } = graph.resourceSeeds(rc.kind, rc.keys);
    if (seed) details.seeds.push(seed);
    resourceSeeded.add(rc.file);
    return unmatched;
  };

  // 2a. Files a runner loads for its tests because its configuration names them: their change
  // selects that runner's tests (a runner's own configuration selects its tests, not every test).
  const runnerInputFiles = new Set<string>();
  const narrowed = new Set<string>();
  const known = new Set(allTests);
  const hitsByFile = new Map<string, RunnerHit[]>();
  for (const hit of input.runnerInputs ?? []) {
    const list = hitsByFile.get(hit.file);
    if (list) list.push(hit);
    else hitsByFile.set(hit.file, [hit]);
  }
  for (const change of changeSet.changes) {
    for (const path of [change.path, change.previousPath].filter((p): p is string => !!p)) {
      for (const hit of hitsByFile.get(path) ?? []) {
        const tests = hit.tests.filter((t) => known.has(t));
        if (!tests.length) continue;
        runnerInputFiles.add(path);
        if (hit.narrow) narrowed.add(path);
        const loaded = details.runnerInputs ?? [];
        details.runnerInputs = loaded;
        if (!loaded.some((r) => r.file === path && r.message === hit.message))
          loaded.push({ file: path, message: hit.message, tests: tests.length });
        for (const t of tests)
          select(t, {
            kind: "mandatory-trigger",
            message: hit.message,
            ...(hit.path ? { path: hit.path } : {}),
          });
      }
    }
  }

  // 2. Mandatory triggers (cannot be disabled by rules). An environment file whose changed keys
  // are all read by analysed code selects those readers instead.
  for (const change of changeSet.changes) {
    for (const path of [change.path, change.previousPath].filter((p): p is string => !!p)) {
      if (narrowed.has(path) && !input.globalTriggers?.some((t) => matchGlob(path, t))) continue;
      const globalPattern = input.globalTriggers?.find((t) => matchGlob(path, t));
      const pattern = globalPattern ?? input.triggers.find((t) => matchGlob(path, t));
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
      const scope = globalPattern ? "" : dirOf(path);
      details.triggers.push({ file: path, pattern, scope });
      const reason: SelectionReason = {
        kind: "mandatory-trigger",
        message: `${path} changed (mandatory trigger ${pattern})${scope ? ` — scope ${scope}/` : ""}`,
      };
      selectScope(scope, reason);
    }
  }

  // 3. Seeds from changed files.
  /** Analysed files matching each generated-output glob (computed once per glob). */
  const generatedOutputs = new Map<string, string[]>();
  const outputsOf = (glob: string): string[] => {
    let list = generatedOutputs.get(glob);
    if (!list) {
      list = [...input.files.keys()].filter((f) => matchGlob(f, glob));
      generatedOutputs.set(glob, list);
    }
    return list;
  };
  /** Analysed files by path without a module extension, in analysis order (for manual mocks). */
  let byStem: Map<string, string[]> | undefined;
  const filesByStem = (): Map<string, string[]> => {
    if (!byStem) {
      byStem = new Map();
      for (const f of input.files.keys()) {
        const k = f.replace(/\.[cm]?[jt]sx?$/, "");
        const list = byStem.get(k);
        if (list) list.push(f);
        else byStem.set(k, [f]);
      }
    }
    return byStem;
  };
  const triggerFiles = new Set(details.triggers.map((t) => t.file));
  for (const change of changeSet.changes) {
    const path = change.path;
    if (triggerFiles.has(path) || resourceSeeded.has(path)) continue;
    // Generated outputs: a generator input change stands for its outputs (rebuild required).
    const gens = (input.generated ?? []).filter((g) => g.from.some((f) => matchGlob(path, f)));
    if (gens.length) {
      for (const g of gens) {
        const outputs = outputsOf(g.path);
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
    // A submodule whose changed files could not be listed: everything that uses it.
    if (change.submodule) {
      const reason: SelectionReason = {
        kind: "fallback",
        message: `Submodule ${path} changed and the files changed inside it are unknown: tests using it are selected`,
      };
      selectScope(path, reason);
      const users = importersOf(path, true).map((file) => ({ file, units: ["*"] }));
      if (users.length)
        for (const hit of graph.dependentsOf(users).tests.values()) select(hit.test, reason);
      continue;
    }
    const rc = input.resources?.get(path);
    if (rc && rc.kind !== "i18n") {
      const unmatched = seedResources(rc);
      // Keys no analysed code reads can still be read by a library, a runner or a setup file
      // (`DATABASE_URL`): the tests under the env file's folder are selected, as for a trigger.
      if (unmatched.length && rc.kind === "env") {
        const scope = dirOf(path);
        selectScope(scope, {
          kind: "fallback",
          message: `${path}: ${unmatched.join(", ")} not read by analysed code (a library or runner may read ${unmatched.length > 1 ? "them" : "it"})${scope ? ` — scope ${scope}/` : ""}`,
        });
      } else if (unmatched.length)
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
      if (known.has(test))
        select(test, { kind: "test-file-changed", message: `Snapshot ${path} changed` });
      else details.ignored.push(`${path} (snapshot of an unknown test)`);
      continue;
    }
    const mock = /^(.*?)(?:^|\/)__mocks__\/(.+)$/.exec(path);
    if (mock) {
      const dir = mock[1] ?? "";
      const stem = (mock[2] as string).replace(/\.[cm]?[jt]sx?$/, "");
      const real = filesByStem()
        .get(dir ? `${dir}/${stem}` : stem)
        ?.find((f) => !isTest(f));
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
      // A test other files import (a helper exported from a spec) also seeds its importers.
      if (!importedFiles().has(change.previousPath ?? path)) continue;
    }
    if (change.type === "deleted" || change.type === "renamed") {
      const old = change.type === "renamed" ? (change.previousPath as string) : path;
      // Users of the old path: its graph node, code reading it through fs, and importers whose
      // specifier names it (once deleted, it no longer resolves, so it may have no node).
      const users = [
        ...(graph.hasFile(old) || input.files.has(old)
          ? [{ file: old, units: ["*"] }]
          : importersOf(old).map((file) => ({ file, units: ["*"] }))),
        ...graph.assetReaders(old),
      ];
      details.seeds.push(...users);
      const viaStylesheets = stylesheetUsers(old);
      if (!users.length && !viaStylesheets && !input.diffs.has(old))
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
    const viaStylesheets = stylesheetUsers(path);
    if (traversal.affectedFiles.size > 1 || traversal.tests.size)
      details.seeds.push({ file: path, units: ["*"], ...(rc ? { referencesOnly: true } : {}) });
    else if (!readers.length && !viaStylesheets && !rc && !runnerInputFiles.has(path))
      details.ignored.push(`${path} (not part of the analysed sources)`);
  }

  // 3b. Changes outside the project folder: the project files importing them, by relative path or
  // through a package linked to a folder outside the project.
  const outsideHits: { file: string; importers: string[] }[] = [];
  for (const change of changeSet.outside ?? []) {
    for (const file of [change.path, change.previousPath].filter((p): p is string => !!p)) {
      const importers = importersOf(file);
      if (!importers.length) continue;
      outsideHits.push({ file, importers });
      details.seeds.push(...importers.map((f) => ({ file: f, units: ["*"] })));
    }
  }
  for (const { file, importers } of outsideHits) {
    const reach = graph.dependentsOf(importers.map((f) => ({ file: f, units: ["*"] })));
    for (const hit of reach.tests.values())
      select(hit.test, {
        kind: hit.depth <= 1 ? "direct-dependency" : "transitive-dependency",
        message: `Uses ${file}, outside the project, which changed (through ${hit.path[0]?.replace(/#.*$/, "") ?? importers[0]})`,
        path: [file, ...hit.path],
        confidence: hit.confidence,
      });
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
  // Translation catalogs are read by key, so loading one says nothing about which keys ran.
  // Types never run either: a trace cannot show that a test (a Vitest type test above all) did not
  // depend on an interface or a type alias, so those units are not ruled out by traces.
  const isTypeUnit = (file: string, unit: string) =>
    !!input.files
      .get(file)
      ?.symbols.some(
        (s) =>
          !s.parent && s.qualifiedName === unit && (s.kind === "interface" || s.kind === "type"),
      );
  const codeSeeds: typeof details.seeds = [];
  const typeSeeds: typeof details.seeds = [];
  const nonCodeSeeds: typeof details.seeds = [];
  for (const s of details.seeds) {
    if (s.file === RESOURCE || !input.files.has(s.file) || s.referencesOnly) {
      nonCodeSeeds.push(s);
      continue;
    }
    const types = s.units.filter((u) => isTypeUnit(s.file, u));
    if (!types.length) codeSeeds.push(s);
    else {
      typeSeeds.push({ ...s, units: types });
      const rest = s.units.filter((u) => !types.includes(u));
      if (rest.length) codeSeeds.push({ ...s, units: rest });
    }
  }
  nonCodeSeeds.push(...typeSeeds);
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

  // 5. Rules: risk, mode upgrades, always-run. Each affected file is evaluated in order (mode
  // upgrades name the first file that raises the mode); an always-run rule selects the same tests
  // wherever it matches, so it runs once, and "Matched rule" reasons go to the tests whose path
  // starts with the file, found through an index of path origins instead of every selected test.
  const affectedFiles = [...traversal.affectedFiles].filter((f) => !isTest(f)).sort();
  if (input.rules.rules.length) {
    const withSymbols = input.rules.needsSymbols();
    const byOrigin = new Map<string, Set<string>>();
    for (const [t, rs] of selected)
      for (const r of rs) {
        const origin = r.path?.[0];
        if (origin === undefined) continue;
        const set = byOrigin.get(origin);
        if (set) set.add(t);
        else byOrigin.set(origin, new Set([t]));
      }
    const origins = [...byOrigin.keys()].sort();
    /** Tests with a reason whose path starts with `prefix` (sorted origins share a range). */
    const testsWithOrigin = (prefix: string): Set<string> => {
      let lo = 0;
      let hi = origins.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if ((origins[mid] as string) < prefix) lo = mid + 1;
        else hi = mid;
      }
      const out = new Set<string>();
      for (let i = lo; i < origins.length && (origins[i] as string).startsWith(prefix); i++)
        for (const t of byOrigin.get(origins[i] as string) ?? []) out.add(t);
      return out;
    };
    const alwaysRan = new Set<string>();
    for (const file of affectedFiles) {
      const a = input.files.get(file);
      const pkg = input.packageOf?.(file);
      // Without a symbol selector, a symbol target matches exactly when its file target does.
      const targets = [
        { path: file, ...(pkg ? { package: pkg } : {}) },
        ...(a && withSymbols
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
        const scope = m.rule.match.path;
        const key = `${m.rule.name}\0${scope ?? ""}`;
        if (alwaysRan.has(key)) continue;
        alwaysRan.add(key);
        if (!scope) continue; // no path scope: no test touches it
        // A test touches the scope when it or a file it imports (transitively) is in it.
        const users = graph.filesDependingOn((d) => matchGlob(d, scope));
        for (const t of allTests)
          if (users.has(t) || matchGlob(t, scope))
            select(t, {
              kind: "rule-match",
              message: `Rule "${m.rule.name}" always runs its tests when its scope is affected`,
              ruleName: m.rule.name,
            });
      }
      if (!policy.matched.length) continue;
      const hits = testsWithOrigin(file);
      for (const m of policy.matched)
        for (const t of hits) {
          const seen = reasonKeys.get(t);
          if (!seen || seen.rules.has(m.rule.name)) continue;
          addReason(
            t,
            {
              kind: "rule-match",
              message: `Matched rule: ${m.rule.name}${m.rule.risk ? ` (risk: ${m.rule.risk})` : ""}`,
              ruleName: m.rule.name,
            },
            false,
          );
        }
    }
  }

  // 5a. Type-checked runs: a change that is not only formatting or comments, in any file a
  // type-checked test reaches, can fail its compilation (a type error in an unused export fails
  // `ng test`). File level, in every mode; not a static reason, so traces never rule it out.
  if (input.typeCheckedTests?.size) {
    for (const [path, diff] of input.diffs) {
      if (diff.trivialOnly) continue;
      for (const hit of graph.dependentsOf([{ file: path, units: ["*"] }]).tests.values())
        if (input.typeCheckedTests.has(hit.test) && !selected.has(hit.test))
          select(hit.test, {
            kind: "mandatory-trigger",
            message: `${path} changed — its runner type-checks every file the test imports`,
          });
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
      unselect(test);
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
  const uncertainTests: { test: string; files: { file: string; reasons: string[] }[] }[] = [];
  const observedSkip = new Map((details.observedSkips ?? []).map((s) => [s.test, s]));
  for (const t of allTests) {
    if (selected.has(t)) continue;
    if (observedSkip.has(t)) continue;
    // A fresh trace shows what the dynamic imports actually loaded.
    if (traces && mode !== "safe" && traces.isFresh(t) && !ranChange(t) && !nonCodeTests.has(t))
      continue;
    // The reason names three files and whether there are more: four are enough.
    const u = graph.uncertaintyReachableFrom(t, 4);
    if (u.length) uncertainTests.push({ test: t, files: u });
  }
  details.uncertainty = [...relevantUncertainty].map(([file, rs]) => ({ file, reasons: rs }));
  // Uncertain tests can't be ruled out: BALANCED and SAFE select them (individually, not the whole suite).
  if (mode !== "fast") {
    for (const { test, files } of uncertainTests) {
      select(test, {
        kind: "uncertainty",
        // The graph's own reason (a dynamic import, an e2e visit no route serves), not a guess.
        message: `Cannot be ruled out: ${files
          .slice(0, 3)
          .map((u) => `${u.file}: ${u.reasons[0] ?? "unresolved or dynamic import"}`)
          .join("; ")}${files.length > 3 ? "…" : ""}`,
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
  const unitList = [...codeSeeds, ...typeSeeds].flatMap((s) =>
    s.units.map((u) => ({ file: s.file, unit: u })),
  );
  if (!fallback && unitList.length && unitList.length <= 200) {
    const unprotected: string[] = [];
    const origins = new Set<string>();
    for (const rs of selected.values())
      for (const r of rs) if (r.path?.[0] !== undefined) origins.add(r.path[0]);
    for (const { file, unit } of unitList) {
      if (unit === "*" || runnerInputFiles.has(file)) continue;
      // Units already on a path to a selected test are protected; others need a search.
      const reached =
        origins.has(`${file}#${unit}`) || graph.reachesAnyTest([{ file, units: [unit] }]);
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
    const observed = new Map((details.observedSkips ?? []).map((s) => [s.test, s]));
    const skippedTests: SkippedTest[] = allTests
      .filter((t) => !selected.has(t))
      .map((t) => {
        const n = graph.uncertaintyCount(t);
        const obs = observed.get(t);
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
