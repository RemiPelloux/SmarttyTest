/**
 * Plugin SDK v1 conformance kit (ADR-0005). Test-framework agnostic: each `check*` function runs
 * a suite of checks against an adapter and a fixture you provide and returns a report. Use
 * `assertConformance(report)` to throw (with every failure listed) from any test runner, or read
 * `report.checks` yourself.
 *
 *   import { assertConformance, checkRunnerAdapter } from "smarttest/plugin-sdk/conformance";
 *   assertConformance(await checkRunnerAdapter(new MyAdapter(opts), { expectedFiles: ["a.test.ts"] }));
 *
 * Every built-in adapter of SmartTest passes this kit in SmartTest's own test suite.
 */
import type {
  Analyzer,
  Capability,
  ChangeSet,
  Confidence,
  EdgeProvider,
  EdgeProviderContext,
  EdgeProviderResult,
  ExecutionOptions,
  FileAnalysis,
  FileChange,
  GraphEdgeKind,
  RevisionRef,
  SmartTestPlugin,
  TestAdapter,
  TestCase,
  TestRunResult,
  TestStatus,
  VersionControlAdapter,
} from "@smarttest/shared";
import { fileOfTestId } from "./runner.js";
import {
  EDGE_PROVIDER_CAPABILITY_KEYS,
  PLUGIN_API_VERSION,
  TEST_ADAPTER_CAPABILITY_KEYS,
  VCS_CAPABILITY_KEYS,
} from "./version.js";

export type ConformanceStatus = "pass" | "fail" | "skip";

export interface ConformanceCheck {
  /** Stable check name, e.g. "runner.discovery.paths". */
  name: string;
  status: ConformanceStatus;
  message?: string;
}

export interface ConformanceReport {
  kind: "runner" | "vcs" | "language" | "edge-provider" | "plugin";
  /** The adapter's id (or plugin name). */
  subject: string;
  checks: ConformanceCheck[];
  /** True when no check failed. */
  ok: boolean;
}

/** A failed conformance check (kept for the 0.x `checkTestAdapterConformance` API). */
export interface ConformanceIssue {
  capability: string;
  message: string;
}

const TEST_STATUSES: readonly TestStatus[] = [
  "passed",
  "failed",
  "skipped",
  "pending",
  "cancelled",
  "timed-out",
  "cached-pass",
  "cached-failure",
  "flaky",
  "infrastructure-error",
];
const EDGE_KINDS: readonly GraphEdgeKind[] = [
  "IMPORTS",
  "EXPORTS",
  "CALLS",
  "REFERENCES",
  "EXTENDS",
  "IMPLEMENTS",
  "INSTANTIATES",
  "DEPENDS_ON",
  "TESTS",
  "COVERS",
  "OBSERVED_EXECUTION",
  "CONFIGURES",
];
const CONFIDENCES: readonly Confidence[] = ["high", "medium", "low", "unknown"];
const CHANGE_TYPES: readonly FileChange["type"][] = ["added", "modified", "deleted", "renamed"];

/** A project-relative POSIX path that stays inside the project. */
export function isProjectRelativePath(p: unknown): p is string {
  return (
    typeof p === "string" &&
    p.length > 0 &&
    !p.includes("\\") &&
    !p.startsWith("/") &&
    !/^[A-Za-z]:/.test(p) &&
    !p.split("/").some((s) => s === ".." || s === "." || s === "")
  );
}

const isCapability = (v: unknown): v is Capability => v === true || v === false || v === "partial";
const declared = (v: unknown) => v === true || v === "partial";

class Recorder {
  readonly checks: ConformanceCheck[] = [];
  pass(name: string, message?: string) {
    this.checks.push({ name, status: "pass", ...(message ? { message } : {}) });
  }
  fail(name: string, message: string) {
    this.checks.push({ name, status: "fail", message });
  }
  skip(name: string, message: string) {
    this.checks.push({ name, status: "skip", message });
  }
  /** Records a pass when `problems` is empty, a failure listing them otherwise. */
  expect(name: string, problems: string[], passMessage?: string) {
    if (problems.length) this.fail(name, problems.slice(0, 10).join("; "));
    else this.pass(name, passMessage);
  }
  /** Runs `fn`; an exception becomes a failure of `name`. */
  async guard<T>(name: string, fn: () => Promise<T> | T): Promise<T | undefined> {
    try {
      return await fn();
    } catch (error) {
      this.fail(name, `threw: ${(error as Error)?.message ?? String(error)}`);
      return undefined;
    }
  }
  report(kind: ConformanceReport["kind"], subject: string): ConformanceReport {
    return {
      kind,
      subject,
      checks: this.checks,
      ok: !this.checks.some((c) => c.status === "fail"),
    };
  }
}

