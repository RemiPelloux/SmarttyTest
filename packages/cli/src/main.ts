import { spawn } from "node:child_process";
import { join, relative } from "node:path";
// Types only: the engine (and TypeScript) is loaded lazily, so --help/--version start instantly.
import type { ChangeSource, CommitBenchmark, RunReport, SmartTest } from "@smarttest/core";
import type { SafetyMode } from "@smarttest/shared";
import {
  createLogger,
  ExitCode,
  fileSink,
  formatDuration,
  SmartTestError,
  toExitCode,
  VERSION,
  writeFileAtomic,
} from "@smarttest/shared";
import { type Flags, intFlag, parse } from "./args.js";
import { COMMANDS, commandHelp, rootHelp } from "./help.js";
import {
  colorEnabled,
  confirm,
  type IO,
  pad,
  prompt,
  Spinner,
  select,
  type Theme,
  theme,
} from "./ui.js";

interface Ctx {
  io: IO;
  t: Theme;
  flags: Flags;
  positionals: string[];
  root: string;
  interactive: boolean;
  out(line?: string): void;
  err(line?: string): void;
  json(command: string, data: unknown): void;
  open(): Promise<SmartTest>;
}

const MODES: SafetyMode[] = ["fast", "balanced", "safe"];

function modeOf(flags: Flags): SafetyMode | undefined {
  if (!flags.mode) return undefined;
  if (!MODES.includes(flags.mode as SafetyMode)) {
    throw new SmartTestError(`--mode must be one of ${MODES.join(", ")}`, {
      code: "ST_USAGE",
      category: "usage",
    });
  }
  return flags.mode as SafetyMode;
}

function sourceOf(flags: Flags): ChangeSource | undefined {
  const picked = [
    flags.base !== undefined,
    !!flags.staged,
    !!flags.push,
    !!flags.uncommitted,
    !!flags["since-snapshot"] || flags.snapshot !== undefined,
  ].filter(Boolean).length;
  if (picked > 1)
    throw new SmartTestError(
      "Use only one of --base, --staged, --push, --uncommitted, --since-snapshot",
      {
        code: "ST_USAGE",
        category: "usage",
      },
    );
  if (flags.base !== undefined) {
    if (flags["base-mode"] && !["merge-base", "direct"].includes(flags["base-mode"]))
      throw new SmartTestError("--base-mode must be merge-base or direct", {
        code: "ST_USAGE",
        category: "usage",
      });
    return {
      kind: "base",
      ref: flags.base,
      direct: flags["base-mode"] === "direct",
      ...(flags.target ? { target: flags.target } : {}),
    };
  }
  if (flags.staged) return { kind: "staged" };
  if (flags.push) return { kind: "push" };
  if (flags.uncommitted) return { kind: "uncommitted" };
  if (flags["since-snapshot"] || flags.snapshot !== undefined)
    return { kind: "snapshot", ...(flags.snapshot ? { id: flags.snapshot } : {}) };
  return undefined;
}

const rel = (ctx: Ctx, p: string) => relative(ctx.root, p) || ".";

// ── run / impact / explain / validate ─────────────────────────────────────────────────────

