/**
 * Argument builders for the public CLI. Flags match `smarttest <command> --help`
 * at SmartTest 0.8.0; the extension adds no private flags.
 */

import type { SafetyMode } from "../core/contracts.js";
import type { ChangeSource } from "../core/settings.js";

export interface ChangeOptions {
  readonly mode: SafetyMode;
  readonly changeSource: ChangeSource;
  readonly baseRef?: string;
}

function changeFlags(options: ChangeOptions): string[] {
  if (options.changeSource === "staged") return ["--staged"];
  if (options.changeSource === "base") {
    if (!options.baseRef?.trim()) return ["--uncommitted"];
    return ["--base", options.baseRef.trim()];
  }
  return ["--uncommitted"];
}

/**
 * `--only=<path>` (SmartTest 1.0.0+): restrict the change set to these project-relative files.
 * The `=` form keeps a path that starts with `-` from being read as another option.
 */
function onlyFlags(only: readonly string[] | undefined): string[] {
  for (const path of only ?? [])
    if (!path || path.includes("\0"))
      throw new Error("Refusing to pass an empty or NUL-containing path to --only.");
  return (only ?? []).map((path) => `--only=${path}`);
}

export function impactArgs(options: ChangeOptions, only?: readonly string[]): string[] {
  return ["impact", ...changeFlags(options), ...onlyFlags(only), "--mode", options.mode, "--json"];
}

export function runAffectedArgs(options: ChangeOptions, only?: readonly string[]): string[] {
  return [
    "run",
    "--affected",
    ...changeFlags(options),
    ...onlyFlags(only),
    "--mode",
    options.mode,
    "--json",
  ];
}

export function explainArgs(target: string): string[] {
  if (target.startsWith("-") || target.includes("\0"))
    throw new Error("Refusing to pass an option-looking target to smarttest explain.");
  return ["explain", target, "--json"];
}

export function scanArgs(): string[] {
  return ["scan", "--json"];
}

export function graphArgs(): string[] {
  return ["graph", "--format", "json"];
}

/** `file#Class.method`, `file#fn` or `file#*` — never an absolute path. */
/** One analysis for every unit of a file (`--units`, SmartTest 0.9.0+). */
export function explainUnitsArgs(file: string, units: readonly string[]): string[] {
  if (file.startsWith("-") || file.includes("\0") || units.some((u) => u.includes(",")))
    throw new Error("Refusing to pass an option-looking or ambiguous target to smarttest explain.");
  return ["explain", file, "--units", units.join(","), "--json"];
}

export function explainTarget(file: string, qualifiedName?: string): string {
  return qualifiedName ? `${file}#${qualifiedName}` : `${file}#*`;
}
