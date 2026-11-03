/**
 * `smarttest audit`: checks that measure selection instead of trusting it (S29).
 *
 * - Fault injection (`mutate`): one function at a time is made to throw, in a temporary checkout
 *   of HEAD; SmartTest selects for that change and the full suite runs. A test that fails but was
 *   not selected is a missed test, by definition, with no guessing from the graph.
 * - Reachability (`traces`): every project file a test loaded at run time must reach that test
 *   in the graph (or through its runner's configuration, or because the test is uncertain).
 * - Resolution (`resolution`): every import SmartTest resolves must agree with the TypeScript
 *   compiler; an import the compiler resolves into the project but SmartTest takes for a package
 *   is an edge SmartTest cannot see.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pythonMutationPoints } from "@smarttest/language-python";
import {
  applyMutation,
  CompilerResolver,
  type MutationPoint,
  mutationPoints,
} from "@smarttest/language-typescript";
import { SmartTestError } from "@smarttest/shared";
import { type ExecutionSummary, executeGroups } from "@smarttest/test-executor";
import { planExecution } from "@smarttest/test-selector";
import { observeLoads } from "./observe.js";
import type { SmartTest } from "./smarttest.js";

export interface AuditOptions {
  mutate?: {
    /** How many functions to break (default 10), sampled evenly with `seed`. */
    mutants?: number;
    seed?: number;
    /** Stop starting new mutants after this many milliseconds. */
    budgetMs?: number;
    /**
     * Only these runners' tests (`--runner`); default: the hook's (`hook.runners`), so a suite
     * against a live environment is never started. `["all"]`: every runner.
     */
    runners?: readonly string[];
  };
  /** Trace the tests first when no traces are stored (`sample`: at most that many files). */
  traces?: { sample?: number; runners?: readonly string[] };
  resolution?: boolean;
  onProgress?: (message: string) => void;
}

export interface MutantResult {
  file: string;
  function: string;
  line: number;
  selected: number;
  /** Tests that failed with the fault and not without it. */
  failing: string[];
  /** Failing tests the selection did not include: the misses. */
  missed: string[];
  /** Failed in the full run but passed alone with the fault in place: not caused by it. */
  loadFlaky: string[];
  outcome: "caught" | "survived" | "missed";
  /** Selection ran everything (a trigger or a fallback): caught trivially. */
  everything?: boolean;
}

export interface AuditReport {
  version: 1;
  project: string;
  at: string;
  mutate?: {
    seed: number;
    functions: number;
    mutants: MutantResult[];
    caught: number;
    survived: number;
    missed: number;
    loadFlaky: number;
    /** Failing before any fault was injected (left out of every comparison). */
    baselineFailing: string[];
    durationMs: number;
    notes: string[];
  };
  traces?: {
    tests: number;
    files: number;
    pairs: number;
    /** Tests always selected because they reach uncertainty (BALANCED and SAFE). */
    uncertainTests: number;
    unreachable: { test: string; file: string }[];
    durationMs: number;
    notes: string[];
  };
  resolution?: {
    imports: number;
    agree: number;
    /** SmartTest marks them unresolved: uncertainty, which selects (not a miss). */
    uncertain: number;
    /** The compiler resolves into the project, SmartTest does not point there. */
    mismatches: { file: string; specifier: string; smarttest: string; typescript: string }[];
    durationMs: number;
  };
}

const CODE = /\.(?:[cm]?[jt]sx?|py)$/;

function failingFiles(s: ExecutionSummary): string[] {
  return s.files
    .filter(
      (f) =>
        f.status === "failed" || f.status === "timed-out" || f.status === "infrastructure-error",
    )
    .map((f) => f.file);
}

