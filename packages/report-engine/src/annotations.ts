/**
 * CI annotations: the selection shown where a pull request is reviewed. Output formats only: the
 * job log (GitHub workflow commands, a GitLab log section), a Markdown step summary and report
 * files the pipeline publishes (GitLab Code Quality, Bitbucket Code Insights). Nothing here calls
 * a CI API (ADR-0004); posting a Bitbucket report is the pipeline's own step.
 *
 * Honest by construction: a skipped test is "not run", never passed; time saved is an estimate
 * from recorded durations, and "not measured" when there are none.
 */
import type { ImpactDecision, SelectionReason, TestStatus } from "@smarttest/shared";
import { formatDuration, sha256 } from "@smarttest/shared";
import type { FileExecution } from "./index.js";

export type AnnotationProvider = "github" | "gitlab" | "bitbucket";

export const ANNOTATION_PROVIDERS: readonly AnnotationProvider[] = [
  "github",
  "gitlab",
  "bitbucket",
];

/**
 * GitHub shows at most 10 annotations of each level (notice, warning, error) per step; the rest
 * are dropped silently. Each level is kept within it, the last slot summarising what is left.
 */
export const GITHUB_ANNOTATIONS_PER_LEVEL = 10;
/** GitLab Code Quality entries and Bitbucket annotations kept (Bitbucket accepts 100 per call). */
export const REPORT_ANNOTATION_LIMIT = 100;

export interface SelectionEstimate {
  skippedTestTimeMs: number;
  knownSkipped: number;
  totalSkipped: number;
}

export interface AnnotationInput {
  /** `run` (tests ran) or `impact` (selection only, nothing ran). */
  command: "run" | "impact";
  decision: ImpactDecision;
  /** The change compared ("changes since origin/main"). */
  description: string;
  /** Results of the selected test files (`run` only). */
  executions?: readonly FileExecution[];
  estimate?: SelectionEstimate;
  /**
   * Prefix that turns a project-relative path into a repository-relative one ("" or "apps/web/"):
   * annotations point at files of the repository the CI checked out.
   */
  pathPrefix?: string;
}

export interface CiAnnotations {
  provider: AnnotationProvider;
  /** Lines for the job log (stdout). */
  log: string[];
  /** Markdown for the step summary (GitHub `$GITHUB_STEP_SUMMARY`). */
  summary: string;
  /** Report files to write in the reports directory: name → content. */
  files: Record<string, string>;
  /** Counts actually emitted, for tests and for the user. */
  counts: { notices: number; warnings: number; errors: number; reportEntries: number };
}

const FAILING = new Set<TestStatus>(["failed", "timed-out", "infrastructure-error", "cancelled"]);

const reasonOf = (r: readonly { message: string }[]) =>
  r.map((x) => x.message).join("; ") || "selected";

/** Skipped test files grouped by their first reason, largest group first. */
export function skippedReasons(decision: ImpactDecision): { reason: string; count: number }[] {
  const groups = new Map<string, number>();
  for (const s of decision.skippedTests) {
    const r = s.reasons[0] ?? "not selected";
    groups.set(r, (groups.get(r) ?? 0) + 1);
  }
  return [...groups]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}

/** "≈ 4m 10s of test time not run", or why it is not known. */
export function timeSavedText(decision: ImpactDecision, estimate?: SelectionEstimate): string {
  const skipped = decision.skippedTests.length;
  if (!skipped) return "no test time saved: every test file was selected";
  if (!estimate?.knownSkipped)
    return "time saved not measured yet: no recorded duration for the files not run (keep `.smarttest/state/` between pipelines to measure it)";
  return `≈ ${formatDuration(estimate.skippedTestTimeMs)} of test time not run (estimate from previous runs of ${estimate.knownSkipped}/${estimate.totalSkipped} files not run)`;
}

// ── GitHub ────────────────────────────────────────────────────────────────────────────────────

const ghData = (s: string) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const ghProp = (s: string) => ghData(s).replace(/:/g, "%3A").replace(/,/g, "%2C");

function ghCommand(
  level: "notice" | "warning" | "error",
  message: string,
  props: { file?: string; title?: string } = {},
): string {
  const p = [
    ...(props.file ? [`file=${ghProp(props.file)}`] : []),
    ...(props.title ? [`title=${ghProp(props.title)}`] : []),
  ];
  return `::${level}${p.length ? ` ${p.join(",")}` : ""}::${ghData(message.slice(0, 4000))}`;
}

