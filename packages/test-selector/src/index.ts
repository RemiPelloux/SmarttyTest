/**
 * @smarttest/test-selector — turns an impact decision into runnable groups per runner root.
 */
import type { ImpactDecision } from "@smarttest/shared";
import { type AdapterId, assignRunner, type RunnerRoot } from "@smarttest/test-discovery";

export interface ExecutionGroup {
  adapter: AdapterId;
  /** Project-relative directory the runner executes from. */
  dir: string;
  configFile?: string;
  patterns?: string[];
  files: string[];
}

export interface ExecutionPlan {
  groups: ExecutionGroup[];
  unassigned: string[];
}

export const rootKey = (root: RunnerRoot): string =>
  `${root.adapter}:${root.dir}:${root.configFile ?? ""}`;

/**
 * Groups tests per runner root. With runner-based discovery, `assignment` says which root
 * collected each file; otherwise the deepest root containing the file is used.
 */
export function planExecution(
  tests: readonly string[],
  roots: readonly RunnerRoot[],
  preferred?: readonly AdapterId[],
  assignment?: ReadonlyMap<string, RunnerRoot>,
): ExecutionPlan {
  const groups = new Map<string, ExecutionGroup>();
  const unassigned: string[] = [];
  for (const t of tests) {
    const root = assignment ? assignment.get(t) : assignRunner(t, roots, preferred);
    if (!root) {
      unassigned.push(t);
      continue;
    }
    const k = rootKey(root);
    const g = groups.get(k) ?? {
      adapter: root.adapter,
      dir: root.dir,
      ...(root.configFile ? { configFile: root.configFile } : {}),
      ...(root.patterns ? { patterns: root.patterns } : {}),
      files: [],
    };
    g.files.push(t);
    groups.set(k, g);
  }
  return { groups: [...groups.values()], unassigned };
}

export function planFromDecision(
  decision: ImpactDecision,
  roots: readonly RunnerRoot[],
  preferred?: readonly AdapterId[],
  assignment?: ReadonlyMap<string, RunnerRoot>,
): ExecutionPlan {
  return planExecution(
    decision.selectedTests.map((t) => t.filePath),
    roots,
    preferred,
    assignment,
  );
}
