/**
 * @smarttest/rules-engine — deterministic, inspectable testing policies (spec §14).
 *
 * Precedence: specificity, then declaration order. Safety-relevant fields are never weakened:
 * risk is the maximum, mode the strictest and alwaysRunOnAffected an OR across all matches.
 */
import type { RiskLevel, Rule, TestCategory } from "@smarttest/config";
import type { SafetyMode } from "@smarttest/shared";
import { globToRegExp, matchGlob, SmartTestError } from "@smarttest/shared";

export interface RuleSymbol {
  name: string;
  qualifiedName: string;
  kind: string;
  decorators: string[];
  visibility?: string;
  parent?: string;
  extends?: string;
  implements?: string[];
}

export interface RuleTarget {
  path: string;
  package?: string;
  symbol?: RuleSymbol;
}

export interface RuleMatch {
  rule: Rule;
  index: number;
  specificity: number;
}

export interface EffectivePolicy {
  risk: RiskLevel;
  require: TestCategory[];
  coverage?: { lines?: number; branches?: number };
  alwaysRunOnAffected: boolean;
  mode?: SafetyMode;
  retries?: number;
  generate?: { template?: string; path?: string };
  matched: RuleMatch[];
  conflicts: string[];
}

const RISK_ORDER: RiskLevel[] = ["low", "medium", "high", "critical"];
const MODE_ORDER: SafetyMode[] = ["fast", "balanced", "safe"];

export const maxRisk = (a: RiskLevel, b: RiskLevel): RiskLevel =>
  RISK_ORDER.indexOf(a) >= RISK_ORDER.indexOf(b) ? a : b;
export const strictestMode = (a: SafetyMode, b: SafetyMode): SafetyMode =>
  MODE_ORDER.indexOf(a) >= MODE_ORDER.indexOf(b) ? a : b;

const wild = (pattern: string, value: string | undefined) =>
  value !== undefined && globToRegExp(pattern).test(value);
