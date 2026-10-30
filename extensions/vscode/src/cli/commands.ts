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

export function impactArgs(options: ChangeOptions): string[] {
  return ["impact", ...changeFlags(options), "--mode", options.mode, "--json"];
}

export function runAffectedArgs(options: ChangeOptions): string[] {
  return ["run", "--affected", ...changeFlags(options), "--mode", options.mode, "--json"];
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
export function explainTarget(file: string, qualifiedName?: string): string {
  return qualifiedName ? `${file}#${qualifiedName}` : `${file}#*`;
}