function checkIdentity(
  r: Recorder,
  prefix: string,
  subject: { apiVersion?: unknown; id?: unknown },
): string {
  r.expect(
    `${prefix}.apiVersion`,
    subject.apiVersion === PLUGIN_API_VERSION
      ? []
      : [`apiVersion must be ${PLUGIN_API_VERSION}, got ${JSON.stringify(subject.apiVersion)}`],
  );
  const ok = typeof subject.id === "string" && subject.id.length > 0;
  r.expect(`${prefix}.id`, ok ? [] : ["id must be a non-empty string"]);
  return ok ? (subject.id as string) : "(no id)";
}

function checkCapabilities(
  r: Recorder,
  prefix: string,
  get: () => unknown,
  keys: readonly string[],
): Record<string, unknown> {
  let caps: Record<string, unknown> = {};
  try {
    const v = get();
    if (typeof v === "object" && v !== null) caps = v as Record<string, unknown>;
    else r.fail(`${prefix}.capabilities`, "getCapabilities() must return an object");
  } catch (error) {
    r.fail(`${prefix}.capabilities`, `getCapabilities() threw: ${(error as Error).message}`);
    return caps;
  }
  r.expect(
    `${prefix}.capabilities`,
    keys
      .filter((k) => !isCapability(caps[k]))
      .map((k) => `${k} must be declared as true, false or "partial"`),
  );
  return caps;
}

// ── runner adapters ───────────────────────────────────────────────────────────────────────

export interface RunnerFixture {
  /** Project-relative test files that discovery must find (all of them unless discovery is "partial"). */
  expectedFiles?: string[];
  /** Files to execute and the outcome each must have. */
  run?: {
    files: string[];
    expect: Record<string, "passed" | "failed">;
    options?: ExecutionOptions;
  };
}

