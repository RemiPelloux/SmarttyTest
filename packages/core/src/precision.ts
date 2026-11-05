/**
 * Selection precision (`smarttest benchmark`): the share of selected test files that actually ran
 * the changed code, from fresh traces. Safety (missed failures) says the selection was large
 * enough; precision says how much of it was needed. A test file the traces cannot answer for is
 * unmeasured, never counted as precise: without traces, precision is unmeasured, not 100%.
 */
import { FILE_DEPENDENTS, RESOURCE, type Seed } from "@smarttest/dependency-graph";
import type { SelectionReasonKind } from "@smarttest/shared";
import type { FileAnalysis } from "@smarttest/source-parser";

export interface SelectionPrecision {
  /** Selected test files whose fresh trace ran the changed code. */
  ran: number;
  /** Selected test files whose fresh trace shows they did not run it. */
  notRan: number;
  /**
   * Selected test files the traces cannot answer for: no fresh trace, a change that is not code
   * (configuration, environment, assets, types), a function V8 does not name, or a selection
   * traces cannot see (a mandatory trigger, a rule, the full-suite fallback).
   */
  unmeasured: number;
  /** `ran / (ran + notRan)` in percent, rounded; null when no selected test file was measured. */
  pct: number | null;
}

/** What a trace says about one unit: ran, did not run, or cannot tell. */
export interface PrecisionTraces {
  isFresh(test: string): boolean;
  ran(test: string, file: string, unit: string): boolean | undefined;
}

export interface PrecisionInput {
  selected: readonly { filePath: string; reasons: readonly { kind: SelectionReasonKind }[] }[];
  seeds: readonly Seed[];
  files: { get(file: string): FileAnalysis | undefined };
  /** Tests reached from seeds traces cannot see (resources, types, catalogs, a barrel's file-level dependents). */
  dependentsOf(seeds: readonly Seed[]): { tests: ReadonlyMap<string, unknown> };
  /** Undefined or null: no traces were read. */
  traces: PrecisionTraces | undefined | null;
}

/** Reasons whose selection a trace can confirm or refute: the change's code reaching the test. */
const CODE_REASONS = new Set<SelectionReasonKind>([
  "modified-symbol",
  "direct-dependency",
  "transitive-dependency",
  "observed-execution",
  "uncertainty",
  "test-file-changed",
]);

export function percent(ran: number, notRan: number): number | null {
  return ran + notRan ? Math.round((ran / (ran + notRan)) * 100) : null;
}

export function measurePrecision(input: PrecisionInput): SelectionPrecision {
  const { selected, traces } = input;
  if (!traces) return { ran: 0, notRan: 0, unmeasured: selected.length, pct: null };
  const isType = (file: string, unit: string) =>
    !!input.files
      .get(file)
      ?.symbols.some(
        (s) =>
          !s.parent && s.qualifiedName === unit && (s.kind === "interface" || s.kind === "type"),
      );
  const code: { file: string; unit: string }[] = [];
  const nonCode: Seed[] = [];
  for (const s of input.seeds) {
    if (s.file === RESOURCE || !input.files.get(s.file) || s.referencesOnly) {
      nonCode.push(s);
      continue;
    }
    const other = s.units.filter((u) => u === FILE_DEPENDENTS || isType(s.file, u));
    if (other.length) nonCode.push({ ...s, units: other });
    for (const u of s.units) if (!other.includes(u)) code.push({ file: s.file, unit: u });
  }
  const unseen = nonCode.length ? input.dependentsOf(nonCode).tests : new Map();
  let ran = 0;
  let notRan = 0;
  let unmeasured = 0;
  for (const t of selected) {
    const test = t.filePath;
    if (!code.length || !traces.isFresh(test)) {
      unmeasured++;
      continue;
    }
    let anyUnknown = false;
    let anyRan = false;
    for (const c of code) {
      const r = traces.ran(test, c.file, c.unit);
      if (r === true) {
        anyRan = true;
        break;
      }
      if (r === undefined) anyUnknown = true;
    }
    if (anyRan) ran++;
    else if (!anyUnknown && !unseen.has(test) && t.reasons.every((r) => CODE_REASONS.has(r.kind)))
      notRan++;
    else unmeasured++;
  }
  return { ran, notRan, unmeasured, pct: percent(ran, notRan) };
}

/** Sums per-commit precision; commits without a measure count their selection as unmeasured. */
export function sumPrecision(
  commits: readonly { selectedTests: number; precision?: SelectionPrecision }[],
): SelectionPrecision {
  let ran = 0;
  let notRan = 0;
  let unmeasured = 0;
  for (const c of commits) {
    if (!c.precision) {
      unmeasured += c.selectedTests;
      continue;
    }
    ran += c.precision.ran;
    notRan += c.precision.notRan;
    unmeasured += c.precision.unmeasured;
  }
  return { ran, notRan, unmeasured, pct: percent(ran, notRan) };
}