async function cmdHookRun(ctx: Ctx): Promise<number> {
  const { flags } = ctx;
  const source = sourceOf(flags);
  if (flags.all || flags.shard || (source && source.kind !== "staged" && source.kind !== "push"))
    throw new SmartTestError("--hook requires --staged or --push and a complete selection", {
      code: "ST_USAGE",
      category: "usage",
      hint: "Use smarttest run --staged --hook or smarttest run --push --hook.",
    });
  const stage = source?.kind === "push" ? "pre-push" : "pre-commit";
  const st = await ctx.open();
  const ac = new AbortController();
  const cancel = () => ac.abort();
  // Git, an editor or a terminal closing can end a hook with any of these; the run must still
  // stop its tests and remove its temporary checkout.
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  for (const s of signals) process.once(s, cancel);
  const mode = modeOf(flags);
  const timeoutMs = intFlag(flags.timeout, "timeout");
  const workers = intFlag(flags.workers, "workers");
  try {
    const result = await st.runHook(stage, {
      ...(mode ? { mode } : {}),
      ...(flags["no-cache"] ? { cache: false } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(workers !== undefined ? { workers } : {}),
      signal: ac.signal,
      onAnalysis: (a) => {
        if (!flags.quiet)
          ctx.out(
            `${stage}: ${a.input.changeSet.changes.length} changed files · ${a.decision.selectedTests.length} selected · ${a.decision.skippedTests.length} skipped (not run)`,
          );
      },
      onEstimate: (e) => {
        if (e.estimateMs <= e.budgetMs || flags.quiet) return;
        ctx.out(
          `Estimated ${formatDuration(e.estimateMs)} exceeds the ${formatDuration(e.budgetMs)} budget${e.unknown ? `; ${e.unknown} files have no duration yet` : ""}.`,
        );
        for (const f of e.slowest.slice(0, 3)) ctx.out(`  ${f.file}: ${formatDuration(f.ms)}`);
        ctx.out("Consider pre-push checks or `smarttest trace --stale` to refine selection.");
      },
    });
    const out = result.outcome;
    const failedCheck = result.checks.some((c) => c.status === "failed");
    if (flags.json)
      ctx.json("run", {
        hook: { ...result, outcome: undefined },
        ...(out
          ? { report: out.report, reports: out.written, integrityIssues: out.integrityIssues }
          : {}),
      });
    else if (result.skipped)
      ctx.out(`${stage}: bypass recorded (SMARTTEST_SKIP=1); tests and checks were not run.`);
    else if (result.nothingPushed)
      ctx.out(`${stage}: nothing pushed (only remote refs deleted); no tests or checks to run.`);
    else {
      for (const w of result.warnings) ctx.out(w);
      for (const c of result.checks) {
        ctx.out(
          `${c.name}${c.project ? ` (${c.project})` : ""}: ${c.status} · ${formatDuration(c.durationMs)}`,
        );
        if (c.output)
          for (const l of c.output.split("\n").slice(0, 4)) ctx.out(`  ${l.slice(0, 180)}`);
      }
      if (out) {
        for (const e of out.report.executions
          .filter((e) => !["passed", "cached-pass", "skipped", "flaky"].includes(e.status))
          .slice(0, 4)) {
          ctx.out(`${e.file}: ${e.status}`);
          for (const test of e.tests.filter((t) => t.error).slice(0, 2))
            ctx.out(`  ${test.error?.message.split("\n")[0]?.slice(0, 180)}`);
        }
        const s = out.report.summary;
        ctx.out(
          `${s.passed} passed · ${s.failed + s.timedOut} failed · ${s.cached ?? 0} cached (not run) · ${s.skippedBySelection} skipped (not run) · ${formatDuration(result.durationMs)}`,
        );
        for (const w of out.report.warnings.slice(0, 4)) ctx.out(w);
        ctx.out("Why: smarttest explain <test>");
      }
    }
    if (result.skipped) return ExitCode.Success;
    if (out?.integrityIssues.length) return ExitCode.Internal;
    return out && out.exitCode !== ExitCode.Success
      ? out.exitCode
      : failedCheck
        ? ExitCode.TestFailure
        : ExitCode.Success;
  } finally {
    for (const s of signals) process.off(s, cancel);
  }
}

async function cmdRun(ctx: Ctx): Promise<number> {
  const { t, flags } = ctx;
  if (flags.affected && flags.all)
    throw new SmartTestError("Use either --affected or --all", {
      code: "ST_USAGE",
      category: "usage",
    });
  if (flags.hook) return cmdHookRun(ctx);
  const st = await ctx.open();
  const ac = new AbortController();
  const onSigint = () => {
    ctx.err(t.yellow("\n■ Cancelling…"));
    ac.abort();
  };
  process.once("SIGINT", onSigint);
  const spinner = new Spinner(ctx.io, !flags.json && !flags.quiet && !!ctx.io.stderr.isTTY);
  const formats = flags.format as ("html" | "json" | "junit" | "markdown")[] | undefined;
  for (const f of formats ?? [])
    if (!["html", "json", "junit", "markdown"].includes(f))
      throw new SmartTestError(`Unknown --format ${f}`, { code: "ST_USAGE", category: "usage" });
  const markdownForCI = !!process.env.GITHUB_STEP_SUMMARY;
  spinner.start("Analysing changes…");
  try {
    const source = sourceOf(flags);
    const mode = modeOf(flags);
    const retries = intFlag(flags.retries, "retries");
    const timeoutMs = intFlag(flags.timeout, "timeout");
    const workers = intFlag(flags.workers, "workers");
    const shard =
      flags.shard !== undefined
        ? (await import("@smarttest/core")).parseShard(flags.shard)
        : undefined;
    if (flags.shard !== undefined && !shard)
      throw new SmartTestError("--shard must look like 2/4 (index/total)", {
        code: "ST_USAGE",
        category: "usage",
      });
    const outcome = await st.run({
      ...(source ? { source } : {}),
      ...(mode ? { mode } : {}),
      all: !!flags.all,
      ...(flags["no-cache"] ? { cache: false } : {}),
      ...(shard ? { shard } : {}),
      ...(flags.bail ? { bail: true } : {}),
      coverage: !!flags.coverage,
      ...(retries !== undefined ? { retries } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(workers !== undefined ? { workers } : {}),
      signal: ac.signal,
      ...(formats
        ? { formats: [...new Set([...formats, ...(markdownForCI ? ["markdown" as const] : [])])] }
        : markdownForCI
          ? { formats: [...st.config.reports.formats, "markdown"] }
          : {}),
      ...(flags.output ? { outputDir: flags.output } : {}),
      command: `run ${flags.all ? "--all" : "--affected"}`,
      onAnalysis: (a) => {
        spinner.stop();
        if (flags.json || flags.quiet) return;
        const cs = a.input.changeSet;
        const symbols = a.decision.affectedSymbols.length;
        ctx.out();
        ctx.out(
          `${t.cyan("◇")} ${pad(t.dim("Changes"), 10)}${a.input.description} · ${cs.changes.length} file${cs.changes.length === 1 ? "" : "s"}${symbols ? ` · ${symbols} affected symbol${symbols === 1 ? "" : "s"}` : ""}`,
        );
        ctx.out(
          `${t.cyan("◇")} ${pad(t.dim("Analysis"), 10)}${a.decision.analysisStatus} · ${a.indexStats.parsed} parsed, ${a.indexStats.reused} cached · ${formatDuration(Object.values(a.timings).reduce((x, y) => x + y, 0))}`,
        );
        const rules = [
          ...new Set(
            a.decision.selectedTests.flatMap((s) =>
              s.reasons.filter((r) => r.ruleName).map((r) => r.ruleName),
            ),
          ),
        ];
        ctx.out(
          `${t.cyan("◇")} ${pad(t.dim("Mode"), 10)}${t.violet(a.decision.safetyMode)}${a.decision.requestedMode !== a.decision.safetyMode ? t.dim(` (upgraded from ${a.decision.requestedMode})`) : ""}${rules.length ? t.dim(`  rule: ${rules.join(", ")}`) : ""}`,
        );
        for (const w of a.decision.warnings) ctx.out(`${t.yellow("▲")} ${w}`);
        if (a.decision.fallbackApplied)
          ctx.out(
            `${t.yellow("▲")} ${a.decision.reasons.find((r) => r.kind === "fallback" || r.kind === "mandatory-trigger")?.message ?? "fallback applied"}`,
          );
        ctx.out();
        const total = a.decision.selectedTests.length + a.decision.skippedTests.length;
        ctx.out(
          `  ${t.pass("SELECTED")}  ${a.decision.selectedTests.length} of ${total} test files${total ? ` · ${Math.round((a.decision.selectedTests.length / total) * 1000) / 10}%` : ""}`,
        );
        if (a.decision.selectedTests.length)
          spinner.start(`Running ${a.decision.selectedTests.length} test file(s)…`);
      },
      onEvent: (e) => {
        if (e.type === "retry")
          spinner.update(`Retrying ${e.files?.length} file(s) (attempt ${e.attempt})…`);
        else if (e.type === "group-start")
          spinner.update(
            `Running ${e.group.files.length} file(s) with ${e.group.adapter}${e.group.dir ? ` in ${e.group.dir}` : ""}…`,
          );
      },
    });
    spinner.stop();
    if (flags.json) {
      ctx.json("run", {
        report: outcome.report,
        reports: outcome.written,
        integrityIssues: outcome.integrityIssues,
      });
    } else if (!flags.quiet) {
      printRun(ctx, outcome.report, outcome.written);
    } else {
      const s = outcome.report.summary;
      ctx.out(
        `${s.passed} passed · ${s.failed} failed · ${s.skippedBySelection} skipped (not run)`,
      );
    }
    if (outcome.written.markdown && process.env.GITHUB_STEP_SUMMARY) {
      const { appendFile, readFile } = await import("node:fs/promises");
      await appendFile(
        process.env.GITHUB_STEP_SUMMARY,
        await readFile(outcome.written.markdown, "utf8"),
      );
    }
    if (outcome.integrityIssues.length) {
      ctx.err(
        t.red(
          `✕ Report integrity check failed (this is a SmartTest bug): ${outcome.integrityIssues.join("; ")}`,
        ),
      );
      return ExitCode.Internal;
    }
    if (flags.open && outcome.written.html) openFile(outcome.written.html);
    return outcome.exitCode;
  } finally {
    spinner.stop();
    process.off("SIGINT", onSigint);
  }
}

function printRun(ctx: Ctx, report: RunReport, written: Record<string, string>): void {
  const { t } = ctx;
  const width = Math.min(60, Math.max(20, ...report.executions.map((e) => e.file.length)) + 2);
  for (const e of report.executions) {
    const tests = e.tests;
    const counts = (s: string) => tests.filter((x) => x.status === s).length;
    const icon =
      e.status === "cached-pass"
        ? t.cyan("⧉")
        : e.status === "passed"
          ? t.green("✓")
          : e.status === "flaky"
            ? t.yellow("↻")
            : e.status === "skipped"
              ? t.dim("○")
              : t.red("✕");
    const detail =
      e.status === "cached-pass"
        ? `${tests.length} passed earlier · cached, not run`
        : e.status === "passed" || e.status === "flaky"
          ? `${counts("passed") + counts("flaky")} passed${counts("flaky") ? t.yellow(` (${counts("flaky")} flaky)`) : ""}`
          : e.status === "skipped"
            ? "skipped by the test itself"
            : `${counts("failed")} failed${counts("timed-out") ? ` · ${counts("timed-out")} timed out` : ""}${e.status === "infrastructure-error" ? " · infrastructure error" : ""}`;
    ctx.out(
      `  ${icon} ${pad(e.file, width)}${t.dim(detail)}  ${t.dim(formatDuration(e.durationMs))}`,
    );
    if (
      e.status !== "passed" &&
      e.status !== "flaky" &&
      e.status !== "skipped" &&
      e.status !== "cached-pass"
    ) {
      for (const f of tests
        .filter((x) => x.status !== "passed" && x.status !== "skipped" && x.status !== "pending")
        .slice(0, 3)) {
        ctx.out(`      ${t.red("›")} ${f.testId.slice(f.testId.indexOf("::") + 2)}`);
        const msg = (f.error?.message ?? "")
          .split("\n")
          .filter((l) => l.trim() && !/node_modules|node:internal/.test(l))
          .slice(0, 4);
        for (const m of msg) ctx.out(`        ${t.dim(m.slice(0, 160))}`);
      }
    }
  }
  const s = report.summary;
  if (s.skippedBySelection)
    ctx.out(
      `  ${t.skip("SKIPPED")}   ${s.skippedBySelection} test file${s.skippedBySelection === 1 ? "" : "s"} · not run · no static dependency on the change`,
    );
  for (const w of report.warnings) ctx.out(`  ${t.yellow("▲")} ${w}`);
  ctx.out();
  const failed = s.failed + s.timedOut;
  const line = [
    s.passed || !failed ? t.green(`${s.passed} passed`) : `${s.passed} passed`,
    failed ? t.red(`${failed} failed`) : "0 failed",
    ...(s.flaky ? [t.yellow(`${s.flaky} flaky`)] : []),
    ...(s.cached ? [t.cyan(`${s.cached} cached (not run)`)] : []),
    ...(s.infrastructureErrors ? [t.red(`${s.infrastructureErrors} infrastructure error(s)`)] : []),
    `${s.skippedBySelection} skipped (not run)`,
    formatDuration(s.durationMs),
  ].join(t.dim(" · "));
  ctx.out(`  ${failed || s.infrastructureErrors ? t.red("✕") : t.green("✓")} ${line}`);
  if (report.coverage)
    ctx.out(
      `  ${t.dim("Coverage")} lines ${report.coverage.lines}% · branches ${report.coverage.branches}% ${t.dim(`(${report.coverage.scope === "full" ? "full suite" : "selected tests only — not project coverage"})`)}`,
    );
  if (report.estimate?.knownSkipped)
    ctx.out(
      `  ${t.dim("Saved")}    ≈ ${formatDuration(report.estimate.skippedTestTimeMs)} of test time not run ${t.dim(`(estimate from previous runs of ${report.estimate.knownSkipped}/${report.estimate.totalSkipped} skipped files)`)}`,
    );
  if (written.html) ctx.out(`  ${t.dim("Report")}   ${rel(ctx, written.html)}`);
  if (report.decision.selectedTests.length)
    ctx.out(`  ${t.dim("↳ why these tests?")} ${t.cyan("smarttest explain <test>")}`);
}

async function cmdImpact(ctx: Ctx): Promise<number> {
  const { t, flags } = ctx;
  const st = await ctx.open();
  const source = sourceOf(flags);
  const mode = modeOf(flags);
  const a = await st.analyze({ ...(source ? { source } : {}), ...(mode ? { mode } : {}) });
  if (flags.json) {
    ctx.json("impact", {
      description: a.input.description,
      changeSet: a.input.changeSet,
      decision: a.decision,
      timings: a.timings,
    });
    return ExitCode.Success;
  }
  ctx.out(
    `${t.cyan("◇")} ${a.input.description} · ${a.input.changeSet.changes.length} changed file(s) · mode ${t.violet(a.decision.safetyMode)} · analysis ${a.decision.analysisStatus}`,
  );
  for (const c of a.input.changeSet.changes) {
    const d = a.diffs.get(c.path);
    ctx.out(
      `  ${t.dim(c.type.padEnd(9))}${c.path}${d ? t.dim(`  ${[...new Set(d.changes.map((x) => x.kind))].join(", ")}`) : ""}`,
    );
  }
  for (const g of a.decision.details.graphDiff ?? []) {
    ctx.out(
      `  ${t.dim("deps")}     ${g.file}${g.added.map((x) => t.green(` +${x}`)).join("")}${g.removed.map((x) => t.red(` -${x}`)).join("")}`,
    );
  }
  for (const w of a.decision.warnings) ctx.out(`${t.yellow("▲")} ${w}`);
  ctx.out();
  ctx.out(`  ${t.pass("SELECTED")}  ${a.decision.selectedTests.length}`);
  for (const s of a.decision.selectedTests)
    ctx.out(`  ${t.green("■")} ${s.filePath}  ${t.dim(s.reasons[0]?.message ?? "")}`);
  const obs = a.decision.details.observedSkips?.length ?? 0;
  ctx.out(
    `  ${t.skip("SKIPPED")}   ${a.decision.skippedTests.length} · not run${obs ? t.dim(` (${obs} ruled out by traces that never ran the changed code)`) : ""}`,
  );
  if (flags.verbose)
    for (const s of a.decision.skippedTests) ctx.out(`  ${t.dim("□")} ${t.dim(s.filePath)}`);
  const unprotected = a.decision.details.unprotected ?? [];
  if (unprotected.length) {
    ctx.out();
    ctx.out(`  ${t.yellow("UNPROTECTED")} ${unprotected.length} changed unit(s) no test reaches`);
    for (const u of unprotected.slice(0, flags.verbose ? undefined : 10))
      ctx.out(`  ${t.yellow("▲")} ${u}`);
    if (!flags.verbose && unprotected.length > 10)
      ctx.out(t.dim(`  … ${unprotected.length - 10} more (--verbose)`));
  }
  return ExitCode.Success;
}

async function cmdTrace(ctx: Ctx): Promise<number> {
  const { t, flags } = ctx;
  const st = await ctx.open();
  if (flags.status) {
    const { index } = await st.loadIndex();
    const view = await st.traceView(undefined, index);
    const { tests } = await st.discoverTests(index);
    const fresh = tests.filter((x) => view?.isFresh(x));
    const traced = tests.filter((x) => view?.trace(x));
    if (flags.json)
      ctx.json("trace", { tests: tests.length, traced: traced.length, fresh: fresh.length });
    else {
      ctx.out(`${t.bold("Traces")} · ${tests.length} test file(s)`);
      ctx.out(`  ${pad("Traced", 10)}${traced.length}`);
      ctx.out(
        `  ${pad("Fresh", 10)}${fresh.length}  ${t.dim("(every loaded file unchanged since tracing)")}`,
      );
      ctx.out(
        `  ${pad("Stale", 10)}${traced.length - fresh.length}  ${t.dim("(refresh with `smarttest trace --stale`)")}`,
      );
    }
    return ExitCode.Success;
  }
  const concurrency = intFlag(flags.workers, "workers");
  const r = await st.collectTraces({
    ...(ctx.positionals.length ? { files: ctx.positionals } : {}),
    ...(flags.stale ? { stale: true } : {}),
    ...(concurrency ? { concurrency } : {}),
    onProgress: (m) => {
      if (!flags.json && !flags.quiet) ctx.err(t.dim(m));
    },
  });
  if (flags.json) ctx.json("trace", { traced: r.traced, failed: r.failed, stored: r.kept });
  else {
    ctx.out(
      `${t.bold("Traced")} ${r.traced} test file(s) · ${r.kept} stored in .smarttest/state/traces.json`,
    );
    if (r.failed.length)
      ctx.out(
        `  ${t.yellow("▲")} not traced (failed or no coverage written): ${r.failed.slice(0, 5).join(", ")}${r.failed.length > 5 ? "…" : ""}`,
      );
  }
  return ExitCode.Success;
}

async function cmdShadow(ctx: Ctx): Promise<number> {
  const { t, flags } = ctx;
  const st = await ctx.open();
  if (flags.report) {
    const r = await st.shadowReport();
    if (flags.json) ctx.json("shadow", r);
    else {
      ctx.out(`${t.bold("Shadow Mode")} · ${r.runs} run(s) recorded`);
      ctx.out(
        `  ${pad("Missed", 12)}${r.missed ? t.red(`${r.missed} failure(s) in ${r.runsWithMisses} run(s)`) : t.green("0")}`,
      );
      ctx.out(`  ${pad("Selected", 12)}${r.selected}/${r.total} test files`);
      ctx.out(`  ${pad("Saved", 12)}${r.savedPct}% of full-suite time`);
      for (const rec of r.records.filter((x) => x.failuresMissed.length).slice(-5))
        ctx.out(
          `  ${t.red("✕")} ${rec.at.slice(0, 19)} ${rec.head?.slice(0, 8) ?? ""} ${rec.failuresMissed.join(", ")}`,
        );
    }
    return r.missed ? ExitCode.PolicyFailure : ExitCode.Success;
  }
  const source = sourceOf(flags);
  const mode = modeOf(flags);
  const spinner = new Spinner(ctx.io, !flags.json && !!ctx.io.stderr.isTTY);
  spinner.start("Shadow Mode: running the full suite next to the selection…");
  const { record } = await st
    .shadow({ ...(source ? { source } : {}), ...(mode ? { mode } : {}) })
    .finally(() => spinner.stop());
  if (flags.json) ctx.json("shadow", record);
  else {
    ctx.out(
      `${t.bold("Shadow Mode")} · selected ${record.selected}/${record.total} · mode ${t.violet(record.mode)}`,
    );
    ctx.out(
      `  ${pad("Missed", 12)}${record.failuresMissed.length ? t.red(record.failuresMissed.join(", ")) : t.green("0")}`,
    );
    ctx.out(
      `  ${pad("Full suite", 12)}${formatDuration(record.fullMs)} · selection ${formatDuration(record.selectedMs)}`,
    );
    ctx.out(
      t.dim("  Recorded in .smarttest/shadow/history.jsonl · summary: smarttest shadow --report"),
    );
  }
  return record.failuresMissed.length ? ExitCode.PolicyFailure : ExitCode.Success;
}

async function cmdExplain(ctx: Ctx): Promise<number> {
  const { t, flags } = ctx;
  const target = ctx.positionals[0];
  if (!target)
    throw new SmartTestError("Missing target", {
      code: "ST_USAGE",
      category: "usage",
      hint: "smarttest explain <test | file | file#Symbol>",
    });
  const st = await ctx.open();
  const source = sourceOf(flags);
  const mode = modeOf(flags);
  const units =
    typeof flags.units === "string"
      ? flags.units
          .split(",")
          .map((u) => u.trim())
          .filter(Boolean)
      : undefined;
  if (units && target.includes("#"))
    throw new SmartTestError("--units takes a file, not file#Symbol", {
      code: "ST_USAGE",
      category: "usage",
      hint: "smarttest explain src/a.ts --units A,B.method",
    });
  const r = await st.explain(target.replace(/\\/g, "/").replace(/^\.\//, ""), {
    ...(source ? { source } : {}),
    ...(mode ? { mode } : {}),
    ...(units ? { units } : {}),
    fresh: !!flags.fresh,
  });
  if (flags.json) {
    ctx.json("explain", r);
    return ExitCode.Success;
  }
  if (r.kind === "test") {
    const head =
      r.status === "selected"
        ? t.pass("SELECTED")
        : r.status === "skipped"
          ? t.skip("SKIPPED (not run)")
          : t.warnPill("UNKNOWN");
    ctx.out(`${head}  ${target}`);
    ctx.out(t.bold("Reasons"));
    for (const reason of r.reasons) ctx.out(`  • ${reason}`);
    if (r.path) ctx.out(`  ${t.dim(r.path.join(" → "))}`);
    if (r.confidence) {
      ctx.out(t.bold("Confidence"));
      ctx.out(`  ${r.confidence}`);
    }
    ctx.out(t.dim(`Analysis: ${r.analysisStatus} · mode: ${r.mode} · ${r.description}`));
  } else {
    ctx.out(
      `${t.bold(target)} is protected by ${r.tests.length} test file(s)${r.risk !== "low" ? ` · risk ${t.yellow(r.risk)}` : ""}${r.rules.length ? t.dim(` · rules: ${r.rules.join(", ")}`) : ""}`,
    );
    for (const h of r.tests) ctx.out(`  ${t.green("■")} ${h.test}  ${t.dim(h.path.join(" → "))}`);
    if (!r.tests.length)
      ctx.out(
        `  ${t.yellow("▲")} No test depends on it — consider \`smarttest generate --path ${target.split("#")[0]}\``,
      );
    for (const u of r.units ?? [])
      ctx.out(
        `  ${t.bold(u.unit)}  ${u.tests.length ? `${u.tests.length} test file(s)` : t.yellow("no test depends on it")}`,
      );
    for (const u of r.uncertainty) ctx.out(`  ${t.yellow("▲")} ${u.file}: ${u.reasons.join("; ")}`);
  }
  return ExitCode.Success;
}

async function cmdValidate(ctx: Ctx): Promise<number> {
  const { t, flags } = ctx;
  const st = await ctx.open();
  const source = sourceOf(flags);
  const mode = modeOf(flags);
  const spinner = new Spinner(ctx.io, !flags.json && !!ctx.io.stderr.isTTY);
  spinner.start("Running selection analysis and the full reference suite…");
  const v = await st
    .validateSelection({ ...(source ? { source } : {}), ...(mode ? { mode } : {}) })
    .finally(() => spinner.stop());
  if (flags.json) ctx.json("validate-selection", v);
  else {
    ctx.out(`${t.bold("Selection validation")} · mode ${t.violet(v.decision.safetyMode)}`);
    ctx.out(`  Selected            ${v.selected}`);
    ctx.out(`  Skipped             ${v.skipped}`);
    ctx.out(
      `  Failures found      ${v.failuresFound.length}${v.failuresFound.length ? t.dim(`  ${v.failuresFound.join(", ")}`) : ""}`,
    );
    ctx.out(
      `  Failures missed     ${v.failuresMissed.length ? t.red(String(v.failuresMissed.length)) : t.green("0")}`,
    );
    for (const m of v.failuresMissed) ctx.out(`    ${t.red("✕")} ${m.test} ${t.dim(m.note)}`);
    if (v.flakyInterference.length)
      ctx.out(`  Flaky interference  ${t.yellow(v.flakyInterference.join(", "))}`);
    ctx.out(`  Full suite          ${formatDuration(v.fullDurationMs)}`);
    ctx.out(
      `  Selected share      ${formatDuration(v.selectedDurationMs)} + analysis ${formatDuration(v.analysisOverheadMs)}`,
    );
    ctx.out(`  Estimated saving    ${v.savedPct}%  ${t.dim("(measured on this change only)")}`);
  }
  return v.failuresMissed.length ? ExitCode.PolicyFailure : ExitCode.Success;
}

// ── project commands ──────────────────────────────────────────────────────────────────────

async function cmdScan(ctx: Ctx): Promise<number> {
  const { t } = ctx;
  const st = await ctx.open();
  const s = await st.scan();
  if (ctx.flags.json) {
    ctx.json("scan", s);
    return ExitCode.Success;
  }
  const p = s.profile;
  ctx.out(`${t.bold(p.name)} ${t.dim(p.root)}`);
  ctx.out(
    `  ${pad(t.dim("Stack"), 14)}${p.frameworks.map((f) => f.value).join(", ")} · ${p.layout.typescript ? "TypeScript" : "JavaScript"} · ${p.layout.moduleType.toUpperCase()}`,
  );
  ctx.out(
    `  ${pad(t.dim("Packages"), 14)}${p.packageManager.name === "unknown" ? "no lockfile detected" : p.packageManager.name}${p.workspaces.length ? ` · ${p.workspaces.length} workspace packages` : ""}`,
  );
  ctx.out(
    `  ${pad(t.dim("Runners"), 14)}${p.runners.map((r) => `${r.adapter}${r.dir ? ` (${r.dir})` : ""}`).join(", ") || t.yellow("none")}`,
  );
  ctx.out(`  ${pad(t.dim("Tests"), 14)}${s.tests.total} files · layout ${p.tests.layout}`);
  ctx.out(`  ${pad(t.dim("Changes"), 14)}${s.vcs === "git" ? "git" : "native snapshots"}`);
  ctx.out(
    `  ${pad(t.dim("Index"), 14)}${s.index.files} files · ${s.index.symbols} symbols · ${s.index.imports} imports · ${formatDuration(s.index.durationMs)} (${s.index.parsed} parsed, ${s.index.reused} cached)`,
  );
  ctx.out(
    `  ${pad(t.dim("Graph"), 14)}${s.graph.edges} edges · ${s.graph.uncertainFiles} file(s) with uncertainty`,
  );
  if (s.unresolved.length) {
    ctx.out(`  ${t.yellow("▲")} ${s.unresolved.length} unresolved import(s):`);
    for (const u of s.unresolved.slice(0, ctx.flags.verbose ? 1000 : 10))
      ctx.out(`    ${u.file} → ${u.specifier} ${t.dim(u.reason)}`);
  }
  if (s.dynamic.length) {
    ctx.out(`  ${t.yellow("▲")} ${s.dynamic.length} dynamic import(s)/require(s):`);
    for (const d of s.dynamic.slice(0, ctx.flags.verbose ? 1000 : 5))
      ctx.out(`    ${d.file} ${t.dim(d.detail)}`);
  }
  for (const w of p.warnings) ctx.out(`  ${t.yellow("▲")} ${w}`);
  return ExitCode.Success;
}

async function cmdShard(ctx: Ctx): Promise<number> {
  const { t, flags } = ctx;
  const total = intFlag(flags.total, "total");
  const index = intFlag(flags.index, "index");
  if (!total || !index || index > total)
    throw new SmartTestError("smarttest shard needs --total n and --index i (1…n)", {
      code: "ST_USAGE",
      category: "usage",
    });
  const st = await ctx.open();
  const source = sourceOf(flags);
  const files = await st.shardPlan({
    total,
    index,
    ...(source ? { source } : {}),
    ...(flags.all ? { all: true } : {}),
  });
  if (flags.json) ctx.json("shard", { total, index, files });
  else {
    ctx.out(t.dim(`shard ${index}/${total} · ${files.length} test file(s)`));
    for (const f of files) ctx.out(f);
  }
  return ExitCode.Success;
}

async function cmdFlaky(ctx: Ctx): Promise<number> {
  const { t, flags } = ctx;
  const st = await ctx.open();
  const minRate = flags["min-rate"] !== undefined ? Number(flags["min-rate"]) : 0.05;
  const entries = await st.flakyTests(minRate);
  if (flags.json) ctx.json("flaky", { minRate, tests: entries });
  else if (!entries.length)
    ctx.out(
      `${t.green("✓")} No test above a ${Math.round(minRate * 100)}% flake rate in the recorded runs.`,
    );
  else {
    ctx.out(
      `${t.bold("Flaky tests")} · flake rate ≥ ${Math.round(minRate * 100)}% · from .smarttest/state/history.json`,
    );
    for (const e of entries)
      ctx.out(
        `  ${t.yellow("↻")} ${pad(`${Math.round(e.flakeRate * 100)}%`, 6)}${e.testId}  ${t.dim(`${e.runs} runs · recent ${e.recent}`)}`,
      );
    ctx.out();
    ctx.out(t.dim("Suggested rule (retries, never a silent skip):"));
    const files = [...new Set(entries.map((e) => e.file))].slice(0, 5);
    ctx.out(
      t.dim(
        `  { name: "flaky-retry", match: { path: "{${files.join(",")}}" }, execution: { retries: 2 } }`,
      ),
    );
  }
  return ExitCode.Success;
}

async function cmdWatch(ctx: Ctx): Promise<number> {
  const { t, flags } = ctx;
  const st = await ctx.open();
  const mode = modeOf(flags);
  ctx.out(
    `${t.cyan("◇")} Watching ${rel(ctx, st.root) || "."} · each save runs the tests it can affect · Ctrl-C to stop`,
  );
  const watcher = await st.watch({
    ...(mode ? { mode } : {}),
    onAnalysis: (a) => {
      const sel = a.decision.selectedTests.length;
      ctx.out();
      ctx.out(
        `${t.cyan("◇")} ${new Date().toLocaleTimeString()} · ${a.input.changeSet.changes.map((c) => c.path).join(", ")} · ${t.pass("SELECTED")} ${sel} of ${sel + a.decision.skippedTests.length}`,
      );
    },
    onRun: (outcome) => {
      const s = outcome.report.summary;
      if (!outcome.report.executions.length) ctx.out(t.dim("  no test reaches these changes"));
      for (const e of outcome.report.executions)
        ctx.out(
          `  ${e.status === "passed" ? t.green("✓") : e.status === "skipped" ? t.dim("○") : t.red("✕")} ${e.file}`,
        );
      if (outcome.report.executions.length)
        ctx.out(
          `  ${s.failed ? t.red(`${s.failed} failed`) : t.green(`${s.passed} passed`)} · ${s.skippedBySelection} not run`,
        );
    },
    onError: (e) => ctx.err(`${t.red("✕")} ${e.message}`),
  });
  await new Promise<void>((resolve) => {
    process.once("SIGINT", () => {
      watcher.close();
      resolve();
    });
  });
  return ExitCode.Success;
}

async function cmdMigrate(ctx: Ctx): Promise<number> {
  const { t, flags } = ctx;
  if (flags.to !== "vitest")
    throw new SmartTestError("smarttest migrate supports --to vitest (from Jest)", {
      code: "ST_USAGE",
      category: "usage",
      hint: "smarttest migrate --to vitest [--dir <project>] [--dry-run] [--yes]",
    });
  const st = await ctx.open();
  const plan = await st.migratePlan({
    to: "vitest",
    ...(flags.dir !== undefined ? { dir: flags.dir } : {}),
  });
  const { previewDiff } = await import("@smarttest/smart-init");
  if (flags.json && (flags["dry-run"] || !flags.yes)) ctx.json("migrate", { plan });
  else {
    ctx.out(`${t.bold("Migrate Jest → Vitest")} · ${plan.files.length} file(s)`);
    for (const f of plan.files) {
      ctx.out(
        `  ${f.action === "create" ? t.green("+") : t.yellow("~")} ${pad(f.path, 30)}${t.dim(f.reason)}`,
      );
      if (flags["dry-run"] || flags.verbose)
        for (const l of previewDiff(f))
          ctx.out(`      ${l.startsWith("+") ? t.green(l) : t.red(l)}`);
    }
    for (const n of plan.notes) ctx.out(`  ${t.yellow("▲")} ${n.file}:${n.line} ${n.message}`);
    if (plan.install) ctx.out(`  ${t.dim("Then install Vitest:")} ${plan.install}`);
  }
  if (!plan.files.length || flags["dry-run"]) return ExitCode.Success;
  if (!flags.yes) {
    if (!ctx.interactive)
      throw new SmartTestError("migrate needs confirmation", {
        code: "ST_INIT_CONFIRMATION_REQUIRED",
        category: "configuration",
        hint: "Re-run with --yes, or --dry-run to preview.",
      });
    if (!(await confirm(ctx.io, t, "Apply the migration?"))) return ExitCode.Success;
  }
  const applied = await st.applyFiles(plan.files);
  if (flags.json) ctx.json("migrate", { plan, applied });
  else {
    for (const p of applied) ctx.out(`${t.green("✓")} wrote ${p}`);
    ctx.out(t.dim("Undo: smarttest init --rollback"));
  }
  return ExitCode.Success;
}

async function cmdSync(ctx: Ctx): Promise<number> {
  const { t, flags } = ctx;
  const st = await ctx.open();
  const r = await st.syncPlan();
  if (flags.json) ctx.json("sync", { drift: r.drift, manual: r.manual, changes: !!r.after });
  else if (!r.drift.length) ctx.out(`${t.green("✓")} Configuration matches the project.`);
  else {
    ctx.out(t.bold("Configuration drift"));
    for (const d of r.drift)
      ctx.out(
        `  ${t.yellow("~")} ${pad(d.key, 16)}${d.current} → ${t.bold(d.proposed)}  ${t.dim(d.reason)}`,
      );
    const { previewDiff } = await import("@smarttest/smart-init");
    if (r.after && r.path)
      for (const l of previewDiff({
        path: r.path,
        action: "modify",
        reason: "",
        before: r.before ?? "",
        after: r.after,
        risk: "medium",
      }))
        ctx.out(`    ${l.startsWith("+") ? t.green(l) : t.red(l)}`);
    for (const m of r.manual) ctx.out(`  ${t.yellow("▲")} by hand: ${m}`);
  }
  if (!r.drift.length) return ExitCode.Success;
  if (flags.check) return ExitCode.ConfigurationFailure;
  if (flags["dry-run"] || !r.after) return ExitCode.Success;
  if (!flags.yes) {
    if (!ctx.interactive)
      throw new SmartTestError("sync needs confirmation", {
        code: "ST_INIT_CONFIRMATION_REQUIRED",
        category: "configuration",
        hint: "Re-run with --yes, --dry-run to preview, or --check in CI.",
      });
    if (!(await confirm(ctx.io, t, "Update the configuration?"))) return ExitCode.Success;
  }
  const ok = await st.applySync(r);
  if (!flags.json)
    ctx.out(
      ok
        ? `${t.green("✓")} updated ${rel(ctx, r.path ?? "")}`
        : t.yellow("▲ the config changed meanwhile; nothing written"),
    );
  return ExitCode.Success;
}

async function cmdDoctor(ctx: Ctx): Promise<number> {
  const { t } = ctx;
  const st = await ctx.open();
  if (ctx.flags.fix) {
    const fixed = await st.doctorFix();
    if (!ctx.flags.json) {
      for (const f of fixed) ctx.out(`${t.green("✓")} fixed: ${f}`);
      if (!fixed.length) ctx.out(t.dim("Nothing to fix."));
    }
  }
  const findings = await st.doctor();
  if (ctx.flags.json) ctx.json("doctor", { findings });
  else {
    const icon = { ok: t.green("✓"), info: t.cyan("i"), warn: t.yellow("▲"), error: t.red("✕") };
    for (const f of findings) {
      ctx.out(`${icon[f.severity]} ${pad(t.dim(f.check), 14)}${f.message}`);
      if (f.hint) ctx.out(`  ${" ".repeat(14)}${t.dim(`hint: ${f.hint}`)}`);
    }
  }
  const errors = findings.filter((f) => f.severity === "error");
  if (!errors.length) return ExitCode.Success;
  return errors.some((e) => e.check === "config" || e.check === "rules")
    ? ExitCode.ConfigurationFailure
    : ExitCode.InfrastructureFailure;
}

async function cmdInit(ctx: Ctx): Promise<number> {
  const { t, flags } = ctx;
  const st = await ctx.open();
  if (flags.rollback) {
    const r = await st.rollbackInit({ dryRun: !!flags["dry-run"] });
    if (flags.json) ctx.json("init", { rollback: r });
    else {
      if (!r.removed.length && !r.restored.length && !r.conflicts.length)
        ctx.out("Nothing to roll back.");
      const would = flags["dry-run"] ? "would be " : "";
      for (const p of r.removed) ctx.out(`${t.green("−")} ${p} ${would}removed`);
      for (const p of r.restored) ctx.out(`${t.green("↺")} ${p} ${would}restored`);
      for (const p of r.conflicts) ctx.out(`${t.yellow("▲")} ${p}`);
    }
    return r.conflicts.length ? ExitCode.PolicyFailure : ExitCode.Success;
  }
  const overrides: Parameters<SmartTest["initPlan"]>[0] = {};
  const mode = modeOf(flags);
  if (mode) overrides.mode = mode;
  if (flags.layout) {
    if (!["mirror", "colocated", "domain", "custom"].includes(flags.layout))
      throw new SmartTestError("--layout must be mirror, colocated, domain or custom", {
        code: "ST_USAGE",
        category: "usage",
      });
    overrides.layout = flags.layout as "mirror";
  }
  if (flags.advanced && ctx.interactive) {
    overrides.layout = await select(ctx.io, t, "Test layout", [
      { value: "mirror", label: "Mirror", hint: "tests/unit/<path>/X.test.ts" },
      { value: "colocated", label: "Colocated", hint: "src/<path>/X.test.ts" },
      { value: "domain", label: "Domain", hint: "tests/unit/<domain>/X.test.ts" },
    ]);
    overrides.mode = await select(ctx.io, t, "Impact mode", [
      { value: "balanced", label: "Balanced", hint: "recommended" },
      { value: "fast", label: "Fast", hint: "local feedback" },
      { value: "safe", label: "Safe", hint: "releases / critical code" },
    ]);
  }
  const plan = await st.initPlan(overrides);
  if (flags.json && (flags["dry-run"] || !flags.yes)) {
    ctx.json("init", { plan });
    if (flags["dry-run"]) return ExitCode.Success;
  }
  if (!flags.json) {
    ctx.out(`${t.cyan("Detected:")} ${plan.summary}`);
    ctx.out();
    ctx.out(t.bold("Recommended"));
    for (const r of plan.recommendations)
      ctx.out(`  ${pad(r.key, 17)}${pad(t.bold(r.value), 26)} ${t.dim(`(${r.reason})`)}`);
    if (plan.warnings.length) {
      ctx.out();
      ctx.out(t.bold("Warnings"));
      for (const w of plan.warnings) ctx.out(`  ${t.yellow("▲")} ${w}`);
    }
    ctx.out();
    ctx.out(t.bold("Changes"));
    const { previewDiff } = await import("@smarttest/smart-init");
    for (const f of plan.files) {
      const sym =
        f.action === "create" ? t.green("+") : f.action === "modify" ? t.yellow("~") : t.dim("○");
      ctx.out(`  ${sym} ${pad(f.path, 22)}${t.dim(f.reason)}`);
      if (flags["dry-run"] || flags.verbose)
        for (const l of previewDiff(f))
          ctx.out(`      ${l.startsWith("+") ? t.green(l) : t.red(l)}`);
    }
  }
  if (flags["dry-run"]) {
    if (!flags.json) ctx.out(t.dim("\nDry run — nothing was written."));
    return ExitCode.Success;
  }
  const pending = plan.files.filter((f) => f.action !== "skip");
  if (!pending.length) {
    if (!flags.json) ctx.out(t.green("\n✓ Already initialised — nothing to change."));
    else if (flags.yes) ctx.json("init", { plan, applied: [] });
    return ExitCode.Success;
  }
  if (!flags.yes && !flags.auto) {
    if (!ctx.interactive) {
      throw new SmartTestError("init needs confirmation", {
        code: "ST_INIT_CONFIRMATION_REQUIRED",
        category: "configuration",
        hint: "Re-run with --yes (all changes) or --auto (low-risk changes only).",
      });
    }
    for (const f of [...pending]) {
      if (
        f.action === "modify" &&
        !(await confirm(ctx.io, t, `Apply change to ${f.path}? (${f.reason})`))
      )
        f.action = "skip";
    }
    if (!(await confirm(ctx.io, t, "Apply the setup?"))) {
      ctx.out("Nothing written.");
      return ExitCode.Success;
    }
  }
  const res = await st.initApply(plan, { onlyLowRisk: !!flags.auto && !flags.yes });
  if (flags.json) ctx.json("init", { plan, ...res });
  else {
    ctx.out();
    for (const p of res.applied) ctx.out(`${t.green("✓")} wrote ${p}`);
    for (const m of res.validation.messages)
      ctx.out(`${res.validation.ok ? t.green("✓") : t.yellow("▲")} ${m}`);
    ctx.out(t.dim(`Setup report: ${rel(ctx, res.reportPath)}`));
    ctx.out();
    ctx.out(
      `Next: ${t.cyan("npx smarttest run --affected")} · undo with ${t.cyan("npx smarttest init --rollback")}`,
    );
  }
  return res.validation.ok ? ExitCode.Success : ExitCode.ConfigurationFailure;
}

async function cmdCi(ctx: Ctx): Promise<number> {
  const { t, flags } = ctx;
  const { detectCi, prepareCi } = await import("@smarttest/core");
  const ci = detectCi(process.env);
  if (flags.base !== undefined || flags.staged || flags.uncommitted)
    throw new SmartTestError(
      "smarttest ci picks the base itself; use smarttest run to choose one",
      {
        code: "ST_USAGE",
        category: "usage",
      },
    );
  const plan = flags.all
    ? { ci, all: true, steps: [], warnings: [] }
    : await prepareCi(ctx.root, ci);
  if (!flags.json && !flags.quiet) {
    const what = plan.all
      ? "the full suite"
      : `${plan.direct ? "changes since" : "the merge-base with"} ${plan.base}`;
    ctx.out(
      `${t.cyan("◇")} ${pad(t.dim("CI"), 10)}${ci.provider === "none" ? "none detected" : ci.provider}${ci.isPullRequest ? ` · merge request into ${ci.targetBranch ?? "?"}` : ci.branch ? ` · branch ${ci.branch}` : ""} · comparing with ${what}`,
    );
    for (const s of plan.steps) ctx.out(`  ${t.dim(s)}`);
    for (const w of plan.warnings) ctx.out(`${t.yellow("▲")} ${w}`);
  }
  if (flags["dry-run"]) {
    if (flags.json) ctx.json("ci", plan);
    return ExitCode.Success;
  }
  const st = await ctx.open();
  if (!plan.all && plan.base) {
    flags.base = plan.base;
    flags["base-mode"] = plan.direct ? "direct" : "merge-base";
  }
  flags.all = plan.all;
  flags.format ??= [...new Set([...st.config.reports.formats, "junit", "markdown"])];
  flags["non-interactive"] = true;
  return cmdRun({ ...ctx, interactive: false });
}

async function cmdHook(ctx: Ctx): Promise<number> {
  const { t, flags } = ctx;
  const st = await ctx.open();
  const sub = ctx.positionals[0] ?? "status";
  const manager = flags.manager as "husky" | "lefthook" | "simple-git-hooks" | "git" | undefined;
  if (manager && !["husky", "lefthook", "simple-git-hooks", "git"].includes(manager))
    throw new SmartTestError("--manager must be husky, lefthook, simple-git-hooks or git", {
      code: "ST_USAGE",
      category: "usage",
    });
  const { previewDiff } = await import("@smarttest/smart-init");
  if (sub === "status" || sub === "install") {
    const plan = await st.hookInstallPlan({
      ...(manager ? { manager } : {}),
      ...(flags.replace ? { replace: true } : {}),
      stage: flags["pre-push"] ? "pre-push" : "pre-commit",
    });
    if (sub === "status") {
      const history = await st.hookHistory();
      const other = await st.hookInstallPlan({
        ...(manager ? { manager } : {}),
        stage: flags["pre-push"] ? "pre-commit" : "pre-push",
      });
      if (flags.json) ctx.json("hook", { status: plan, other, history });
      else {
        ctx.out(
          `${t.bold("Git hook")} · ${plan.manager} · ${plan.file} ${t.dim(`(${plan.evidence})`)}`,
        );
        ctx.out(
          `  ${pad("SmartTest", 12)}${plan.installed ? t.green("installed") : t.yellow("not installed")}`,
        );
        for (const r of plan.remaining)
          ctx.out(`  ${t.yellow("▲")} line ${r.line} runs a whole suite: ${t.dim(r.command)}`);
        ctx.out(
          `  ${other.stage}: ${other.installed ? "installed" : "not installed"} (${other.file})`,
        );
        ctx.out(
          `  ${history.runs} recorded runs · median ${formatDuration(history.medianMs)} · slowest ${formatDuration(history.slowestMs)} · ${history.failures} recent failures`,
        );
        if ((plan.installed || other.installed) && !history.installedLocally)
          ctx.out("  SmartTest executable missing: install the project's dependencies.");
        for (const b of history.bypasses) ctx.out(`  Bypass ${b.at}: ${b.stage} ${b.reason}`);
        for (const c of history.withoutHook.without.slice(0, 5))
          ctx.out(`  No matching successful hook record: ${c.sha} ${c.subject}`);
        if (!plan.installed)
          ctx.out(
            t.dim(
              `  Install: smarttest hook install${flags["pre-push"] ? " --pre-push" : ""} [--replace]`,
            ),
          );
      }
      return ExitCode.Success;
    }
    if (plan.installed && plan.plan.action === "skip") {
      if (flags.json) ctx.json("hook", { plan, applied: [] });
      else ctx.out(`${t.green("✓")} SmartTest already runs in ${plan.file}.`);
      return ExitCode.Success;
    }
    if (!flags.json) {
      ctx.out(`${t.bold("Git hook")} · ${plan.manager} · ${plan.file}`);
      for (const l of previewDiff(plan.plan))
        ctx.out(`    ${l.startsWith("+") ? t.green(l) : t.red(l)}`);
      for (const r of plan.replaced)
        ctx.out(`  ${t.yellow("~")} replaces line ${r.line}: ${t.dim(r.command)}`);
      for (const r of plan.remaining)
        ctx.out(
          `  ${t.yellow("▲")} line ${r.line} still runs a whole suite (use --replace): ${t.dim(r.command)}`,
        );
      for (const n of plan.notes) ctx.out(`  ${t.dim("•")} ${n}`);
    }
    if (flags["dry-run"]) {
      if (flags.json) ctx.json("hook", { plan, applied: [] });
      else ctx.out(t.dim("Dry run — nothing was written."));
      return ExitCode.Success;
    }
    if (!flags.yes) {
      if (!ctx.interactive)
        throw new SmartTestError("hook install needs confirmation", {
          code: "ST_INIT_CONFIRMATION_REQUIRED",
          category: "configuration",
          hint: "Re-run with --yes, or --dry-run to preview.",
        });
      if (!(await confirm(ctx.io, t, `Write ${plan.file}?`))) return ExitCode.Success;
    }
    const applied = await st.applyFiles([plan.plan]);
    if (flags.json) ctx.json("hook", { plan, applied });
    else {
      for (const p of applied) ctx.out(`${t.green("✓")} wrote ${p}`);
      ctx.out(t.dim("Undo: smarttest hook uninstall"));
    }
    return ExitCode.Success;
  }
  if (sub === "uninstall") {
    const files = await st.hookUninstallPlan(manager, flags["pre-push"] ? ["pre-push"] : undefined);
    if (!files.length) {
      if (flags.json) ctx.json("hook", { removed: [] });
      else ctx.out("No SmartTest block found in any hook.");
      return ExitCode.Success;
    }
    if (!flags.json)
      for (const f of files) {
        ctx.out(`${t.yellow("~")} ${f.path} ${t.dim(f.reason)}`);
        for (const l of previewDiff(f)) ctx.out(`    ${l.startsWith("+") ? t.green(l) : t.red(l)}`);
      }
    if (flags["dry-run"]) return ExitCode.Success;
    if (!flags.yes && !ctx.interactive)
      throw new SmartTestError("hook uninstall needs confirmation", {
        code: "ST_INIT_CONFIRMATION_REQUIRED",
        category: "configuration",
        hint: "Re-run with --yes.",
      });
    if (!flags.yes && !(await confirm(ctx.io, t, "Remove the SmartTest block?")))
      return ExitCode.Success;
    const applied = await st.applyFiles(files);
    if (flags.json) ctx.json("hook", { removed: applied });
    else for (const p of applied) ctx.out(`${t.green("✓")} restored ${p}`);
    return ExitCode.Success;
  }
  throw new SmartTestError(`Unknown hook command "${sub}"`, {
    code: "ST_USAGE",
    category: "usage",
    hint: "smarttest hook install | uninstall | status",
  });
}

async function cmdUninstall(ctx: Ctx): Promise<number> {
  const { t, flags } = ctx;
  const st = await ctx.open();
  const { plan } = await st.uninstall({ dryRun: true });
  if (!flags.json) {
    ctx.out(t.bold("SmartTest uninstall"));
    for (const f of plan.files) ctx.out(`  ${t.yellow("−")} ${pad(f.path, 24)}${t.dim(f.reason)}`);
    ctx.out(`  ${t.yellow("−")} ${pad(rel(ctx, plan.storeDir), 24)}${t.dim("local state")}`);
    ctx.out(`  ${t.green("✓")} kept: ${plan.keep.join(", ")}`);
  }
  if (flags["dry-run"]) {
    if (flags.json) ctx.json("uninstall", { plan, done: [] });
    return ExitCode.Success;
  }
  if (!flags.yes) {
    if (!ctx.interactive)
      throw new SmartTestError("uninstall needs confirmation", {
        code: "ST_CONFIRMATION_REQUIRED",
        category: "configuration",
        hint: "Re-run with --yes.",
      });
    if (!(await confirm(ctx.io, t, "Remove SmartTest from this project?", false)))
      return ExitCode.Success;
  }
  const { done } = await st.uninstall();
  if (flags.json) ctx.json("uninstall", { plan, done });
  else for (const d of done) ctx.out(`${t.green("✓")} removed ${d}`);
  ctx.out(t.dim("Remove the package itself with your package manager (e.g. npm rm smarttest)."));
  return ExitCode.Success;
}

// ── tools ─────────────────────────────────────────────────────────────────────────────────

async function cmdGenerate(ctx: Ctx): Promise<number> {
  const { t, flags } = ctx;
  if (flags.mode && !["scaffold"].includes(flags.mode)) {
    throw new SmartTestError(`generate --mode ${flags.mode} is not available in 1.0`, {
      code: "ST_USAGE",
      category: "usage",
      hint: "Use --mode scaffold (default). AI generation arrives in a later release.",
    });
  }
  if (flags.type && !["unit", "integration", "e2e"].includes(flags.type))
    throw new SmartTestError("--type must be unit, integration or e2e", {
      code: "ST_USAGE",
      category: "usage",
    });
  const st = await ctx.open();
  const res = await st.generate({
    ...(flags.class ? { class: flags.class } : {}),
    ...(flags.module ? { module: flags.module } : {}),
    ...(flags.path ? { path: flags.path } : {}),
    ...(flags.type ? { type: flags.type as "unit" } : {}),
    dryRun: !!flags["dry-run"],
    sync: !!flags.sync,
  });
  if (flags.json) {
    ctx.json("generate", res);
    return ExitCode.Success;
  }
  if (res.sync) {
    const s = res.sync;
    ctx.out(t.bold("Test architecture sync"));
    ctx.out(`  ${t.yellow(String(s.missing.length))} source file(s) without tests`);
    for (const m of s.missing.slice(0, flags.verbose ? 1000 : 15))
      ctx.out(`    ${t.green("+")} ${m.target} ${t.dim(`← ${m.source}`)}`);
    ctx.out(`  ${s.orphaned.length ? t.yellow(String(s.orphaned.length)) : "0"} orphaned test(s)`);
    for (const o of s.orphaned) ctx.out(`    ${t.yellow("▲")} ${o.test} ${t.dim(o.reason)}`);
    ctx.out(`  ${s.renamed.length} renamed source(s) with tests to move`);
    for (const r of s.renamed)
      ctx.out(
        `    ${t.cyan("→")} ${r.test} ${t.dim(`(${r.from} → ${r.to}; proposed ${r.proposedTarget})`)}`,
      );
    ctx.out(t.dim("\nSync proposes only — apply with `smarttest generate`."));
    return ExitCode.Success;
  }
  const create = res.items.filter((i) => i.status === "create");
  for (const i of res.items) {
    if (i.status === "create")
      ctx.out(
        `  ${t.green("+")} ${pad(i.target, 52)}${t.dim(`${i.template} · ${i.symbols.length} todo · ← ${i.source}`)}`,
      );
    else if (flags.verbose || i.status === "collision" || i.status === "exists")
      ctx.out(
        `  ${i.status === "covered" ? t.dim("○") : t.yellow("▲")} ${pad(i.target, 52)}${t.dim(i.reason)}`,
      );
  }
  const covered = res.items.filter((i) => i.status === "covered").length;
  ctx.out();
  if (flags["dry-run"]) {
    if (flags.verbose) for (const i of create) ctx.out(`${t.dim(`── ${i.target}`)}\n${i.content}`);
    ctx.out(
      `${create.length} file(s) would be created · ${covered} source file(s) already tested · nothing written (dry run)`,
    );
  } else {
    ctx.out(
      `${t.green("✓")} ${res.written.length} file(s) created · ${covered} already tested · existing files are never overwritten`,
    );
    if (res.written.length)
      ctx.out(
        t.dim("Scaffolds contain it.todo entries — they show up as todo, never as passing tests."),
      );
  }
  return ExitCode.Success;
}

async function cmdRules(ctx: Ctx): Promise<number> {
  const { t, flags } = ctx;
  const sub = ctx.positionals[0] ?? "list";
  const st = await ctx.open();
  const engine = st.rules();
  if (sub === "list") {
    if (flags.json) ctx.json("rules", { rules: engine.rules });
    else if (!engine.rules.length)
      ctx.out(
        t.dim(
          "No rules configured. Add `rules` to smarttest.config — see documentation/concepts/rules.md",
        ),
      );
    else
      for (const r of engine.rules)
        ctx.out(
          `  ${t.bold(r.name)}  ${t.dim(JSON.stringify(r.match))}${r.risk ? `  risk ${r.risk}` : ""}${r.require ? `  requires ${r.require.join("+")}` : ""}${r.execution?.alwaysRunOnAffected ? "  always-run" : ""}${r.execution?.mode ? `  mode ${r.execution.mode}` : ""}`,
        );
    return ExitCode.Success;
  }
  if (sub === "validate") {
    const issues = engine.validate();
    if (flags.json) ctx.json("rules", { valid: !issues.length, issues });
    else if (!issues.length) ctx.out(`${t.green("✓")} ${engine.rules.length} rule(s) valid`);
    else for (const i of issues) ctx.out(`${t.red("✕")} ${i}`);
    return issues.length ? ExitCode.ConfigurationFailure : ExitCode.Success;
  }
  if (sub === "explain") {
    const target = ctx.positionals[1];
    if (!target)
      throw new SmartTestError("Missing path", {
        code: "ST_USAGE",
        category: "usage",
        hint: "smarttest rules explain <path[#Symbol]>",
      });
    const r = await st.explainRules(target);
    if (flags.json) {
      ctx.json("rules", r);
      return ExitCode.Success;
    }
    ctx.out(t.bold(target));
    ctx.out(
      `  File-level rules: ${r.file.matched.map((m) => `${m.rule.name} (specificity ${m.specificity.toFixed(2)})`).join(", ") || t.dim("none")}`,
    );
    for (const s of r.symbols)
      ctx.out(
        `  ${s.symbol}: ${s.policy.matched.map((m) => `${m.rule.name} (${m.specificity.toFixed(2)})`).join(", ")}`,
      );
    const e = r.effective;
    ctx.out(
      `  Effective: risk ${e.risk}${e.mode ? ` · mode ${e.mode}` : ""}${e.require.length ? ` · requires ${e.require.join("+")}` : ""}${e.alwaysRunOnAffected ? " · always run on affected" : ""}${e.generate?.template ? ` · template ${e.generate.template}` : ""}`,
    );
    for (const c of e.conflicts) ctx.out(`  ${t.red("✕")} ${c}`);
    ctx.out(
      t.dim(
        "  Precedence: specificity, then declaration order. Risk, mode and always-run are never weakened.",
      ),
    );
    return e.conflicts.length ? ExitCode.ConfigurationFailure : ExitCode.Success;
  }
  throw new SmartTestError(`Unknown rules subcommand "${sub}"`, {
    code: "ST_USAGE",
    category: "usage",
    hint: "Use list, validate or explain.",
  });
}

async function cmdSnapshot(ctx: Ctx): Promise<number> {
  const { t, flags } = ctx;
  const sub = ctx.positionals[0] ?? "list";
  const st = await ctx.open();
  const store = st.snapshots();
  switch (sub) {
    case "create": {
      const snap = await store.create({
        storeContent: !!flags.content || st.config.snapshots.storeContent,
        ...(flags.label ? { label: flags.label } : {}),
      });
      if (flags.json)
        ctx.json("snapshot", {
          id: snap.id,
          files: Object.keys(snap.files).length,
          storeContent: snap.storeContent,
        });
      else
        ctx.out(
          `${t.green("✓")} ${snap.id} · ${Object.keys(snap.files).length} files · ${snap.storeContent ? "content stored" : "hashes only"}`,
        );
      return ExitCode.Success;
    }
    case "list": {
      const list = await store.list();
      if (flags.json) ctx.json("snapshot", { snapshots: list });
      else if (!list.length) ctx.out(t.dim("No snapshots yet. `smarttest snapshot create`"));
      else
        for (const s of list)
          ctx.out(
            `  ${s.id}  ${t.dim(s.createdAt)}  ${s.files} files${s.verified ? t.green(`  verified (${s.verified.runId})`) : ""}${s.label ? `  ${s.label}` : ""}`,
          );
      return ExitCode.Success;
    }
    case "inspect": {
      const s = await store.inspect(ctx.positionals[1]);
      if (flags.json) ctx.json("snapshot", s);
      else {
        ctx.out(`${t.bold(s.id)} ${t.dim(s.createdAt)}`);
        ctx.out(
          `  ${Object.keys(s.files).length} files · ${s.storeContent ? "content stored" : "hashes only"}${s.verified ? ` · verified baseline (${s.verified.runId}, ${s.verified.status})` : " · not a verified baseline"}`,
        );
      }
      return ExitCode.Success;
    }
    case "diff": {
      const { changeSet, snapshot } = await store.diff(ctx.positionals[1]);
      if (flags.json) ctx.json("snapshot", { snapshot: snapshot.id, changeSet });
      else {
        ctx.out(
          `${t.bold(snapshot.id)} → working tree · ${changeSet.changes.length} change(s) · ${changeSet.completeness}`,
        );
        for (const c of changeSet.changes)
          ctx.out(
            `  ${t.dim(c.type.padEnd(9))}${c.path}${c.previousPath ? t.dim(` ← ${c.previousPath}`) : ""}`,
          );
        for (const w of changeSet.warnings) ctx.out(`  ${t.yellow("▲")} ${w}`);
      }
      return ExitCode.Success;
    }
    case "prune": {
      const removed = await store.prune({
        keep: intFlag(flags.keep, "keep") ?? st.config.snapshots.keep,
        force: !!flags.force,
        dryRun: !!flags["dry-run"],
      });
      if (flags.json) ctx.json("snapshot", { removed, dryRun: !!flags["dry-run"] });
      else
        ctx.out(
          `${flags["dry-run"] ? "Would remove" : "Removed"} ${removed.length} snapshot(s)${removed.length ? `: ${removed.join(", ")}` : ""}`,
        );
      return ExitCode.Success;
    }
    default:
      throw new SmartTestError(`Unknown snapshot subcommand "${sub}"`, {
        code: "ST_USAGE",
        category: "usage",
        hint: "Use create, list, inspect, diff or prune.",
      });
  }
}

async function cmdVcs(ctx: Ctx): Promise<number> {
  const { t, flags } = ctx;
  const sub = ctx.positionals[0] ?? "status";
  const st = await ctx.open();
  if (sub === "detect" || sub === "status") {
    const provider = await st.provider();
    const profile = await st.profile();
    const data: Record<string, unknown> = {
      provider,
      configured: st.config.vcs.provider,
      unsupported: profile.vcs.unsupported,
      nested: profile.vcs.nested,
    };
    if (provider === "git") data.git = await st.git().getWorkingState();
    else data.latestSnapshot = (await st.snapshots().latest())?.id ?? null;
    if (flags.json) ctx.json("vcs", data);
    else {
      ctx.out(
        `${t.bold("Provider")}  ${provider === "git" ? "Git" : "SmartTest native snapshots"}${st.config.vcs.provider === "auto" ? t.dim(" (auto-detected)") : ""}`,
      );
      if (provider === "git") {
        const g = data.git as {
          root: string;
          head?: { ref: string };
          dirty: boolean;
          warnings: string[];
        };
        ctx.out(
          `  root ${g.root} · ${g.head?.ref ?? "no commits"}${g.dirty ? " · uncommitted changes" : ""}`,
        );
        for (const w of g.warnings) ctx.out(`  ${t.yellow("▲")} ${w}`);
        if (st.config.vcs.snapshots)
          ctx.out(
            t.dim(
              "  hybrid: native snapshots are recorded after passing runs (use --since-snapshot)",
            ),
          );
      } else ctx.out(`  latest snapshot ${data.latestSnapshot ?? t.dim("none")}`);
      for (const n of profile.vcs.nested) ctx.out(`  ${t.yellow("▲")} nested repository: ${n}`);
      for (const u of profile.vcs.unsupported) ctx.out(`  ${t.yellow("▲")} ${u}`);
    }
    return ExitCode.Success;
  }
  if (sub === "connect") {
    const target = ctx.positionals[1];
    if (target !== "git" && target !== "native")
      throw new SmartTestError("Usage: smarttest vcs connect <git|native>", {
        code: "ST_USAGE",
        category: "usage",
      });
    ctx.out(
      `Set the provider explicitly in smarttest.config:\n\n  vcs: { provider: "${target}" }\n`,
    );
    ctx.out(
      t.dim(
        "SmartTest never treats snapshot ids and Git commits as equivalent; the first run after switching establishes a new baseline.",
      ),
    );
    return ExitCode.Success;
  }
  throw new SmartTestError(`Unknown vcs subcommand "${sub}"`, {
    code: "ST_USAGE",
    category: "usage",
    hint: "Use detect, status or connect.",
  });
}

async function cmdBenchmark(ctx: Ctx): Promise<number> {
  const { t, flags } = ctx;
  const st = await ctx.open();
  const { benchmarkHistory, benchmarkMarkdown } = await import("@smarttest/core");
  const mode = modeOf(flags);
  const commits = intFlag(flags.commits, "commits") ?? 10;
  const sample = intFlag(flags.sample, "sample");
  const jsonPath = join(st.storeDir, "reports", "benchmark.json");
  let previous: CommitBenchmark[] | undefined;
  if (flags.resume) {
    const { readFile } = await import("node:fs/promises");
    const prior = await readFile(jsonPath, "utf8").then(
      (x) => JSON.parse(x) as { mode?: string; commits?: CommitBenchmark[] },
      () => undefined,
    );
    if (prior?.commits && (!mode || prior.mode === mode)) previous = prior.commits;
  }
  const b = await benchmarkHistory(st, {
    commits,
    ...(mode ? { mode } : {}),
    ...(flags.since ? { since: flags.since } : {}),
    ...(sample ? { sample } : {}),
    ...(previous ? { previous } : {}),
    ...(flags.traces ? { traces: true } : {}),
    ...(flags["no-cache"] ? { cache: false } : {}),
    onCommit: async (results) => {
      await writeFileAtomic(
        jsonPath,
        `${JSON.stringify({ mode: mode ?? st.config.mode, partial: true, commits: results }, null, 2)}\n`,
      );
    },
    onProgress: (m) => {
      if (!flags.json && !flags.quiet) ctx.err(t.dim(m));
    },
  });
  const md = benchmarkMarkdown(b);
  const reportPath = join(st.storeDir, "reports", "benchmark.md");
  await writeFileAtomic(reportPath, md);
  await writeFileAtomic(
    join(st.storeDir, "reports", "benchmark.json"),
    `${JSON.stringify(b, null, 2)}\n`,
  );
  if (flags.output) await writeFileAtomic(join(ctx.root, flags.output), md);
  if (flags.json) ctx.json("benchmark", b);
  else {
    const s = (ms: number) => formatDuration(ms);
    const tt = b.totals;
    ctx.out();
    ctx.out(`${t.bold("History benchmark")} · ${tt.commits} commits · mode ${t.violet(b.mode)}`);
    ctx.out(`  ${pad("Full run", 16)}${s(tt.fullMs)}`);
    ctx.out(
      `  ${pad("Project-gated", 16)}${s(tt.projectGatedMs)}  ${t.dim("(suites of the projects each commit touched)")}`,
    );
    ctx.out(
      `  ${pad("SmartTest", 16)}${t.bold(s(tt.smarttestMs))}  ${t.dim(`(${tt.selectedTests}/${tt.totalTests} test files, analysis included)`)}`,
    );
    ctx.out(
      `  ${pad("Saved", 16)}${tt.savedVsFullPct}% vs full · ${tt.savedVsGatedPct}% vs project-gated`,
    );
    ctx.out(
      `  ${pad("Missed failures", 16)}${tt.missed ? t.red(String(tt.missed)) : t.green("0")}${tt.preexisting ? t.dim(` · ${tt.preexisting} already failing in the parent commit`) : ""}`,
    );
    if (tt.cachedTests)
      ctx.out(
        `  ${pad("Cached results", 16)}${tt.cachedTests} · integrity violations ${tt.cacheViolations ? t.red(String(tt.cacheViolations)) : t.green("0")}`,
      );
    ctx.out(`  ${t.dim("Report")} ${rel(ctx, reportPath)}`);
  }
  return b.totals.missed || b.totals.cacheViolations ? ExitCode.PolicyFailure : ExitCode.Success;
}

async function cmdGraph(ctx: Ctx): Promise<number> {
  const { t, flags } = ctx;
  const st = await ctx.open();
  const sub = ctx.positionals[0];
  if (sub === "why" || sub === "cycles" || sub === "orphans") {
    const { graph, tests } = await st.graphInsights();
    if (sub === "why") {
      const [from, to] = ctx.positionals.slice(1);
      if (!from || !to)
        throw new SmartTestError("Usage: smarttest graph why <from file[#Symbol]> <to file>", {
          code: "ST_USAGE",
          category: "usage",
        });
      const path = graph.why(from, to);
      if (flags.json) ctx.json("graph", { why: { from, to, path: path ?? null } });
      else if (!path) ctx.out(`${to} does not depend on ${from} (statically).`);
      else for (const [i, p] of path.entries()) ctx.out(`${i === 0 ? " " : "→"} ${p}`);
      return ExitCode.Success;
    }
    if (sub === "cycles") {
      const cycles = graph.cycles();
      if (flags.json) ctx.json("graph", { cycles });
      else if (!cycles.length) ctx.out("No import cycles.");
      else for (const c of cycles) ctx.out(`${t.yellow("cycle")} (${c.length}) ${c.join(" ↔ ")}`);
      return ExitCode.Success;
    }
    const orphans = graph.orphans(tests);
    if (flags.json) ctx.json("graph", { orphans });
    else {
      ctx.out(`${orphans.length} source file(s) not reached by any test:`);
      for (const o of orphans.slice(0, flags.verbose ? undefined : 40)) ctx.out(`  ${o}`);
      if (!flags.verbose && orphans.length > 40)
        ctx.out(t.dim(`  … ${orphans.length - 40} more (--verbose)`));
    }
    return ExitCode.Success;
  }
  const direction = (flags.direction ?? "dependents") as "dependents" | "dependencies";
  if (!["dependents", "dependencies"].includes(direction))
    throw new SmartTestError("--direction must be dependents or dependencies", {
      code: "ST_USAGE",
      category: "usage",
    });
  const depth = intFlag(flags.depth, "depth");
  const q = await st.graphQuery({
    ...(flags.from ? { from: flags.from } : {}),
    direction,
    ...(depth !== undefined ? { depth } : {}),
  });
  const format = flags.format?.[0];
  if (format === "dot" || format === "json" || (!flags.from && !flags.json)) {
    const content =
      format === "dot"
        ? q.graph.toDot()
        : JSON.stringify({ schemaVersion: 1, ...q.graph.toGraph() }, null, 2);
    if (flags.output) {
      await writeFileAtomic(flags.output, content);
      ctx.out(`${t.green("✓")} wrote ${flags.output}`);
    } else ctx.out(content);
    return ExitCode.Success;
  }
  if (flags.json) {
    ctx.json("graph", {
      stats: q.stats,
      results: q.results,
      tests: "tests" in q ? q.tests : undefined,
    });
    return ExitCode.Success;
  }
  ctx.out(`${t.bold(flags.from ?? "")} · ${direction}`);
  const testSet = new Set("tests" in q && q.tests ? q.tests.map((x) => x.test) : []);
  for (const r of q.results ?? []) if (!testSet.has(r)) ctx.out(`  ${r}`);
  if ("tests" in q && q.tests)
    for (const h of q.tests) ctx.out(`  ${t.green("■")} ${h.test}  ${t.dim(h.path.join(" → "))}`);
  return ExitCode.Success;
}

async function cmdCoverage(ctx: Ctx): Promise<number> {
  const { t, flags } = ctx;
  const st = await ctx.open();
  const c = await st.coverage();
  if (flags.json) {
    ctx.json("coverage", c ?? null);
    return ExitCode.Success;
  }
  if (!c) {
    ctx.out(
      t.dim(
        "No coverage recorded yet. Run `smarttest run --all --coverage` (full) or `smarttest run --coverage` (selected).",
      ),
    );
    return ExitCode.Success;
  }
  ctx.out(
    `${t.bold("Coverage")} · ${c.scope === "full" ? "full suite" : t.yellow("selected tests only — not project coverage")} · ${c.collectedAt} · ${c.runId}`,
  );
  ctx.out(
    `  lines ${c.total.lines.pct}% · statements ${c.total.statements.pct}% · functions ${c.total.functions.pct}% · branches ${c.total.branches.pct}%`,
  );
  const worst = Object.entries(c.files)
    .sort(([, a], [, b]) => a.lines.pct - b.lines.pct)
    .slice(0, flags.verbose ? 1000 : 10);
  for (const [file, m] of worst)
    ctx.out(
      `  ${pad(file, 50)}${m.lines.pct < 50 ? t.red(`${m.lines.pct}%`) : m.lines.pct < 80 ? t.yellow(`${m.lines.pct}%`) : t.green(`${m.lines.pct}%`)}`,
    );
  return ExitCode.Success;
}

async function cmdReport(ctx: Ctx): Promise<number> {
  const { t, flags } = ctx;
  const st = await ctx.open();
  const formats = (flags.format ?? ["html"]) as ("html" | "json" | "junit" | "markdown")[];
  const written = await st.rerenderReports(formats, flags.output);
  if (flags.json) ctx.json("report", { written });
  else
    for (const [k, v] of Object.entries(written))
      ctx.out(`${t.green("✓")} ${k.padEnd(9)}${rel(ctx, v)}`);
  if (flags.open && written.html) openFile(written.html);
  return ExitCode.Success;
}

function openFile(path: string): void {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", path] : [path];
  try {
    spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
  } catch {
    /* best effort */
  }
}

// ── root menu ─────────────────────────────────────────────────────────────────────────────

async function rootMenu(ctx: Ctx): Promise<number> {
  const { t } = ctx;
  const st = await ctx.open();
  const profile = await st.profile();
  ctx.out(`${t.bold(t.cyan("SMARTTEST"))} ${t.dim(VERSION)}`);
  ctx.out(
    `${t.dim("Workspace:")} ${profile.name}   ${t.dim("Status:")} ${st.loaded.path ? t.green("Ready") : t.yellow("Not initialised")}`,
  );
  ctx.out();
  const choice = await select(ctx.io, t, "What do you want to do?", [
    { value: "run", label: "Run affected tests" },
    { value: "impact", label: "Show impact (no execution)" },
    { value: "explain", label: "Explain a test or file" },
    { value: "generate", label: "Generate test architecture", hint: "preview first" },
    { value: "report", label: "Coverage and reports" },
    { value: "doctor", label: "Project diagnostics" },
    { value: "init", label: st.loaded.path ? "Settings (re-run init)" : "Initialise SmartTest" },
  ]);
  ctx.out();
  switch (choice) {
    case "explain": {
      const target = await prompt(ctx.io, t, "Test or file path:");
      return main(["explain", target], ctx.io, ctx.root);
    }
    case "generate":
      return main(["generate", "--dry-run"], ctx.io, ctx.root);
    case "report": {
      await main(["coverage"], ctx.io, ctx.root);
      return main(["report", "--open"], ctx.io, ctx.root);
    }
    default:
      return main([choice], ctx.io, ctx.root);
  }
}

async function cmdStudio(ctx: Ctx): Promise<number> {
  const port = intFlag(ctx.flags.port, "port");
  if (port !== undefined && (port < 0 || port > 65535))
    throw new SmartTestError("--port must be between 0 and 65535", {
      code: "ST_USAGE",
      category: "usage",
    });
  const { startStudio } = await import("@smarttest/studio");
  const server = await startStudio({
    root: ctx.root,
    ...(ctx.flags.config ? { configPath: ctx.flags.config } : {}),
    ...(port !== undefined ? { port } : {}),
  });
  if (ctx.flags.json) ctx.json("studio", { url: server.url });
  else ctx.out(`SmartTest Studio: ${server.url}\nLocal session. Press Ctrl+C to stop.`);
  if (ctx.flags.open) openFile(server.url);
  await new Promise<void>((resolve) => {
    const stop = () => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      void server.close().finally(resolve);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  return ExitCode.Success;
}

// ── dispatcher ────────────────────────────────────────────────────────────────────────────

const HANDLERS: Record<string, (ctx: Ctx) => Promise<number>> = {
  run: cmdRun,
  studio: cmdStudio,
  open: cmdStudio,
  impact: cmdImpact,
  explain: cmdExplain,
  "validate-selection": cmdValidate,
  scan: cmdScan,
  doctor: cmdDoctor,
  init: cmdInit,
  uninstall: cmdUninstall,
  generate: cmdGenerate,
  rules: cmdRules,
  snapshot: cmdSnapshot,
  vcs: cmdVcs,
  graph: cmdGraph,
  benchmark: cmdBenchmark,
  trace: cmdTrace,
  hook: cmdHook,
  sync: cmdSync,
  migrate: cmdMigrate,
  watch: cmdWatch,
  shard: cmdShard,
  flaky: cmdFlaky,
  ci: cmdCi,
  shadow: cmdShadow,
  coverage: cmdCoverage,
  report: cmdReport,
};

const LATER: Record<string, string> = {
  ai: "AI features are planned after 1.0.0. SmartTest never requires them.",
  autopilot: "Autopilot is planned after 1.0.0.",
};

export async function main(
  argv: readonly string[],
  io: IO = { stdout: process.stdout, stderr: process.stderr, stdin: process.stdin },
  cwd = process.cwd(),
): Promise<number> {
  let t = theme(colorEnabled(io));
  let jsonMode = argv.includes("--json");
  try {
    const parsed = parse(argv);
    const { flags } = parsed;
    jsonMode = !!flags.json;
    if (jsonMode) t = theme(false);
    if (flags.version) {
      io.stdout.write(`${VERSION}\n`);
      return ExitCode.Success;
    }
    const command = parsed.command;
    const positionals = parsed.positionals;
    if (command === "help") {
      const topic = positionals[0];
      io.stdout.write(`${(topic && commandHelp(topic)) ?? rootHelp(VERSION)}\n`);
      return ExitCode.Success;
    }
    if (flags.help) {
      io.stdout.write(`${(command && commandHelp(command)) ?? rootHelp(VERSION)}\n`);
      return ExitCode.Success;
    }
    const interactive =
      !flags["non-interactive"] &&
      !flags.hook &&
      !!(io.stdin ?? process.stdin).isTTY &&
      !!io.stdout.isTTY &&
      !process.env.CI;
    if (command && LATER[command]) {
      throw new SmartTestError(LATER[command] as string, {
        code: "ST_NOT_AVAILABLE",
        category: "usage",
      });
    }
    if (command && !HANDLERS[command]) {
      const { suggest } = await import("@smarttest/shared");
      const guess = suggest(command, Object.keys(COMMANDS));
      throw new SmartTestError(`Unknown command "${command}"`, {
        code: "ST_USAGE",
        category: "usage",
        hint: guess ? `Did you mean \`smarttest ${guess}\`?` : "Run `smarttest --help`.",
      });
    }
    const root = cwd;
    let opened: SmartTest | undefined;
    const ctx: Ctx = {
      io,
      t,
      flags,
      positionals,
      root,
      interactive,
      out: (line = "") => {
        if (!jsonMode) io.stdout.write(`${line}\n`);
      },
      err: (line = "") => io.stderr.write(`${line}\n`),
      json: (cmd, data) =>
        io.stdout.write(
          `${JSON.stringify({ schemaVersion: 1, command: cmd, ...((data && typeof data === "object" && !Array.isArray(data) ? data : { data }) as object) }, null, 2)}\n`,
        ),
      open: async () => {
        if (!opened) {
          const { SmartTest } = await import("@smarttest/core");
          opened = await SmartTest.open({
            root,
            ...(flags.config ? { configPath: flags.config } : {}),
          });
          opened.useLogger(
            createLogger({
              level: flags.verbose ? "debug" : "info",
              scope: command ?? "menu",
              sinks: [
                fileSink(join(opened.storeDir, "logs", "smarttest.log")),
                ...(flags.verbose && !jsonMode
                  ? [
                      (_r: unknown, formatted: string) =>
                        void io.stderr.write(`${t.dim(formatted)}\n`),
                    ]
                  : []),
              ],
            }),
          );
        }
        if (!jsonMode && !flags.quiet)
          for (const w of opened.loaded.warnings)
            io.stderr.write(`${t.yellow("▲")} config ${w.path}: ${w.message}\n`);
        return opened;
      },
    };
    if (!command) {
      if (!interactive) {
        io.stdout.write(`${rootHelp(VERSION)}\n`);
        return ExitCode.Success;
      }
      return await rootMenu(ctx);
    }
    if (command === "run" && !flags.all) flags.affected = true;
    void positionals;
    return await (HANDLERS[command] as (c: Ctx) => Promise<number>)(ctx);
  } catch (error) {
    const code = toExitCode(error);
    if (jsonMode) {
      const e = error as SmartTestError;
      io.stdout.write(
        `${JSON.stringify({ schemaVersion: 1, error: { code: e.code ?? "ST_INTERNAL", category: e.category ?? "internal", message: e.message, hint: e.hint } }, null, 2)}\n`,
      );
    } else if (error instanceof SmartTestError) {
      io.stderr.write(`${t.red("✕")} ${t.bold(error.code)}  ${error.message}\n`);
      if (error.hint) io.stderr.write(`  ${t.dim("hint:")} ${error.hint}\n`);
      if (argv.includes("--verbose") && error.cause)
        io.stderr.write(`  ${t.dim(String((error.cause as Error).stack ?? error.cause))}\n`);
    } else {
      io.stderr.write(`${t.red("✕")} ${t.bold("ST_INTERNAL")}  ${(error as Error).message}\n`);
      if (argv.includes("--verbose")) io.stderr.write(`${(error as Error).stack}\n`);
      io.stderr.write(
        `  ${t.dim("This is a SmartTest bug. Please report it with the output of `smarttest doctor --json`.")}\n`,
      );
    }
    return code;
  }
}