/** Runner adapter conformance: identity, declared capabilities, discovery and execution. */
export async function checkRunnerAdapter(
  adapter: TestAdapter,
  fixture: RunnerFixture = {},
): Promise<ConformanceReport> {
  const r = new Recorder();
  const id = checkIdentity(r, "runner", adapter);
  const caps = checkCapabilities(
    r,
    "runner",
    () => adapter.getCapabilities(),
    TEST_ADAPTER_CAPABILITY_KEYS,
  );

  if (declared(caps.discovery)) {
    const cases = await r.guard("runner.discovery", () => adapter.discover());
    if (cases !== undefined) {
      if (!Array.isArray(cases)) r.fail("runner.discovery", "discover() must return an array");
      else {
        const problems: string[] = [];
        const ids = new Set<string>();
        for (const c of cases as Partial<TestCase>[]) {
          if (typeof c.id !== "string" || !c.id) problems.push("a test case has no id");
          else if (ids.has(c.id)) problems.push(`duplicate test id ${c.id}`);
          else ids.add(c.id);
          if (!isProjectRelativePath(c.filePath))
            problems.push(`filePath must be project-relative POSIX: ${JSON.stringify(c.filePath)}`);
          if (!Array.isArray(c.suitePath) || typeof c.name !== "string" || !Array.isArray(c.tags))
            problems.push(`${c.id}: suitePath, name and tags are required`);
        }
        r.expect("runner.discovery.cases", problems, `${cases.length} test case(s)`);
        if (fixture.expectedFiles) {
          const found = new Set(cases.map((c) => c.filePath));
          const missing = fixture.expectedFiles.filter((f) => !found.has(f));
          if (caps.discovery === "partial" && missing.length)
            r.skip(
              "runner.discovery.expected",
              `discovery is "partial": ${missing.length} expected file(s) not found`,
            );
          else
            r.expect(
              "runner.discovery.expected",
              missing.map((f) => `did not discover ${f}`),
            );
        }
      }
    }
  } else {
    const cases = await adapter.discover().catch(() => undefined);
    r.expect(
      "runner.discovery.undeclared",
      Array.isArray(cases) && cases.length
        ? ["discover() returns tests although discovery is not declared (declare it)"]
        : [],
    );
  }

  if (!fixture.run) {
    r.skip("runner.execute", "no run fixture given");
    return r.report("runner", id);
  }
  const { files, expect: outcomes, options } = fixture.run;
  const result = (await r.guard("runner.execute", () =>
    adapter.execute({ files }, options ?? {}),
  )) as TestRunResult | undefined;
  if (result === undefined) return r.report("runner", id);
  const shape: string[] = [];
  if (result.adapter !== id) shape.push(`result.adapter must be "${id}", got "${result.adapter}"`);
  for (const k of ["startedAt", "finishedAt"] as const)
    if (typeof result[k] !== "string" || Number.isNaN(Date.parse(result[k])))
      shape.push(`${k} must be an ISO date`);
  if (!Array.isArray(result.executions)) shape.push("executions must be an array");
  r.expect("runner.execute.result", shape);
  if (!Array.isArray(result.executions)) return r.report("runner", id);
  const execs: string[] = [];
  for (const e of result.executions) {
    if (!TEST_STATUSES.includes(e.status)) execs.push(`${e.testId}: unknown status ${e.status}`);
    if (e.status === "cached-pass" || e.status === "cached-failure")
      execs.push(`${e.testId}: adapters never report cached results (ADR-0009)`);
    if (!(typeof e.durationMs === "number" && e.durationMs >= 0))
      execs.push(`${e.testId}: durationMs must be a non-negative number`);
    if (!(Number.isInteger(e.attempts) && e.attempts >= 1))
      execs.push(`${e.testId}: attempts must be at least 1`);
    if (!files.includes(fileOfTestId(e.testId)))
      execs.push(`${e.testId}: test ids are "<selected file>::<name>"; this file was not selected`);
  }
  r.expect("runner.execute.executions", execs, `${result.executions.length} execution(s)`);
  const outcomeProblems: string[] = [];
  for (const [file, want] of Object.entries(outcomes)) {
    const own = result.executions.filter((e) => fileOfTestId(e.testId) === file);
    if (!own.length) {
      outcomeProblems.push(`${file}: no execution reported`);
      continue;
    }
    const failed = own.some((e) =>
      ["failed", "timed-out", "infrastructure-error"].includes(e.status),
    );
    const passed = own.some((e) => e.status === "passed");
    if (want === "failed" && !failed)
      outcomeProblems.push(`${file}: a failing test was not reported as failed`);
    if (want === "passed" && (failed || !passed))
      outcomeProblems.push(
        `${file}: expected passing tests, got ${own.map((e) => e.status).join(", ")}`,
      );
  }
  r.expect("runner.execute.outcomes", outcomeProblems);
  return r.report("runner", id);
}

/**
 * The 0.x conformance entry point, kept for compatibility: identity, capabilities and discovery
 * only, as a list of issues.
 */
export async function checkTestAdapterConformance(
  adapter: TestAdapter,
): Promise<ConformanceIssue[]> {
  const report = await checkRunnerAdapter(adapter);
  return report.checks
    .filter((c) => c.status === "fail")
    .map((c) => ({ capability: c.name, message: c.message ?? "" }));
}

// ── version-control adapters ──────────────────────────────────────────────────────────────

export interface VcsFixture {
  /** A working copy (absolute path) holding uncommitted changes relative to `base`. */
  root: string;
  /** A directory that is not a working copy: `detect` must return false there. */
  outside?: string;
  base: RevisionRef;
  /** Changes `getChanges(base)` must report (it may report more). */
  expectedChanges: { path: string; type: FileChange["type"]; previousPath?: string }[];
  /** A file that exists at `base`, with its content there. */
  fileAtBase?: { path: string; content: string };
}

