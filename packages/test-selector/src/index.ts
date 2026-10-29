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
  files: string[];
}

export interface ExecutionPlan {
  groups: ExecutionGroup[];
  unassigned: string[];
}

export function planExecution(
  tests: readonly string[],
  roots: readonly RunnerRoot[],
  preferred?: readonly AdapterId[],
): ExecutionPlan {
  const groups = new Map<string, ExecutionGroup>();
  const unassigned: string[] = [];
  for (const t of tests) {
    const root = assignRunner(t, roots, preferred);
    if (!root) {
      unassigned.push(t);
      continue;
    }
    const k = `${root.adapter}:${root.dir}`;
    const g = groups.get(k) ?? {
      adapter: root.adapter,
      dir: root.dir,
      ...(root.configFile ? { configFile: root.configFile } : {}),
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
): ExecutionPlan {
  return planExecution(
    decision.selectedTests.map((t) => t.filePath),
    roots,
    preferred,
  );
}