/**
 * Keeps `items` within `limit` lines: when they do not fit, the last line summarises the rest.
 */
function bounded<T>(
  items: readonly T[],
  limit: number,
  one: (item: T) => string,
  rest: (count: number) => string,
): string[] {
  if (limit <= 0) return [];
  if (items.length <= limit) return items.map(one);
  return [...items.slice(0, limit - 1).map(one), rest(items.length - (limit - 1))];
}

function failingExecutions(input: AnnotationInput): FileExecution[] {
  return (input.executions ?? []).filter((e) => FAILING.has(e.status));
}

function failureMessage(e: FileExecution): string {
  const t = e.tests.find((x) => FAILING.has(x.status));
  const name = t ? t.testId.slice(t.testId.indexOf("::") + 2) : undefined;
  const msg = (t?.error?.message ?? e.error ?? "").split("\n").slice(0, 6).join("\n");
  return `${e.status}${name ? `: ${name}` : ""}${msg ? `\n${msg}` : ""}`;
}

function warningsOf(decision: ImpactDecision): string[] {
  const out = [...decision.warnings];
  if (decision.fallbackApplied)
    out.unshift(
      `Fallback applied: ${decision.reasons.find((r) => r.kind === "fallback" || r.kind === "mandatory-trigger")?.message ?? "full suite"}`,
    );
  return out;
}

const CLOSENESS: Record<string, number> = {
  "test-file-changed": 0,
  "modified-symbol": 1,
  "rule-match": 2,
  "mandatory-trigger": 3,
  "direct-dependency": 4,
  "observed-execution": 5,
  "transitive-dependency": 6,
  uncertainty: 7,
  fallback: 8,
};
const closeness = (reasons: readonly SelectionReason[]) =>
  Math.min(9, ...reasons.map((r) => CLOSENESS[r.kind] ?? 9));

function github(input: AnnotationInput, limit: number): CiAnnotations {
  const { decision } = input;
  const at = (f: string) => `${input.pathPrefix ?? ""}${f}`;
  // The closest reasons first: with more files than annotations, the ones shown are the changed
  // tests and the direct dependents, not whatever came first alphabetically.
  const selected = [...decision.selectedTests].sort(
    (a, b) => closeness(a.reasons) - closeness(b.reasons),
  );
  const skipped = decision.skippedTests.length;
  const notRun = input.command === "impact" ? " (selection only, not run here)" : "";
  // One notice for the files not run, the others for the selected files.
  const skippedNotice = skipped
    ? [
        ghCommand(
          "notice",
          `${skipped} test file${skipped === 1 ? "" : "s"} not run: ${skippedReasons(decision)
            .slice(0, 5)
            .map((g) => `${g.count} ${g.reason}`)
            .join("; ")}. ${timeSavedText(decision, input.estimate)}.`,
          { title: `SmartTest: ${skipped} not run (skipped by selection)` },
        ),
      ]
    : [];
  const notices = [
    ...bounded(
      selected,
      limit - skippedNotice.length,
      (s) =>
        ghCommand("notice", reasonOf(s.reasons), {
          file: at(s.filePath),
          title: `SmartTest: selected${notRun}`,
        }),
      (n) =>
        ghCommand(
          "notice",
          `${n} more selected test file${n === 1 ? "" : "s"}; every file and its reason is in the step summary.`,
          { title: `SmartTest: ${n} more selected` },
        ),
    ),
    ...skippedNotice,
  ];
  const warnings = bounded(
    warningsOf(decision),
    limit,
    (w) => ghCommand("warning", w, { title: "SmartTest" }),
    (n) => ghCommand("warning", `${n} more warning(s); see the job log.`, { title: "SmartTest" }),
  );
  const errors = bounded(
    failingExecutions(input),
    limit,
    (e) =>
      ghCommand("error", failureMessage(e), { file: at(e.file), title: `SmartTest: ${e.status}` }),
    (n) =>
      ghCommand("error", `${n} more failing test file(s); see the step summary.`, {
        title: "SmartTest",
      }),
  );
  return {
    provider: "github",
    log: [...errors, ...warnings, ...notices],
    summary: selectionMarkdown(input),
    files: {},
    counts: {
      notices: notices.length,
      warnings: warnings.length,
      errors: errors.length,
      reportEntries: 0,
    },
  };
}

// ── GitLab ────────────────────────────────────────────────────────────────────────────────────