/** Version-control adapter conformance: identity, capabilities, detection, state and changes. */
export async function checkVcsAdapter(
  adapter: VersionControlAdapter,
  fixture: VcsFixture,
): Promise<ConformanceReport> {
  const r = new Recorder();
  const id = checkIdentity(r, "vcs", adapter);
  const caps = checkCapabilities(r, "vcs", () => adapter.getCapabilities(), VCS_CAPABILITY_KEYS);

  const detected = await r.guard("vcs.detect", () => adapter.detect(fixture.root));
  if (detected !== undefined)
    r.expect("vcs.detect", detected === true ? [] : ["detect(root) must be true in the fixture"]);
  if (fixture.outside) {
    const outside = await r.guard("vcs.detect.outside", () =>
      adapter.detect(fixture.outside as string),
    );
    if (outside !== undefined)
      r.expect(
        "vcs.detect.outside",
        outside === false ? [] : ["detect() must be false outside a working copy"],
      );
  } else r.skip("vcs.detect.outside", "no outside directory given");

  const state = await r.guard("vcs.workingState", () => adapter.getWorkingState());
  if (state !== undefined) {
    const p: string[] = [];
    if (state.provider !== id) p.push(`provider must be "${id}"`);
    if (typeof state.root !== "string" || !state.root) p.push("root is required");
    if (typeof state.dirty !== "boolean") p.push("dirty must be a boolean");
    if (state.dirty !== true) p.push("the fixture has uncommitted changes: dirty must be true");
    if (!Array.isArray(state.warnings)) p.push("warnings must be an array");
    r.expect("vcs.workingState", p);
  }

  const changes = (await r.guard("vcs.changes", () => adapter.getChanges(fixture.base))) as
    | ChangeSet
    | undefined;
  if (changes !== undefined) {
    const p: string[] = [];
    if (changes.provider !== id) p.push(`provider must be "${id}"`);
    if (!["complete", "partial", "unknown"].includes(changes.completeness))
      p.push(`completeness must be complete, partial or unknown`);
    if (!Array.isArray(changes.warnings)) p.push("warnings must be an array");
    for (const c of changes.changes ?? []) {
      if (!isProjectRelativePath(c.path)) p.push(`path must be project-relative POSIX: ${c.path}`);
      if (!CHANGE_TYPES.includes(c.type)) p.push(`${c.path}: unknown change type ${c.type}`);
      if (c.type === "renamed" && !isProjectRelativePath(c.previousPath))
        p.push(`${c.path}: a rename needs previousPath`);
    }
    r.expect("vcs.changes.shape", p, `${changes.changes?.length ?? 0} change(s)`);
    const missing: string[] = [];
    for (const want of fixture.expectedChanges) {
      const renameExpected = want.type === "renamed";
      if (renameExpected && caps.renameDetection !== true) {
        // Without rename detection a rename is a deletion plus an addition.
        const del = changes.changes.some(
          (c) => c.path === want.previousPath && c.type === "deleted",
        );
        const add = changes.changes.some((c) => c.path === want.path && c.type === "added");
        if (
          !(del && add) &&
          !changes.changes.some((c) => c.path === want.path && c.type === "renamed")
        )
          missing.push(
            `${want.previousPath} → ${want.path} reported neither as a rename nor as delete + add`,
          );
        continue;
      }
      const got = changes.changes.find((c) => c.path === want.path);
      if (!got) missing.push(`${want.path} (${want.type}) not reported`);
      else if (got.type !== want.type)
        missing.push(`${want.path}: expected ${want.type}, got ${got.type}`);
      else if (want.previousPath && got.previousPath !== want.previousPath)
        missing.push(
          `${want.path}: previousPath ${got.previousPath} instead of ${want.previousPath}`,
        );
    }
    r.expect("vcs.changes.expected", missing);
  }

  if (!fixture.fileAtBase) r.skip("vcs.fileContent", "no fileAtBase given");
  else if (!declared(caps.fileContentAtRevision))
    r.skip("vcs.fileContent", "fileContentAtRevision is not declared");
  else {
    const { path, content } = fixture.fileAtBase;
    const bytes = await r.guard("vcs.fileContent", () =>
      adapter.getFileContent(path, fixture.base),
    );
    if (bytes !== undefined)
      r.expect(
        "vcs.fileContent",
        bytes instanceof Uint8Array && new TextDecoder().decode(bytes) === content
          ? []
          : [`getFileContent(${path}, base) must return the file's content at base`],
      );
    try {
      const none = await adapter.getFileContent(
        "__smarttest_conformance_missing__.txt",
        fixture.base,
      );
      r.expect(
        "vcs.fileContent.missing",
        none === null ? [] : ["a file absent at the revision must return null"],
      );
    } catch (error) {
      r.fail(
        "vcs.fileContent.missing",
        `a file absent at the revision must return null, not throw: ${(error as Error).message}`,
      );
    }
  }
  return r.report("vcs", id);
}

