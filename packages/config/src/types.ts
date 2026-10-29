import type { SafetyMode } from "@smarttest/shared";

export type TestLayout = "mirror" | "colocated" | "domain" | "custom";
export type TestCategory = "unit" | "integration" | "e2e";
export type RiskLevel = "low" | "medium" | "high" | "critical";
export type AdapterId = "vitest" | "jest";
export type ReportFormat = "html" | "json" | "junit" | "markdown";

export interface RuleMatch {
  path?: string;
  package?: string;
  class?: string;
  method?: string;
  function?: string;
  decorator?: string;
  visibility?: "public" | "protected" | "private";
  kind?: string;
  extends?: string;
  implements?: string;
}

export interface Rule {
  name: string;
  match: RuleMatch;
  require?: TestCategory[];
  coverage?: { lines?: number; branches?: number };
  risk?: RiskLevel;
  execution?: { alwaysRunOnAffected?: boolean; mode?: SafetyMode; retries?: number };
  generate?: { template?: string; path?: string };
}

export interface GeneratedPolicy {
  path: string;
  policy: "exclude" | "test-source" | "rebuild-required";
}

export interface SmartTestConfig {
  include?: string[];
  exclude?: string[];
  mode?: SafetyMode;
  adapters?: AdapterId[];
  vcs?: { provider?: "auto" | "git" | "native"; base?: string; snapshots?: boolean };
  snapshots?: { storeContent?: boolean; keep?: number };
  tests?: {
    layout?: TestLayout;
    directory?: string;
    naming?: string;
    match?: string[];
    templates?: string;
  };
  generated?: GeneratedPolicy[];
  /** Extra mandatory triggers (globs). Built-in triggers can never be removed. */
  triggers?: string[];
  rules?: Rule[];
  retries?: number;
  timeoutMs?: number;
  workers?: number;
  reports?: { formats?: ReportFormat[]; outputDir?: string };
  storeDir?: string;
}

export interface ResolvedConfig {
  include: string[];
  exclude: string[];
  mode: SafetyMode;
  adapters: AdapterId[];
  vcs: { provider: "auto" | "git" | "native"; base?: string; snapshots: boolean };
  snapshots: { storeContent: boolean; keep: number };
  tests: {
    layout?: TestLayout;
    directory: string;
    naming?: string;
    match?: string[];
    templates?: string;
  };
  generated: GeneratedPolicy[];
  triggers: string[];
  rules: Rule[];
  retries: number;
  timeoutMs: number;
  workers?: number;
  reports: { formats: ReportFormat[]; outputDir: string };
  storeDir: string;
}
