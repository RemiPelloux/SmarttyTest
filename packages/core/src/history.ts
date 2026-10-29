/**
 * History benchmark (`smarttest benchmark`): replays recent commits in a temporary worktree and
 * compares, per commit, a full run, a project-gated run (suites of the projects a commit touched)
 * and SmartTest's selection — with every missed failure checked against the parent commit.
 */
import { lstat, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { exists, runProcess, type SafetyMode, SmartTestError } from "@smarttest/shared";
import type { RunnerRoot } from "@smarttest/test-discovery";
import { type ExecutionSummary, executeGroups } from "@smarttest/test-executor";
import { planExecution } from "@smarttest/test-selector";
import type { SmartTest } from "./smarttest.js";

export interface CommitBenchmark {
  sha: string;
  subject: string;
  changedFiles: number;
  totalTests: number;
  selectedTests: number;
  fallback: boolean;
  analysisStatus: string;
  fullMs: number;
  projectGatedMs: number;
  projectGatedTests: number;
  smarttestMs: number;
  analysisMs: number;
  failingInFull: string[];
  missed: string[];
  preexisting: string[];
  /** Tests ruled out by fresh traces (only with `traces`). */
  observedSkips?: number;
}

export interface HistoryBenchmark {
  project: string;
  mode: SafetyMode;
  commits: CommitBenchmark[];
  totals: {
    commits: number;
    fullMs: number;
    projectGatedMs: number;
    smarttestMs: number;
    savedVsFullPct: number;
    savedVsGatedPct: number;
    selectedTests: number;
    totalTests: number;
    missed: number;
    preexisting: number;
  };
}

export interface BenchmarkOptions {
  commits: number;
  /** Replay every first-parent commit after this ref instead of the last `commits`. */
  since?: string;
  /** Replay at most this many commits, evenly spaced. */
  sample?: number;
  /** Results of an earlier (possibly interrupted) run; commits already measured are not re-run. */
  previous?: readonly CommitBenchmark[];
  /** Called after each commit with the results so far (for resuming). */
  onCommit?: (results: readonly CommitBenchmark[]) => Promise<void> | void;
  /** Collect traces at each parent commit so selection can use observed execution. */
  traces?: boolean;
  mode?: SafetyMode;
  configPath?: string;
  onProgress?: (message: string) => void;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const res = await runProcess("git", ["-c", "core.quotePath=false", ...args], { cwd });
  if (res.code !== 0)
    throw new SmartTestError(`git ${args.join(" ")} failed: ${res.stderr.trim()}`, {
      code: "ST_GIT_FAILED",
      category: "infrastructure",
    });
  return res.stdout;
}

const wall = async <T>(fn: () => Promise<T>): Promise<[T, number]> => {
  const t = performance.now();
  const r = await fn();
  return [r, performance.now() - t];
};

const failing = (s: ExecutionSummary) =>
  s.files.filter((f) => f.status === "failed" || f.status === "timed-out").map((f) => f.file);

export async function benchmarkHistory(
  st: SmartTest,
  options: BenchmarkOptions,
): Promise<HistoryBenchmark> {
  const gitAdapter = st.git();
  if (!(await gitAdapter.detect())) {
    throw new SmartTestError(
      "benchmark replays Git history — this project is not a Git repository",
      { code: "ST_NOT_GIT", category: "usage" },
    );
  }
  const repoRoot = await gitAdapter.root();
  const prefix = await gitAdapter.prefix();
  const log = await git(repoRoot, [
    "log",
    "--no-merges",
    "--first-parent",
    ...(options.since ? [] : [`-n${options.commits}`]),
    "--format=%H%x09%s",
    options.since ? `${options.since}..HEAD` : "HEAD",
  ]);
  let commits = log
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [sha, ...rest] = l.split("\t");
      return { sha: sha as string, subject: rest.join("\t") };
    })
    .reverse();
  if (options.sample && commits.length > options.sample) {
    const step = commits.length / options.sample;
    const all = commits;
    commits = Array.from(
      { length: options.sample },
      (_, i) => all[Math.floor(i * step)] as (typeof all)[number],
    );
  }
  const done = new Map((options.previous ?? []).map((r) => [r.sha, r]));
  const configPath = options.configPath ?? st.loaded.path;
  const tmp = await mkdtemp(join(tmpdir(), "smarttest-benchmark-"));
  const wt = join(tmp, "repo");
  const progress = options.onProgress ?? (() => undefined);
  await git(repoRoot, ["worktree", "add", "--detach", "-q", wt, "HEAD"]);
  try {
    // Reuse installed dependencies: link every node_modules of the project into the worktree.
    const profile = await st.profile();
    const dirs = ["", ...profile.workspaces.map((w) => w.dir)];
    for (const d of dirs) {
      const src = join(st.root, d, "node_modules");
      const dest = join(wt, prefix, d, "node_modules");
      if (
        (await exists(src)) &&
        !(await lstat(dest).catch(() => undefined)) &&
        (await exists(dirname(dest)))
      ) {
        await symlink(src, dest, process.platform === "win32" ? "junction" : "dir");
      }
    }
    const projectRoot = join(wt, prefix);
    const results: CommitBenchmark[] = [];
    const { SmartTest: Engine } = await import("./smarttest.js");
    for (const [i, c] of commits.entries()) {
      const prior = done.get(c.sha);
      if (prior) {
        results.push(prior);
        progress(`[${i + 1}/${commits.length}] ${c.sha.slice(0, 8)} (resumed)`);
        continue;
      }
      progress(`[${i + 1}/${commits.length}] ${c.sha.slice(0, 8)} ${c.subject.slice(0, 60)}`);
      if (options.traces) {
        await git(wt, ["checkout", "-q", "--detach", "--force", `${c.sha}^`]);
        const parentEngine = await Engine.open({
          root: projectRoot,
          ...(configPath ? { configPath } : {}),
        });
        const tr = await parentEngine.collectTraces({}).catch(() => undefined);
        progress(`  traced ${tr?.traced ?? 0} test file(s) at the parent`);
      }
      await git(wt, ["checkout", "-q", "--detach", "--force", c.sha]);
      const engine = await Engine.open({
        root: projectRoot,
        ...(configPath ? { configPath } : {}),
      });
      let analysis: Awaited<ReturnType<SmartTest["analyze"]>>;
      try {
        [analysis] = await wall(() =>
          engine.analyze({
            source: { kind: "base", ref: `${c.sha}^`, direct: true, target: c.sha },
            ...(options.mode ? { mode: options.mode } : {}),
          }),
        );
      } catch (error) {
        progress(`  skipped: ${(error as Error).message.split("\n")[0]}`);
        continue;
      }
      const analysisMs = Object.values(analysis.timings).reduce((a, b) => a + b, 0);
      const create = (g: Parameters<SmartTest["createAdapterFor"]>[0]) =>
        engine.createAdapterFor(g);
      const fullPlan = planExecution(
        analysis.testFiles,
        analysis.runnerRoots,
        engine.config.adapters,
        analysis.assignment,
      );
      // Full run, timing each runner group (for the project-gated baseline).
      const groupMs = new Map<string, number>();
      let groupStart = 0;
      const [full, fullMs] = await wall(() =>
        executeGroups(fullPlan.groups, {
          createAdapter: create,
          timeoutMs: engine.config.timeoutMs,
          onEvent: (e) => {
            if (e.type === "group-start") groupStart = performance.now();
            if (e.type === "group-end")
              groupMs.set(`${e.group.adapter}:${e.group.dir}`, performance.now() - groupStart);
          },
        }),
      );
      const selected = analysis.decision.selectedTests.map((t) => t.filePath);
      const selectedPlan = planExecution(
        selected,
        analysis.runnerRoots,
        engine.config.adapters,
        analysis.assignment,
      );
      const [, selectedMs] = await wall(() =>
        executeGroups(selectedPlan.groups, {
          createAdapter: create,
          timeoutMs: engine.config.timeoutMs,
        }),
      );
      // Project-gated baseline: every suite whose runner root contains a changed file.
      const changed = analysis.input.changeSet.changes.flatMap((ch) =>
        [ch.path, ch.previousPath].filter((p): p is string => !!p),
      );
      const touched = analysis.runnerRoots.filter((r: RunnerRoot) =>
        changed.some((p) => r.dir === "" || p.startsWith(`${r.dir}/`)),
      );
      const projectGatedMs = touched.reduce(
        (a, r) => a + (groupMs.get(`${r.adapter}:${r.dir}`) ?? 0),
        0,
      );
      const projectGatedTests = analysis.testFiles.filter((t) =>
        touched.some((r) => analysis.assignment.get(t) === r),
      ).length;
      // Classify failures the selection did not include: regression missed, or already failing?
      const failingFull = failing(full);
      const notSelected = failingFull.filter((f) => !selected.includes(f));
      const preexisting: string[] = [];
      const missed: string[] = [];
      if (notSelected.length) {
        await git(wt, ["checkout", "-q", "--detach", "--force", `${c.sha}^`]);
        const parentPlan = planExecution(
          notSelected,
          analysis.runnerRoots,
          engine.config.adapters,
          analysis.assignment,
        );
        const parent = await executeGroups(parentPlan.groups, {
          createAdapter: create,
          timeoutMs: engine.config.timeoutMs,
        });
        const failingBefore = new Set(failing(parent));
        for (const f of notSelected) (failingBefore.has(f) ? preexisting : missed).push(f);
      }
      results.push({
        sha: c.sha,
        subject: c.subject,
        changedFiles: analysis.input.changeSet.changes.length,
        totalTests: analysis.testFiles.length,
        selectedTests: selected.length,
        fallback: analysis.decision.fallbackApplied,
        analysisStatus: analysis.decision.analysisStatus,
        fullMs,
        projectGatedMs,
        projectGatedTests,
        smarttestMs: selectedMs + analysisMs,
        analysisMs,
        failingInFull: failingFull,
        missed,
        preexisting,
        ...(analysis.decision.details.observedSkips
          ? { observedSkips: analysis.decision.details.observedSkips.length }
          : {}),
      });
      await options.onCommit?.(results);
      const last = results.at(-1) as CommitBenchmark;
      progress(
        `  ${last.selectedTests}/${last.totalTests} tests · full ${Math.round(fullMs)} ms · gated ${Math.round(projectGatedMs)} ms · smarttest ${Math.round(last.smarttestMs)} ms${missed.length ? ` · MISSED ${missed.length}` : ""}`,
      );
    }
    const sum = (k: keyof CommitBenchmark) => results.reduce((a, r) => a + (r[k] as number), 0);
    const fullMs = sum("fullMs");
    const gated = sum("projectGatedMs");
    const smart = sum("smarttestMs");
    return {
      project: profile.name,
      mode: options.mode ?? st.config.mode,
      commits: results,
      totals: {
        commits: results.length,
        fullMs,
        projectGatedMs: gated,
        smarttestMs: smart,
        savedVsFullPct: fullMs ? Math.round(((fullMs - smart) / fullMs) * 100) : 0,
        savedVsGatedPct: gated ? Math.round(((gated - smart) / gated) * 100) : 0,
        selectedTests: sum("selectedTests"),
        totalTests: sum("totalTests"),
        missed: results.reduce((a, r) => a + r.missed.length, 0),
        preexisting: results.reduce((a, r) => a + r.preexisting.length, 0),
      },
    };
  } finally {
    await git(repoRoot, ["worktree", "remove", "--force", wt]).catch(() => undefined);
    await rm(tmp, { recursive: true, force: true });
  }
}

