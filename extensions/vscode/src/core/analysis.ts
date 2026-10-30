/**
 * Per-file analysis orchestration, independent of the VS Code API:
 * graph units → one `explain <file> --units` call → protection statements.
 * A CLI without `--units` (rejected as a usage error) falls back to one bounded
 * `explain` per unit, where a single failing explain only makes that symbol
 * unknown. Any other batch failure makes every unit of the file unknown.
 */
import type { ExplainResult, GraphDump, ScanResult } from "./contracts.js";
import { isCancelledError, SmartTestExtensionError } from "./errors.js";
import type { Protection } from "./protection.js";
import { buildProtection } from "./protection.js";
import { mapLimit } from "./scheduler.js";
import { type GraphUnit, projectPathKey, unitsByFile } from "./symbols.js";

export interface FileAnalysis {
  readonly file: string;
  readonly units: readonly GraphUnit[];
  readonly protections: readonly Protection[];
  readonly warnings: readonly string[];
  readonly explainFailures: number;
  readonly truncated: boolean;
}

export interface AnalyzeFileOptions {
  readonly file: string;
  readonly graph: GraphDump;
  readonly scan: ScanResult;
  readonly maxUnits: number;
  readonly concurrency: number;
  readonly signal: AbortSignal;
  readonly explain: (unit: GraphUnit, signal: AbortSignal) => Promise<ExplainResult>;
  /** Explains every unit at once; per-unit results are read from `units`. */
  readonly explainUnits?: (
    units: readonly GraphUnit[],
    signal: AbortSignal,
  ) => Promise<ExplainResult>;
  readonly platform?: NodeJS.Platform;
  /** Per-snapshot lookup tables; built on demand when omitted. */
  readonly index?: FileIndex;
}

/** Graph units and scan warnings grouped by file, built once per snapshot. */
export interface FileIndex {
  readonly units: ReadonlyMap<string, readonly GraphUnit[]>;
  readonly warnings: ReadonlyMap<string, readonly string[]>;
  readonly platform: NodeJS.Platform;
}

export function buildFileIndex(
  graph: GraphDump,
  scan: ScanResult,
  platform: NodeJS.Platform = process.platform,
): FileIndex {
  const warnings = new Map<string, string[]>();
  const add = (file: string, warning: string): void => {
    const key = projectPathKey(file, platform);
    const list = warnings.get(key);
    if (list) list.push(warning);
    else warnings.set(key, [warning]);
  };
  for (const unresolved of scan.unresolved)
    add(unresolved.file, `unresolved import ${unresolved.specifier}`);
  for (const dynamic of scan.dynamic) add(dynamic.file, `dynamic import: ${dynamic.detail}`);
  return { units: unitsByFile(graph, platform), warnings, platform };
}

export function fileWarnings(scan: ScanResult, file: string, platform?: NodeJS.Platform): string[] {
  const key = projectPathKey(file, platform);
  const warnings: string[] = [];
  for (const unresolved of scan.unresolved)
    if (projectPathKey(unresolved.file, platform) === key)
      warnings.push(`unresolved import ${unresolved.specifier}`);
  for (const dynamic of scan.dynamic)
    if (projectPathKey(dynamic.file, platform) === key)
      warnings.push(`dynamic import: ${dynamic.detail}`);
  return warnings;
}

export async function analyzeFile(options: AnalyzeFileOptions): Promise<FileAnalysis> {
  const index =
    options.index ??
    buildFileIndex(options.graph, options.scan, options.platform ?? process.platform);
  const key = projectPathKey(options.file, index.platform);
  const units = [...(index.units.get(key) ?? [])];
  const truncated = units.length > Math.max(0, options.maxUnits);
  // A partial analysis would let the extension call a symbol "unprotected"
  // because its explain call was never made. Hide protection instead.
  const capped = truncated ? [] : units;
  const warnings = [...(index.warnings.get(key) ?? [])];
  let explainFailures = 0;

  const batch = new Map<string, ExplainResult>();
  let batchError: string | undefined;
  if (options.explainUnits && capped.length) {
    try {
      const all = await options.explainUnits(capped, options.signal);
      if (all.kind === "source" && all.units)
        for (const u of all.units) batch.set(u.unit, { ...all, tests: u.tests });
    } catch (error) {
      if (isCancelledError(error)) throw error;
      // Only an older CLI without `--units` (a usage error) is explained one unit
      // at a time below. A timeout, a crash or an unreadable answer would fail the
      // same way per unit, N times over: every unit is unknown instead.
      if (!(error instanceof SmartTestExtensionError && error.cliCode === "ST_USAGE"))
        batchError = error instanceof Error ? error.message : String(error);
    }
  }

  const protections = await mapLimit(
    capped,
    options.concurrency,
    async (unit): Promise<Protection> => {
      options.signal.throwIfAborted();
      try {
        if (batchError !== undefined) throw new Error(batchError);
        const result =
          batch.get(unit.qualifiedName) ?? (await options.explain(unit, options.signal));
        if (result.kind !== "source")
          return buildProtection({
            unitId: unit.id,
            qualifiedName: unit.qualifiedName,
            kind: unit.kind,
            graphKnowsUnit: true,
            explain: undefined,
            explainError: "smarttest explain returned a test explanation",
            fileWarnings: warnings,
          });
        return buildProtection({
          unitId: unit.id,
          qualifiedName: unit.qualifiedName,
          kind: unit.kind,
          graphKnowsUnit: true,
          explain: result,
          fileWarnings: warnings,
        });
      } catch (error) {
        if (isCancelledError(error)) throw error;
        explainFailures += 1;
        return buildProtection({
          unitId: unit.id,
          qualifiedName: unit.qualifiedName,
          kind: unit.kind,
          graphKnowsUnit: true,
          explain: undefined,
          explainError: error instanceof Error ? error.message : String(error),
          fileWarnings: warnings,
        });
      }
    },
    options.signal,
  );

  return {
    file: options.file,
    units,
    protections,
    warnings,
    explainFailures,
    truncated,
  };
}