/** A seeded shuffle (mulberry32): the same seed samples the same functions. */
function shuffle<T>(items: readonly T[], seed: number): T[] {
  let a = seed >>> 0;
  const rand = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

async function mutate(
  st: SmartTest,
  options: NonNullable<AuditOptions["mutate"]>,
  progress: (m: string) => void,
): Promise<NonNullable<AuditReport["mutate"]>> {
  const t0 = performance.now();
  const seed = options.seed ?? 1;
  const wanted = options.mutants ?? 10;
  const { SmartTest: Engine } = await import("./smarttest.js");
  const checkout = await st.headCheckout();
  const notes = [...checkout.warnings];
  try {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const store = await mkdtemp(join(tmpdir(), "smarttest-audit-store-"));
    const engine = await Engine.open({ root: checkout.root, storeDir: store });
    const runners =
      options.runners?.[0] === "all" ? undefined : (options.runners ?? engine.config.hook.runners);
    const scope = runners?.length ? { runners } : {};
    const clean = await engine.analyze({ source: { kind: "uncommitted" }, ...scope });
    const create = (g: Parameters<SmartTest["createAdapterFor"]>[0]) => engine.createAdapterFor(g);
    const plan = planExecution(
      clean.testFiles,
      clean.runnerRoots,
      engine.config.adapters,
      clean.assignment,
    );
    const runAll = () =>
      executeGroups(plan.groups, { createAdapter: create, timeoutMs: engine.config.timeoutMs });
    progress(`baseline: full suite (${clean.testFiles.length} test files)`);
    const baselineFailing = failingFiles(await runAll());
    if (baselineFailing.length)
      notes.push(
        `${baselineFailing.length} test file(s) fail without any fault (${baselineFailing.slice(0, 3).join(", ")}); they are left out of every comparison`,
      );
    const tests = new Set(clean.testFiles);
    // SmartTest loads these itself (its configuration, local plugins): breaking one breaks the
    // analysis, not the code under test.
    const own = new Set(
      engine.config.plugins.filter((p) => p.startsWith("./")).map((p) => p.slice(2)),
    );
    const ownFile = (f: string) => own.has(f) || /(?:^|\/)smarttest\.config\.[^/]+$/.test(f);
    const points: (MutationPoint & { file: string })[] = [];
    for (const [file] of clean.index.entries()) {
      if (!CODE.test(file) || tests.has(file) || clean.graph.isTestFile(file) || ownFile(file))
        continue;
      const text = await readFile(join(checkout.root, file), "utf8").catch(() => undefined);
      if (text === undefined) continue;
      const found = file.endsWith(".py")
        ? pythonMutationPoints(file, text)
        : mutationPoints(file, text);
      for (const p of found) points.push({ ...p, file });
    }
    points.sort((x, y) => x.file.localeCompare(y.file) || x.start - y.start);
    const sample = shuffle(points, seed).slice(0, wanted);
    const mutants: MutantResult[] = [];
    for (const [i, p] of sample.entries()) {
      if (options.budgetMs && performance.now() - t0 > options.budgetMs) {
        notes.push(`Budget reached after ${i} of ${sample.length} mutants`);
        break;
      }
      const path = join(checkout.root, p.file);
      const original = await readFile(path, "utf8");
      await writeFile(path, applyMutation(original, p));
      try {
        let a: Awaited<ReturnType<SmartTest["analyze"]>>;
        try {
          a = await engine.analyze({ source: { kind: "uncommitted" }, ...scope });
        } catch (error) {
          notes.push(
            `${p.file}#${p.name}: the analysis failed with the fault in place (${(error as Error).message.split("\n")[0]}); not counted`,
          );
          continue;
        }
        const selected = new Set(a.decision.selectedTests.map((t) => t.filePath));
        const baseline = new Set(baselineFailing);
        const failing = failingFiles(await runAll()).filter((f) => !baseline.has(f));
        let missed = failing.filter((f) => !selected.has(f));
        const loadFlaky: string[] = [];
        if (missed.length) {
          const alone = await executeGroups(
            planExecution(missed, a.runnerRoots, engine.config.adapters, a.assignment).groups,
            { createAdapter: create, timeoutMs: engine.config.timeoutMs },
          );
          const passed = new Set(
            alone.files.filter((f) => f.status === "passed").map((f) => f.file),
          );
          loadFlaky.push(...missed.filter((f) => passed.has(f)));
          missed = missed.filter((f) => !passed.has(f));
        }
        const result: MutantResult = {
          file: p.file,
          function: p.name,
          line: p.line,
          selected: selected.size,
          failing,
          missed,
          loadFlaky,
          outcome: missed.length ? "missed" : failing.length ? "caught" : "survived",
          ...(a.decision.fallbackApplied && selected.size === a.testFiles.length
            ? { everything: true }
            : {}),
        };
        mutants.push(result);
        progress(
          `[${i + 1}/${sample.length}] ${p.file}#${p.name}: ${result.outcome}${missed.length ? ` — MISSED ${missed.join(", ")}` : ""} (${selected.size} selected, ${failing.length} failing)`,
        );
      } finally {
        await writeFile(path, original);
      }
    }
    return {
      seed,
      functions: points.length,
      mutants,
      caught: mutants.filter((m) => m.outcome === "caught").length,
      survived: mutants.filter((m) => m.outcome === "survived").length,
      missed: mutants.filter((m) => m.outcome === "missed").length,
      loadFlaky: mutants.reduce((n, m) => n + m.loadFlaky.length, 0),
      baselineFailing,
      durationMs: Math.round(performance.now() - t0),
      notes,
    };
  } finally {
    await checkout.cleanup();
  }
}

async function traces(
  st: SmartTest,
  options: NonNullable<AuditOptions["traces"]>,
  progress: (m: string) => void,
): Promise<NonNullable<AuditReport["traces"]>> {
  const t0 = performance.now();
  const notes: string[] = [];
  progress("tracing each test file alone (code it ran, files it read, Python modules it imported)");
  const observed = await observeLoads(st, {
    ...(options.sample ? { sample: options.sample } : {}),
    ...(options.runners ? { runners: options.runners } : {}),
    onProgress: progress,
  });
  const loaded = observed.loaded;
  const generated = new Set(st.config.generated.map((g) => g.path));
  for (const [out, tests] of observed.builtOutputs) {
    if ([...generated].some((g) => g.startsWith(out))) continue;
    const src = out.replace(/\/?(?:dist|build|out|\.output)$/, "") || ".";
    notes.push(
      `${tests.size} test file(s) read the untracked build output ${out}/ (e.g. ${[...tests][0]}): a change to its sources selects them only once SmartTest knows what builds it. Declare it: generated: [{ path: "${out}/**", policy: "rebuild-required", from: ["${src === "." ? "src" : src}/**"] }]`,
    );
  }
  if (observed.compiled.length)
    notes.push(
      `${observed.compiled.length} test file(s) run through \`ng test\`, which compiles the project into a bundle first: what such a test loads can barely be observed, so this check says little about them (fault injection still does)`,
    );
  if (observed.failed.length)
    notes.push(
      `${observed.failed.length} test file(s) recorded nothing (failing, or not runnable alone): ${observed.failed.slice(0, 3).join(", ")}`,
    );
  const files = [...new Set([...loaded.values()].flat())].sort();
  const { reaches, uncertain } = await st.reachability(files);
  const unreachable: { test: string; file: string }[] = [];
  let pairs = 0;
  const confirmed = new Map<string, Set<string>>();
  for (const [test, list] of loaded) {
    if (uncertain.has(test)) continue;
    for (const file of list) {
      // Environment files are tracked by key (a key's readers, or everything for a key no code
      // reads), not as a whole: a whole-file change is not a change SmartTest can be asked about.
      if (/(?:^|\/)\.env(?:\.[^/]*)?$/.test(file)) continue;
      pairs++;
      if (reaches.get(file)?.has(test)) continue;
      // The graph alone does not link them: ask the full impact analysis.
      let selected = confirmed.get(file);
      if (!selected) {
        selected = await st.selectedForWholeFile(file);
        confirmed.set(file, selected);
      }
      if (!selected.has(test)) unreachable.push({ test, file });
    }
  }
  return {
    tests: loaded.size,
    files: files.length,
    pairs,
    uncertainTests: [...loaded.keys()].filter((t) => uncertain.has(t)).length,
    unreachable,
    durationMs: Math.round(performance.now() - t0),
    notes,
  };
}

async function resolution(st: SmartTest): Promise<NonNullable<AuditReport["resolution"]>> {
  const t0 = performance.now();
  const { index } = await st.loadIndex();
  const compiler = new CompilerResolver(st.root);
  let imports = 0;
  let agree = 0;
  let uncertain = 0;
  const mismatches: NonNullable<AuditReport["resolution"]>["mismatches"] = [];
  for (const [file, a] of index.entries()) {
    // The TypeScript compiler judges JavaScript and TypeScript imports only.
    if (file.endsWith(".py")) continue;
    for (const imp of a.imports) {
      // Only module specifiers the compiler can judge: no assets, queries or virtual modules.
      if (
        !imp.specifier ||
        /[?!]|\.(?:css|s[ac]ss|less|json|svg|png|html|txt|md)$/.test(imp.specifier)
      )
        continue;
      const ts = compiler.resolve(file, imp.specifier);
      if (ts.kind !== "project") continue;
      imports++;
      if (imp.resolved === ts.file) agree++;
      else if (imp.unresolved && !imp.resolved) uncertain++;
      else
        mismatches.push({
          file,
          specifier: imp.specifier,
          smarttest: imp.resolved ?? (imp.external ? "a package (external)" : "nothing"),
          typescript: ts.file,
        });
    }
  }
  return { imports, agree, uncertain, mismatches, durationMs: Math.round(performance.now() - t0) };
}

export async function audit(st: SmartTest, options: AuditOptions): Promise<AuditReport> {
  if (!options.mutate && !options.traces && !options.resolution)
    throw new SmartTestError("Choose at least one audit: --mutate, --traces or --resolution", {
      code: "ST_USAGE",
      category: "usage",
    });
  const progress = options.onProgress ?? (() => undefined);
  const profile = await st.profile();
  const report: AuditReport = { version: 1, project: profile.name, at: new Date().toISOString() };
  if (options.resolution) {
    progress("resolution: comparing every import with the TypeScript compiler");
    report.resolution = await resolution(st);
  }
  if (options.traces) {
    progress("traces: checking that every file a test loaded reaches it");
    report.traces = await traces(st, options.traces, progress);
  }
  if (options.mutate) {
    progress("mutate: breaking one function at a time in a temporary checkout of HEAD");
    report.mutate = await mutate(st, options.mutate, progress);
  }
  return report;
}

/** Whether the audit found a miss (exit code 1 for CI). */
export function auditFailed(r: AuditReport): boolean {
  return !!(r.mutate?.missed || r.traces?.unreachable.length || r.resolution?.mismatches.length);
}

export function auditMarkdown(r: AuditReport): string {
  const lines = [`# SmartTest audit · ${r.project}`, "", `Run ${r.at}.`, ""];
  if (r.resolution) {
    const x = r.resolution;
    lines.push(
      "## Resolution",
      "",
      `${x.imports} imports the TypeScript compiler resolves into the project: ${x.agree} agree, ${x.uncertain} unresolved by SmartTest (uncertainty, which selects), **${x.mismatches.length} mismatches**.`,
      "",
      ...x.mismatches
        .slice(0, 50)
        .map(
          (m) =>
            `- \`${m.file}\` imports \`${m.specifier}\`: SmartTest → ${m.smarttest}, compiler → \`${m.typescript}\``,
        ),
      "",
    );
  }
  if (r.traces) {
    const x = r.traces;
    lines.push(
      "## Reachability",
      "",
      `${x.tests} traced test files loaded ${x.files} project files (${x.pairs} test–file pairs; ${x.uncertainTests} tests are uncertain and always selected). **${x.unreachable.length} unreachable**.`,
      "",
      ...x.unreachable
        .slice(0, 50)
        .map((u) => `- \`${u.test}\` loaded \`${u.file}\`, which cannot select it`),
      ...x.notes.map((n) => `> ${n}`),
      "",
    );
  }
  if (r.mutate) {
    const x = r.mutate;
    lines.push(
      "## Fault injection",
      "",
      `${x.mutants.length} of ${x.functions} functions broken (seed ${x.seed}): ${x.caught} caught, ${x.survived} survived (no test fails), **${x.missed} missed**, ${x.loadFlaky} load-flaky failures.`,
      "",
      "| Function | Selected | Failing | Outcome |",
      "|---|---|---|---|",
      ...x.mutants.map(
        (m) =>
          `| \`${m.file}#${m.function}\` (line ${m.line}) | ${m.selected}${m.everything ? " (everything)" : ""} | ${m.failing.length} | ${m.outcome === "missed" ? `❌ missed ${m.missed.join(", ")}` : m.outcome} |`,
      ),
      "",
      ...x.notes.map((n) => `> ${n}`),
      "",
    );
  }
  return lines.join("\n");
}
