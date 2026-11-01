import { DependencyGraph } from "@smarttest/dependency-graph";
import { analyzeSource } from "@smarttest/language-typescript";
import { RulesEngine } from "@smarttest/rules-engine";
import type { FileSemanticDiff } from "@smarttest/semantic-diff";
import type { FileAnalysis } from "@smarttest/source-parser";
import { describe, expect, it } from "vitest";
import { decideImpact } from "./index.js";

type Rule = ConstructorParameters<typeof RulesEngine>[0][number];

/*
 * Reasons are part of the contract (`explain`, reports): these pin their exact content and order
 * for rules and uncertainty, which are computed once per rule and in one backward pass instead of
 * once per affected file and per test.
 */
const sources: Record<string, string> = {
  "src/core/base.ts": "export const base = () => 1;\n",
  "src/core/base2.ts": 'import { base } from "./base";\nexport const base2 = () => base();\n',
  "src/auth/guard.ts":
    'import { base2 } from "../core/base2";\nexport class Guard { check() { return base2(); } }\n',
  "src/auth/session.ts":
    'import { Guard } from "./guard";\nexport const session = () => new Guard().check();\n',
  "src/feature/view.ts":
    'import { session } from "../auth/session";\nexport const view = () => session();\n',
  "src/lazy/a.ts": "export const la = (p: string) => import(p);\n",
  "src/lazy/b.ts": "export const lb = (p: string) => import(p);\n",
  "src/lazy/c.ts": "export const lc = (p: string) => import(p);\n",
  "src/lazy/d.ts": "export const ld = (p: string) => import(p);\n",
  "src/lazy/all.ts":
    'import { la } from "./a";\nimport { lb } from "./b";\nimport { lc } from "./c";\nimport { ld } from "./d";\nexport const all = [la, lb, lc, ld];\n',
  "test/base.test.ts": 'import { base } from "../src/core/base";\nbase();\n',
  "test/guard.test.ts": 'import { Guard } from "../src/auth/guard";\nnew Guard();\n',
  "test/view.test.ts": 'import { view } from "../src/feature/view";\nview();\n',
  "test/auth/session.test.ts": 'import { session } from "../../src/auth/session";\nsession();\n',
  "test/lazy.test.ts": 'import { all } from "../src/lazy/all";\nall;\n',
  "test/lazy-a.test.ts": 'import { la } from "../src/lazy/a";\nla;\n',
  "test/other.test.ts": "export {};\n",
};

function decide(changed: string[], rules: Rule[], mode: "fast" | "balanced" | "safe") {
  const files = new Map<string, FileAnalysis>();
  for (const [p, c] of Object.entries(sources)) {
    const an = analyzeSource(p, c);
    for (const imp of an.imports)
      if (imp.specifier.startsWith(".")) {
        const parts = p.split("/").slice(0, -1);
        for (const seg of imp.specifier.split("/")) {
          if (seg === "..") parts.pop();
          else if (seg !== ".") parts.push(seg);
        }
        imp.resolved = `${parts.join("/")}.ts`;
      }
    files.set(p, an);
  }
  const isTest = (p: string) => p.includes(".test.");
  const diffs = new Map<string, FileSemanticDiff>(
    changed.map((path) => [
      path,
      {
        path,
        units: ["*"],
        trivialOnly: false,
        confidence: "high",
        changes: [{ filePath: path, kind: "implementation", confidence: "high" }],
      },
    ]),
  );
  return decideImpact({
    changeSet: {
      provider: "git",
      completeness: "complete",
      warnings: [],
      changes: changed.map((path) => ({ type: "modified" as const, path })),
    },
    diffs,
    graph: new DependencyGraph(files, isTest),
    files,
    testFiles: [...files.keys()].filter(isTest),
    isTest,
    mode,
    triggers: [],
    rules: new RulesEngine(rules),
  });
}

const reasons = (d: ReturnType<typeof decide>) =>
  Object.fromEntries(
    d.selectedTests.map((t) => [t.filePath, t.reasons.map((r) => `${r.kind}: ${r.message}`)]),
  );

const RULES: Rule[] = [
  { name: "src", match: { path: "src/**" }, risk: "medium" },
  { name: "auth", match: { path: "src/auth/**" }, execution: { alwaysRunOnAffected: true } },
  { name: "guards", match: { class: "Guard" }, risk: "high", execution: { mode: "safe" } },
  { name: "no-scope", match: { function: "view" }, execution: { alwaysRunOnAffected: true } },
  // A rule whose name repeats another: still applied, with its own scope.
  {
    name: "auth",
    match: { path: "src/feature/**" },
    execution: { alwaysRunOnAffected: true },
  },
];

describe("decideImpact · rule reasons", () => {
  it("adds each matched rule once per test, in file order, and runs always-run rules once", () => {
    const d = decide(["src/core/base.ts"], RULES, "balanced");
    expect(d.safetyMode).toBe("safe");
    expect(d.reasons.map((r) => r.message)).toEqual([
      "Mode upgraded to safe by rule(s) src, auth, guards (src/auth/guard.ts)",
    ]);
    expect(reasons(d)).toEqual({
      "test/auth/session.test.ts": [
        "transitive-dependency: Transitively depends on src/core/base.ts (4 hops)",
        'rule-match: Rule "auth" always runs its tests when its scope is affected',
        "rule-match: Matched rule: src (risk: medium)",
      ],
      "test/base.test.ts": [
        "direct-dependency: Directly depends on src/core/base.ts",
        "rule-match: Matched rule: src (risk: medium)",
      ],
      "test/guard.test.ts": [
        "transitive-dependency: Transitively depends on src/core/base.ts (3 hops)",
        'rule-match: Rule "auth" always runs its tests when its scope is affected',
        "rule-match: Matched rule: src (risk: medium)",
      ],
      "test/view.test.ts": [
        "transitive-dependency: Transitively depends on src/core/base.ts (5 hops)",
        'rule-match: Rule "auth" always runs its tests when its scope is affected',
        "rule-match: Matched rule: src (risk: medium)",
      ],
      "test/lazy.test.ts": [
        "uncertainty: Cannot be ruled out: src/lazy/d.ts: dynamic import/require (line 1: import(p)); src/lazy/c.ts: dynamic import/require (line 1: import(p)); src/lazy/b.ts: dynamic import/require (line 1: import(p))…",
      ],
      "test/lazy-a.test.ts": [
        "uncertainty: Cannot be ruled out: src/lazy/a.ts: dynamic import/require (line 1: import(p))",
      ],
    });
    expect(d.skippedTests.map((t) => [t.filePath, t.confidence])).toEqual([
      [
        "test/other.test.ts",
        "Limited to the analysed dependency model (0 file(s) with unresolved imports in its dependencies)",
      ],
    ]);
  });

  it("FAST leaves uncertain tests out and counts their unresolved files", () => {
    const d = decide(["src/feature/view.ts"], [], "fast");
    expect(d.selectedTests.map((t) => t.filePath)).toEqual(["test/view.test.ts"]);
    expect(
      Object.fromEntries(d.skippedTests.map((t) => [t.filePath, t.confidence?.match(/\d+/)?.[0]])),
    ).toEqual({
      "test/auth/session.test.ts": "0",
      "test/base.test.ts": "0",
      "test/guard.test.ts": "0",
      "test/lazy-a.test.ts": "1",
      "test/lazy.test.ts": "4",
      "test/other.test.ts": "0",
    });
  });
});