interface CodeQualityEntry {
  description: string;
  check_name: string;
  fingerprint: string;
  severity: "info" | "minor" | "major" | "critical" | "blocker";
  location: { path: string; lines: { begin: number } };
}

function gitlab(input: AnnotationInput, limit: number): CiAnnotations {
  const { decision } = input;
  const at = (f: string) => `${input.pathPrefix ?? ""}${f}`;
  const entry = (
    check: string,
    path: string,
    description: string,
    severity: CodeQualityEntry["severity"],
  ): CodeQualityEntry => ({
    description,
    check_name: check,
    fingerprint: sha256(`smarttest:${check}:${path}`).slice(0, 32),
    severity,
    location: { path: at(path), lines: { begin: 1 } },
  });
  const failing = failingExecutions(input).map((e) =>
    entry("smarttest-failed", e.file, `SmartTest: ${failureMessage(e).split("\n")[0]}`, "major"),
  );
  const notRun = input.command === "impact" ? " (selection only, not run here)" : "";
  const selected = decision.selectedTests.map((s) =>
    entry(
      "smarttest-selected",
      s.filePath,
      `SmartTest selected this test${notRun}: ${reasonOf(s.reasons)}`,
      "info",
    ),
  );
  const all = [...failing, ...selected];
  const kept = all.length <= limit ? all : all.slice(0, limit);
  const ts = Math.floor(Date.now() / 1000);
  const name = "smarttest_selection";
  const body = selectionText(input);
  return {
    provider: "gitlab",
    // A collapsible job-log section (GitLab's section markers).
    log: [
      `\u001b[0Ksection_start:${ts}:${name}[collapsed=true]\r\u001b[0K${body[0]}`,
      ...body.slice(1),
      `\u001b[0Ksection_end:${ts}:${name}\r\u001b[0K`,
    ],
    summary: selectionMarkdown(input),
    files: { "gl-code-quality.json": `${JSON.stringify(kept, null, 2)}\n` },
    counts: { notices: 0, warnings: 0, errors: 0, reportEntries: kept.length },
  };
}

// ── Bitbucket ─────────────────────────────────────────────────────────────────────────────────

function bitbucket(input: AnnotationInput, limit: number): CiAnnotations {
  const { decision } = input;
  const at = (f: string) => `${input.pathPrefix ?? ""}${f}`;
  const failing = failingExecutions(input);
  const notRun = input.command === "impact" ? " (selection only, not run here)" : "";
  const annotations = [
    ...failing.map((e) => ({
      external_id: `smarttest-failed-${sha256(e.file).slice(0, 16)}`,
      annotation_type: "BUG",
      summary: `SmartTest: ${e.status}`.slice(0, 450),
      details: failureMessage(e).slice(0, 2000),
      path: at(e.file),
      line: 1,
      severity: "HIGH",
      result: "FAILED",
    })),
    ...decision.selectedTests.map((s) => ({
      external_id: `smarttest-selected-${sha256(s.filePath).slice(0, 16)}`,
      annotation_type: "CODE_SMELL",
      summary: `SmartTest selected this test${notRun}`.slice(0, 450),
      details: reasonOf(s.reasons).slice(0, 2000),
      path: at(s.filePath),
      line: 1,
      severity: "LOW",
    })),
  ].slice(0, limit);
  const result =
    input.command === "run" ? (failing.length ? "FAILED" : "PASSED") : ("PENDING" as const);
  const report = {
    title: "SmartTest",
    details: `${decision.selectedTests.length} of ${decision.selectedTests.length + decision.skippedTests.length} test files selected (${input.description}); ${decision.skippedTests.length} not run. ${timeSavedText(decision, input.estimate)}.`,
    report_type: "TEST",
    reporter: "SmartTest",
    ...(result === "PENDING" ? {} : { result }),
    data: [
      { title: "Selected test files", type: "NUMBER", value: decision.selectedTests.length },
      {
        title: "Not run (skipped by selection)",
        type: "NUMBER",
        value: decision.skippedTests.length,
      },
      ...(input.estimate?.knownSkipped
        ? [
            {
              title: "Test time not run (estimate)",
              type: "DURATION",
              value: input.estimate.skippedTestTimeMs,
            },
          ]
        : []),
      { title: "Analysis", type: "TEXT", value: decision.analysisStatus },
    ],
  };
  return {
    provider: "bitbucket",
    log: selectionText(input),
    summary: selectionMarkdown(input),
    files: { "bitbucket-insights.json": `${JSON.stringify({ report, annotations }, null, 2)}\n` },
    counts: { notices: 0, warnings: 0, errors: 0, reportEntries: annotations.length },
  };
}

