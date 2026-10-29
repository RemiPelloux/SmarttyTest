import type { SafetyMode } from "@smarttest/shared";

export type TestLayout = "mirror" | "colocated" | "domain" | "custom";
export type TestCategory = "unit" | "integration" | "e2e";
export type RiskLevel = "low" | "medium" | "high" | "critical";
export type AdapterId = "vitest" | "jest" | "node";

/** Explicit runner declaration (overrides detection). */
export interface RunnerDeclaration {
  adapter: AdapterId;
  /** Project-relative directory the runner executes from ("" = root). */
  dir?: string;
  /** Runner config file, relative to the project root. */
  config?: string;
  /** Test patterns (node --test). */
  patterns?: string[];
}
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
  /** Glob of the generated files. */
  path: string;
  policy: "exclude" | "test-source" | "rebuild-required";
  /** Generator inputs (globs). With `rebuild-required`, a change to an input stands for a change to the outputs. */
  from?: string[];
}

/** Conventions of one sub-project (a directory), overriding the top-level settings inside it. */
export interface ProjectConfig {
  tests?: {
    layout?: TestLayout;
    directory?: string;
    naming?: string;
    /** Custom location template, e.g. "backend/src/__tests__/{FileName}.test.{Extension}". */
    path?: string;
    templates?: string;
  };
  /** Minimum safety mode for changes inside this project (can only make it stricter). */
  mode?: SafetyMode;
  /** Rules scoped to this project; their paths are relative to it. */
  rules?: Rule[];
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
    /** "runner" (default): ask each runner which files it collects (cached). "static": filename patterns only. */
    discovery?: "runner" | "static";
  };
  /** Explicit runners; when set, detection is not used. */
  runners?: RunnerDeclaration[];
  generated?: GeneratedPolicy[];
  /** Extra mandatory triggers (globs). Built-in triggers can never be removed. */
  triggers?: string[];
  rules?: Rule[];
  retries?: number;
  /** Run the whole suite without analysis when it is faster than analysing (default true). */
  adaptive?: boolean;
  /** Per-project conventions, keyed by directory ("backend", "apps/web"). */
  projects?: Record<string, ProjectConfig>;
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
    discovery: "runner" | "static";
  };
  runners: RunnerDeclaration[];
  generated: GeneratedPolicy[];
  triggers: string[];
  rules: Rule[];
  retries: number;
  adaptive: boolean;
  projects: Record<string, ProjectConfig>;
  timeoutMs: number;
  workers?: number;
  reports: { formats: ReportFormat[]; outputDir: string };
  storeDir: string;
}