// ── language analyzers ────────────────────────────────────────────────────────────────────

export interface LanguageFixture {
  /** Project-relative path → source text. */
  files: Record<string, string>;
  expect?: {
    /** Import specifiers each file must report. */
    imports?: Record<string, string[]>;
    /** Qualified symbol names each file must declare. */
    symbols?: Record<string, string[]>;
    /** Files with a dynamic import or require that cannot be resolved statically. */
    uncertain?: string[];
  };
}

/** Language analyzer conformance: identity, output shape, determinism and uncertainty. */
export async function checkLanguageAnalyzer(
  analyzer: Analyzer,
  fixture: LanguageFixture,
): Promise<ConformanceReport> {
  const r = new Recorder();
  const id = checkIdentity(r, "language", analyzer);
  r.expect(
    "language.version",
    typeof analyzer.version === "string" && analyzer.version
      ? []
      : ["version must be a non-empty string"],
  );
  const results = new Map<string, FileAnalysis>();
  const unsupported = Object.keys(fixture.files).filter((p) => !analyzer.supports(p));
  r.expect(
    "language.supports",
    unsupported.map((p) => `supports(${p}) must be true`),
  );
  for (const [path, source] of Object.entries(fixture.files)) {
    if (!analyzer.supports(path)) continue;
    const a = await r.guard(`language.analyze ${path}`, () => analyzer.analyze(path, source));
    if (!a) continue;
    results.set(path, a);
    const p: string[] = [];
    if (a.path !== path) p.push(`path must be "${path}"`);
    if (typeof a.hash !== "string" || !a.hash) p.push("hash is required");
    if (a.analyzerVersion !== analyzer.version)
      p.push("analyzerVersion must equal the analyzer's version");
    for (const k of [
      "imports",
      "symbols",
      "localExports",
      "topLevelRefs",
      "dynamicUnresolved",
    ] as const)
      if (!Array.isArray(a[k])) p.push(`${k} must be an array`);
    for (const s of a.symbols ?? []) {
      if (s.id !== `${path}#${s.qualifiedName}`)
        p.push(`symbol id ${s.id} must be "<path>#<qualifiedName>"`);
      if (
        !s.range ||
        s.range.start.line > s.range.end.line ||
        (s.range.start.line === s.range.end.line && s.range.start.column > s.range.end.column)
      )
        p.push(`${s.id}: range start must not be after its end`);
    }
    for (const i of a.imports ?? [])
      if (typeof i.specifier !== "string" || !Array.isArray(i.bindings) || !(i.line >= 0))
        p.push(`import ${JSON.stringify(i.specifier)}: specifier, bindings and line are required`);
    r.expect(`language.analysis ${path}`, p);
    const again = await r.guard(`language.deterministic ${path}`, () =>
      analyzer.analyze(path, source),
    );
    if (again)
      r.expect(
        `language.deterministic ${path}`,
        JSON.stringify(again) === JSON.stringify(a)
          ? []
          : ["analysing the same source twice must give the same result"],
      );
  }
  const e = fixture.expect ?? {};
  const expected: string[] = [];
  for (const [path, specs] of Object.entries(e.imports ?? {})) {
    const got = new Set(results.get(path)?.imports.map((i) => i.specifier));
    for (const s of specs) if (!got.has(s)) expected.push(`${path}: import "${s}" not reported`);
  }
  for (const [path, names] of Object.entries(e.symbols ?? {})) {
    const got = new Set(results.get(path)?.symbols.map((s) => s.qualifiedName));
    for (const n of names) if (!got.has(n)) expected.push(`${path}: symbol ${n} not reported`);
  }
  r.expect("language.expected", expected);
  if (e.uncertain?.length)
    r.expect(
      "language.uncertainty",
      e.uncertain
        .filter(
          (f) => !results.get(f)?.dynamicUnresolved.length && !results.get(f)?.dynamicHints?.length,
        )
        .map((f) => `${f}: an unresolvable dynamic import must be reported in dynamicUnresolved`),
    );
  else r.skip("language.uncertainty", "no uncertain file given");
  return r.report("language", id);
}