const isGlob = (p: string) => /[*?{[]/.test(p);

function selectorSpecificity(rule: Rule): number {
  const m = rule.match;
  const scores: number[] = [];
  if (m.method) scores.push(6);
  if (m.function) scores.push(5);
  if (m.class) scores.push(4);
  if (m.decorator || m.extends || m.implements) scores.push(4);
  if (m.visibility || m.kind) scores.push(3);
  if (m.path)
    scores.push(
      isGlob(m.path)
        ? 2 + Math.min(0.9, (m.path.split(/[*?{[]/)[0] ?? "").split("/").length * 0.1)
        : 3.5,
    );
  if (m.package) scores.push(1);
  if (!scores.length) return 0;
  return Math.max(...scores) + (scores.length - 1) * 0.01;
}

function needsSymbol(rule: Rule): boolean {
  const m = rule.match;
  return !!(
    m.class ||
    m.method ||
    m.function ||
    m.decorator ||
    m.visibility ||
    m.kind ||
    m.extends ||
    m.implements
  );
}

export function ruleMatches(rule: Rule, target: RuleTarget): boolean {
  const m = rule.match;
  if (m.path && !matchGlob(target.path, m.path)) return false;
  if (m.package && !wild(m.package, target.package)) return false;
  if (!needsSymbol(rule)) return true;
  const s = target.symbol;
  if (!s) return false;
  if (m.class) {
    const own = s.kind === "class" && wild(m.class, s.name);
    const member = s.parent !== undefined && wild(m.class, s.parent);
    if (!own && !member) return false;
  }
  if (
    m.method &&
    !(s.kind === "method" && (wild(m.method, s.name) || wild(m.method, s.qualifiedName)))
  )
    return false;
  if (m.function && !(s.kind === "function" && wild(m.function, s.name))) return false;
  if (m.decorator && !s.decorators.some((d) => wild(m.decorator as string, d.replace(/^@/, ""))))
    return false;
  if (m.visibility && (s.visibility ?? "public") !== m.visibility) return false;
  if (m.kind && s.kind !== m.kind) return false;
  if (m.extends && !wild(m.extends, s.extends)) return false;
  if (m.implements && !(s.implements ?? []).some((i) => wild(m.implements as string, i)))
    return false;
  return true;
}

export class RulesEngine {
  constructor(readonly rules: readonly Rule[]) {}

  match(target: RuleTarget): RuleMatch[] {
    return this.rules
      .map((rule, index) => ({ rule, index, specificity: selectorSpecificity(rule) }))
      .filter((r) => ruleMatches(r.rule, target))
      .sort((a, b) => a.specificity - b.specificity || a.index - b.index);
  }

  evaluate(target: RuleTarget): EffectivePolicy {
    return this.combine(this.match(target));
  }

  /** Merges several targets (e.g. a file and all its symbols) into one policy. */
  evaluateAll(targets: readonly RuleTarget[]): EffectivePolicy {
    const seen = new Map<number, RuleMatch>();
    for (const t of targets) for (const m of this.match(t)) seen.set(m.index, m);
    return this.combine(
      [...seen.values()].sort((a, b) => a.specificity - b.specificity || a.index - b.index),
    );
  }

  private combine(matched: RuleMatch[]): EffectivePolicy {
    const policy: EffectivePolicy = {
      risk: "low",
      require: [],
      alwaysRunOnAffected: false,
      matched,
      conflicts: [],
    };
    const generators: RuleMatch[] = [];
    for (const m of matched) {
      const r = m.rule;
      if (r.risk) policy.risk = maxRisk(policy.risk, r.risk);
      if (r.require) policy.require = [...new Set([...policy.require, ...r.require])];
      if (r.coverage) policy.coverage = { ...policy.coverage, ...r.coverage };
      if (r.execution?.alwaysRunOnAffected) policy.alwaysRunOnAffected = true;
      if (r.execution?.mode)
        policy.mode = policy.mode ? strictestMode(policy.mode, r.execution.mode) : r.execution.mode;
      if (r.execution?.retries !== undefined) policy.retries = r.execution.retries;
      if (r.generate) generators.push(m);
    }
    if (policy.risk === "critical") policy.mode = "safe";
    if (generators.length) {
      const top = generators.at(-1) as RuleMatch;
      const rivals = generators.filter((g) => g.specificity === top.specificity && g !== top);
      for (const rival of rivals) {
        const a = top.rule.generate;
        const b = rival.rule.generate;
        if (
          (a?.template && b?.template && a.template !== b.template) ||
          (a?.path && b?.path && a.path !== b.path)
        ) {
          policy.conflicts.push(
            `rules "${rival.rule.name}" and "${top.rule.name}" set different generation targets with equal specificity`,
          );
        }
      }
      policy.generate = Object.assign({}, ...generators.map((g) => g.rule.generate));
    }
    return policy;
  }

  /** Throws ST_RULE_CONFLICT when a policy is ambiguous (spec §14.6). */
  assertNoConflicts(policy: EffectivePolicy): void {
    if (policy.conflicts.length) {
      throw new SmartTestError(`Rule conflict: ${policy.conflicts.join("; ")}`, {
        code: "ST_RULE_CONFLICT",
        category: "configuration",
        hint: "Make one rule more specific, or merge them. Inspect with `smarttest rules explain <path>`.",
      });
    }
  }

  /** Static validation: duplicate names and statically identical selectors with conflicting generation. */
  validate(): string[] {
    const issues: string[] = [];
    const names = new Set<string>();
    this.rules.forEach((r) => {
      if (names.has(r.name)) issues.push(`duplicate rule name "${r.name}"`);
      names.add(r.name);
    });
    for (let i = 0; i < this.rules.length; i++) {
      for (let j = i + 1; j < this.rules.length; j++) {
        const a = this.rules[i] as Rule;
        const b = this.rules[j] as Rule;
        if (JSON.stringify(a.match) !== JSON.stringify(b.match)) continue;
        if (
          (a.generate?.template &&
            b.generate?.template &&
            a.generate.template !== b.generate.template) ||
          (a.generate?.path && b.generate?.path && a.generate.path !== b.generate.path)
        ) {
          issues.push(
            `rules "${a.name}" and "${b.name}" have identical selectors but different generation targets`,
          );
        }
      }
    }
    return issues;
  }
}
