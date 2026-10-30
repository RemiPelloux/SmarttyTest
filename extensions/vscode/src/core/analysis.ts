/**
 * Per-file analysis orchestration, independent of the VS Code API:
 * graph units → one `explain` per unit → protection statements. Explain calls
 * are bounded and a single failing explain only makes that symbol unknown.
 */
import type { ExplainResult, GraphDump, ScanResult } from "./contracts.js";
import { isCancelledError } from "./errors.js";
import { sameProjectPath } from "./paths.js";
import type { Protection } from "./protection.js";
import { buildProtection } from "./protection.js";
import { mapLimit } from "./scheduler.js";
import { type GraphUnit, unitsForFile } from "./symbols.js";

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
  readonly platform?: NodeJS.Platform;
}

export function fileWarnings(scan: ScanResult, file: string, platform?: NodeJS.Platform): string[] {
  const warnings: string[] = [];
  for (const unresolved of scan.unresolved) {
    if (sameProjectPath(unresolved.file, file, platform))
      warnings.push(`unresolved import ${unresolved.specifier}`);
  }
  for (const dynamic of scan.dynamic) {
    if (sameProjectPath(dynamic.file, file, platform))
      warnings.push(`dynamic import: ${dynamic.detail}`);
  }
  return warnings;
}

export async function analyzeFile(options: AnalyzeFileOptions): Promise<FileAnalysis> {
  const units = unitsForFile(options.graph, options.file, options.platform);
  const truncated = units.length > Math.max(0, options.maxUnits);
  // A partial analysis would let the extension call a symbol "unprotected"
  // because its explain call was never made. Hide protection instead.
  const capped = truncated ? [] : units;
  const warnings = fileWarnings(options.scan, options.file, options.platform);
  let explainFailures = 0;

  const protections = await mapLimit(
    capped,
    options.concurrency,
    async (unit): Promise<Protection> => {
      options.signal.throwIfAborted();
      try {
        const result = await options.explain(unit, options.signal);
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