// ── shared text ───────────────────────────────────────────────────────────────────────────────

const mdCode = (s: string) => `\`${s.replace(/`/g, "'")}\``;
const mdText = (s: string) => s.replace(/[|<>]/g, (c) => `\\${c}`).replace(/\n/g, " ");

/** Plain lines for a job log. */
export function selectionText(input: AnnotationInput): string[] {
  const { decision } = input;
  const total = decision.selectedTests.length + decision.skippedTests.length;
  const lines = [
    `SmartTest: ${decision.selectedTests.length} of ${total} test files selected · ${decision.skippedTests.length} not run · ${input.description}`,
  ];
  for (const s of decision.selectedTests.slice(0, 50))
    lines.push(`  selected  ${s.filePath} — ${reasonOf(s.reasons)}`);
  if (decision.selectedTests.length > 50)
    lines.push(`  … ${decision.selectedTests.length - 50} more selected`);
  for (const g of skippedReasons(decision).slice(0, 10))
    lines.push(`  not run   ${g.count} — ${g.reason}`);
  for (const w of warningsOf(decision)) lines.push(`  warning   ${w}`);
  lines.push(`  ${timeSavedText(decision, input.estimate)}`);
  return lines;
}

/** The step summary: what was selected and why, what was not run and why, and the time saved. */
export function selectionMarkdown(input: AnnotationInput): string {
  const { decision } = input;
  const total = decision.selectedTests.length + decision.skippedTests.length;
  const failing = failingExecutions(input);
  const out: string[] = [];
  const verdict =
    input.command === "impact"
      ? "🔎 selection only, no test ran in this step"
      : failing.length
        ? `❌ ${failing.length} failing test file${failing.length === 1 ? "" : "s"}`
        : "✅ selected tests passed";
  out.push(
    `### SmartTest — ${decision.selectedTests.length} of ${total} test files selected · ${verdict}`,
    "",
    `${mdText(input.description)} · mode \`${decision.safetyMode}\` · analysis \`${decision.analysisStatus}\``,
    "",
    `**Time saved:** ${mdText(timeSavedText(decision, input.estimate))}`,
  );
  for (const w of warningsOf(decision)) out.push("", `> ⚠️ ${mdText(w)}`);
  if (failing.length) {
    out.push("", "| Failing file | Status |", "|---|---|");
    for (const e of failing.slice(0, 50)) out.push(`| ${mdCode(e.file)} | ${e.status} |`);
  }
  if (decision.selectedTests.length) {
    out.push(
      "",
      "<details><summary>Selected, and why</summary>",
      "",
      "| Test file | Reason |",
      "|---|---|",
    );
    for (const s of decision.selectedTests.slice(0, 200))
      out.push(`| ${mdCode(s.filePath)} | ${mdText(reasonOf(s.reasons))} |`);
    if (decision.selectedTests.length > 200)
      out.push(`| … | ${decision.selectedTests.length - 200} more |`);
    out.push("", "</details>");
  }
  if (decision.skippedTests.length) {
    out.push(
      "",
      `<details><summary>Not run (skipped by selection, never counted as passed): ${decision.skippedTests.length}</summary>`,
      "",
      "| Files | Reason |",
      "|---|---|",
    );
    for (const g of skippedReasons(decision).slice(0, 20))
      out.push(`| ${g.count} | ${mdText(g.reason)} |`);
    out.push("", "</details>");
  }
  let md = `${out.join("\n")}\n`;
  if (md.length > 65_000) md = `${md.slice(0, 64_000)}\n\n… truncated\n`;
  return md;
}

/** The annotations of one CI provider for a selection (and its run, when tests ran). */
export function ciAnnotations(
  provider: AnnotationProvider,
  input: AnnotationInput,
  limits: { perLevel?: number; reportEntries?: number } = {},
): CiAnnotations {
  if (provider === "github") return github(input, limits.perLevel ?? GITHUB_ANNOTATIONS_PER_LEVEL);
  if (provider === "gitlab") return gitlab(input, limits.reportEntries ?? REPORT_ANNOTATION_LIMIT);
  return bitbucket(input, limits.reportEntries ?? REPORT_ANNOTATION_LIMIT);
}