export function benchmarkMarkdown(b: HistoryBenchmark): string {
  const s = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);
  const t = b.totals;
  const lines = [
    `# SmartTest history benchmark — ${b.project}`,
    "",
    `Mode \`${b.mode}\` · ${t.commits} commits replayed. Each commit: full run vs project-gated run (suites of touched projects) vs SmartTest (selected tests + analysis).`,
    "",
    "| | Full run | Project-gated | SmartTest |",
    "|---|---|---|---|",
    `| Total time | ${s(t.fullMs)} | ${s(t.projectGatedMs)} | **${s(t.smarttestMs)}** |`,
    `| Saved by SmartTest | ${t.savedVsFullPct}% | ${t.savedVsGatedPct}% | — |`,
    `| Tests run | ${t.totalTests} | — | ${t.selectedTests} |`,
    "",
    `**Missed failures: ${t.missed}** · failures already present in the parent commit: ${t.preexisting}`,
    "",
    "| Commit | Changed | Selected | Full | Gated | SmartTest | Missed |",
    "|---|---|---|---|---|---|---|",
    ...b.commits.map(
      (c) =>
        `| \`${c.sha.slice(0, 8)}\` ${c.subject.slice(0, 50).replace(/\|/g, "\\|")} | ${c.changedFiles} | ${c.selectedTests}/${c.totalTests}${c.fallback ? " (fallback)" : ""} | ${s(c.fullMs)} | ${s(c.projectGatedMs)} | ${s(c.smarttestMs)} | ${c.missed.length ? `❌ ${c.missed.join(", ")}` : "0"} |`,
    ),
    "",
    "Times are wall-clock on this machine. SmartTest time includes its analysis overhead.",
    "",
  ];
  return lines.join("\n");
}