// ── edge providers ────────────────────────────────────────────────────────────────────────

export interface EdgeProviderFixture {
  /** Absolute project root. */
  root: string;
  /** Project-relative source files SmartTest would analyse. */
  files: string[];
  /** Every project file (default: `files`). */
  allFiles?: string[];
  isTest?: (path: string) => boolean;
  /** Edges the provider must return (it may return more). */
  expectedEdges?: { from: string; to: string }[];
  /** Files the provider must report as holding unresolved relationships. */
  expectedUnresolved?: string[];
}

/** Builds the context SmartTest passes to `provideEdges`, for a fixture. */
export function edgeProviderContext(fixture: EdgeProviderFixture): EdgeProviderContext {
  return {
    root: fixture.root,
    files: fixture.files,
    isTest: fixture.isTest ?? ((p) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(p)),
    listFiles: async () => [...(fixture.allFiles ?? fixture.files)],
    readFile: async (p) => {
      if (!isProjectRelativePath(p)) return undefined;
      const { readFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      return readFile(join(fixture.root, p), "utf8").catch(() => undefined);
    },
  };
}

/** Edge-provider conformance: identity, capabilities, output shape, determinism, expectations. */
export async function checkEdgeProvider(
  provider: EdgeProvider,
  fixture: EdgeProviderFixture,
): Promise<ConformanceReport> {
  const r = new Recorder();
  const id = checkIdentity(r, "edges", provider);
  const caps = checkCapabilities(
    r,
    "edges",
    () => provider.getCapabilities(),
    EDGE_PROVIDER_CAPABILITY_KEYS,
  );
  if (!declared(caps.fileEdges)) {
    r.skip("edges.provide", "fileEdges is not declared: SmartTest never calls this provider");
    return r.report("edge-provider", id);
  }
  const context = edgeProviderContext(fixture);
  const first = (await r.guard("edges.provide", () => provider.provideEdges(context))) as
    | EdgeProviderResult
    | undefined;
  if (first === undefined) return r.report("edge-provider", id);
  const p: string[] = [];
  if (!Array.isArray(first?.edges)) p.push("result.edges must be an array");
  const known = new Set(fixture.allFiles ?? fixture.files);
  for (const e of Array.isArray(first?.edges) ? first.edges : []) {
    const label = `${e?.from} → ${e?.to}`;
    if (!isProjectRelativePath(e?.from) || !isProjectRelativePath(e?.to))
      p.push(`${label}: from and to must be project-relative POSIX paths`);
    if (!EDGE_KINDS.includes(e?.kind)) p.push(`${label}: unknown kind ${e?.kind}`);
    if (!CONFIDENCES.includes(e?.confidence))
      p.push(`${label}: unknown confidence ${e?.confidence}`);
    if (
      caps.nonSourceFiles !== true &&
      isProjectRelativePath(e?.to) &&
      !fixture.files.includes(e.to)
    )
      p.push(`${label}: points outside the analysed sources but nonSourceFiles is not declared`);
    if (
      isProjectRelativePath(e?.to) &&
      known.size &&
      !known.has(e.to) &&
      !fixture.files.includes(e.to)
    )
      p.push(`${label}: target is not a project file`);
  }
  if (first.unresolved !== undefined) {
    if (!Array.isArray(first.unresolved)) p.push("result.unresolved must be an array");
    else {
      if (caps.unresolved !== true && first.unresolved.length)
        p.push("returns unresolved relationships but does not declare the unresolved capability");
      for (const u of first.unresolved)
        if (!isProjectRelativePath(u?.file) || typeof u?.reason !== "string")
          p.push(`unresolved entries need a project-relative file and a reason`);
    }
  }
  r.expect("edges.result", p, `${first.edges?.length ?? 0} edge(s)`);
  const second = await r.guard("edges.deterministic", () => provider.provideEdges(context));
  if (second) {
    const norm = (x: EdgeProviderResult) =>
      JSON.stringify({
        edges: [...(x.edges ?? [])].map((e) => JSON.stringify(e)).sort(),
        unresolved: [...(x.unresolved ?? [])].map((u) => JSON.stringify(u)).sort(),
      });
    r.expect(
      "edges.deterministic",
      norm(second) === norm(first)
        ? []
        : ["two calls on the same files must return the same edges"],
    );
  }
  const missing: string[] = [];
  for (const want of fixture.expectedEdges ?? [])
    if (!first.edges?.some((e) => e.from === want.from && e.to === want.to))
      missing.push(`edge ${want.from} → ${want.to} not returned`);
  for (const f of fixture.expectedUnresolved ?? [])
    if (caps.unresolved !== true)
      missing.push(`expects unresolved ${f} but unresolved is not declared`);
    else if (!first.unresolved?.some((u) => u.file === f))
      missing.push(`${f} not reported as unresolved`);
  r.expect("edges.expected", missing);
  return r.report("edge-provider", id);
}

// ── plugins ───────────────────────────────────────────────────────────────────────────────

/**
 * Plugin conformance: the default export's shape, then `checkEdgeProvider` for each of its edge
 * providers when a fixture is given (keyed by provider id).
 */
export async function checkPlugin(
  plugin: SmartTestPlugin,
  fixtures: { edgeProviders?: Record<string, EdgeProviderFixture> } = {},
): Promise<ConformanceReport> {
  const r = new Recorder();
  const p = plugin as unknown as Record<string, unknown>;
  r.expect(
    "plugin.apiVersion",
    p?.apiVersion === PLUGIN_API_VERSION ? [] : [`apiVersion must be ${PLUGIN_API_VERSION}`],
  );
  const name = typeof p?.name === "string" && p.name ? p.name : "(no name)";
  r.expect("plugin.name", name !== "(no name)" ? [] : ["name must be a non-empty string"]);
  const providers = p?.edgeProviders;
  if (providers !== undefined && !Array.isArray(providers))
    r.fail("plugin.edgeProviders", "edgeProviders must be an array");
  else {
    const ids = new Set<string>();
    const problems: string[] = [];
    for (const [i, ep] of ((providers as EdgeProvider[] | undefined) ?? []).entries()) {
      if (typeof ep?.provideEdges !== "function" || typeof ep?.getCapabilities !== "function")
        problems.push(`edgeProviders[${i}] must implement getCapabilities and provideEdges`);
      if (ids.has(ep?.id)) problems.push(`duplicate edge provider id ${ep?.id}`);
      ids.add(ep?.id);
    }
    r.expect("plugin.edgeProviders", problems);
    for (const ep of (providers as EdgeProvider[] | undefined) ?? []) {
      const fixture = fixtures.edgeProviders?.[ep?.id];
      if (!fixture) {
        r.skip(`plugin.edgeProvider ${ep?.id}`, "no fixture given");
        continue;
      }
      const sub = await checkEdgeProvider(ep, fixture);
      for (const c of sub.checks) r.checks.push({ ...c, name: `${ep.id}/${c.name}` });
    }
  }
  return r.report("plugin", name);
}

// ── reporting ─────────────────────────────────────────────────────────────────────────────

/** One line per check, failures first. */
export function formatConformanceReport(report: ConformanceReport): string {
  const order: Record<ConformanceStatus, number> = { fail: 0, skip: 1, pass: 2 };
  const lines = [...report.checks]
    .sort((a, b) => order[a.status] - order[b.status])
    .map(
      (c) => `  ${c.status.toUpperCase().padEnd(4)} ${c.name}${c.message ? ` — ${c.message}` : ""}`,
    );
  return `${report.kind} ${report.subject}: ${report.ok ? "conforms" : "does NOT conform"} to plugin API ${PLUGIN_API_VERSION}\n${lines.join("\n")}`;
}

/** Throws an Error listing every failed check when the report is not ok. */
export function assertConformance(report: ConformanceReport): void {
  if (!report.ok) throw new Error(formatConformanceReport(report));
}
