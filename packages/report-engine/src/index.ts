/**
 * @smarttest/report-engine — honest, portable reports (spec §25).
 * Skipped ≠ passed, cached ≠ fresh, partial ≠ full, and fallbacks are always visible.
 */
import { join } from "node:path";
import type {
  ChangeSet,
  ImpactDecision,
  SafetyMode,
  TestExecution,
  TestStatus,
} from "@smarttest/shared";
import { formatDuration, VERSION, writeFileAtomic, writeJson } from "@smarttest/shared";

export const REPORT_SCHEMA_VERSION = 1;

export interface FileExecution {
  file: string;
  adapter: string;
  status: TestStatus;
  durationMs: number;
  tests: TestExecution[];
  error?: string;
}

export interface CoverageSummary {
  scope: "full" | "selected";
  lines: number;
  statements: number;
  functions: number;
  branches: number;
  files: number;
}

export interface RunSummary {
  totalTests: number;
  selected: number;
  executed: number;
  skippedBySelection: number;
  passed: number;
  failed: number;
  flaky: number;
  timedOut: number;
  cancelled: number;
  infrastructureErrors: number;
  skippedByTests: number;
  durationMs: number;
}

export interface RunReport {
  schemaVersion: number;
  tool: { name: "smarttest"; version: string };
  runId: string;
  command: string;
  startedAt: string;
  finishedAt: string;
  project: string;
  mode: SafetyMode;
  change: { description: string; changeSet: ChangeSet };
  decision: ImpactDecision;
  executions: FileExecution[];
  summary: RunSummary;
  coverage?: CoverageSummary;
  timings: Record<string, number>;
  warnings: string[];
}

export function summarize(
  decision: ImpactDecision,
  executions: readonly FileExecution[],
  durationMs: number,
): RunSummary {
  const tests = executions.flatMap((e) => e.tests);
  const count = (s: TestStatus) => tests.filter((t) => t.status === s).length;
  return {
    totalTests: decision.selectedTests.length + decision.skippedTests.length,
    selected: decision.selectedTests.length,
    executed: executions.filter((e) => e.status !== "cancelled").length,
    skippedBySelection: decision.skippedTests.length,
    passed: count("passed"),
    failed: count("failed"),
    flaky: count("flaky"),
    timedOut: count("timed-out"),
    cancelled: count("cancelled"),
    infrastructureErrors: count("infrastructure-error"),
    skippedByTests: count("skipped") + count("pending"),
    durationMs,
  };
}

export function overallStatus(report: RunReport): "passed" | "failed" | "error" {
  const s = report.summary;
  if (s.infrastructureErrors) return "error";
  if (s.failed || s.timedOut || s.cancelled) return "failed";
  return "passed";
}

// ── Integrity ──────────────────────────────────────────────────────────────────────────────

/** Validates that a report never overstates results (spec §25.4). Returns violations. */
export function validateReportIntegrity(report: RunReport): string[] {
  const issues: string[] = [];
  const selected = new Set(report.decision.selectedTests.map((t) => t.filePath));
  const skipped = new Set(report.decision.skippedTests.map((t) => t.filePath));
  for (const e of report.executions) {
    if (skipped.has(e.file))
      issues.push(`${e.file} is listed as skipped by selection but has an execution record`);
    if (!selected.has(e.file)) issues.push(`${e.file} was executed but is not in the selection`);
    for (const t of e.tests) {
      if ((t.status === "cached-pass" || t.status === "cached-failure") && !t.testId)
        issues.push("cached result without identity");
    }
  }
  for (const s of selected) if (skipped.has(s)) issues.push(`${s} is both selected and skipped`);
  const s = report.summary;
  const tests = report.executions.flatMap((e) => e.tests);
  if (s.passed !== tests.filter((t) => t.status === "passed").length)
    issues.push("summary.passed does not match executions");
  if (s.passed > tests.length) issues.push("more passes than executed tests");
  if (s.skippedBySelection !== report.decision.skippedTests.length)
    issues.push("summary.skippedBySelection does not match the decision");
  if (report.decision.fallbackApplied && report.decision.analysisStatus !== "fallback")
    issues.push("fallback applied but analysisStatus is not 'fallback'");
  if (report.coverage && report.coverage.scope === "full" && report.decision.skippedTests.length)
    issues.push("coverage labelled 'full' for a run that skipped tests");
  return issues;
}

// ── Writers ────────────────────────────────────────────────────────────────────────────────

const esc = (s: unknown) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const xmlEsc = (s: unknown) =>
  esc(s)
    // strip characters that are invalid in XML 1.0
    // biome-ignore lint/suspicious/noControlCharactersInRegex: removing control characters is the point
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");

export function toJUnit(report: RunReport, includeSkipped = false): string {
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>'];
  const s = report.summary;
  lines.push(
    `<testsuites name="smarttest" tests="${s.passed + s.failed + s.flaky + s.timedOut + (includeSkipped ? s.skippedBySelection : 0)}" failures="${s.failed + s.timedOut}" errors="${s.infrastructureErrors}" time="${(s.durationMs / 1000).toFixed(3)}">`,
  );
  for (const e of report.executions) {
    const failures = e.tests.filter(
      (t) => t.status === "failed" || t.status === "timed-out",
    ).length;
    const errors = e.tests.filter((t) => t.status === "infrastructure-error").length;
    const skippedCount = e.tests.filter(
      (t) => t.status === "skipped" || t.status === "pending",
    ).length;
    lines.push(
      `  <testsuite name="${xmlEsc(e.file)}" tests="${e.tests.length}" failures="${failures}" errors="${errors}" skipped="${skippedCount}" time="${(e.durationMs / 1000).toFixed(3)}">`,
    );
    for (const t of e.tests) {
      const name = t.testId.slice(t.testId.indexOf("::") + 2);
      lines.push(
        `    <testcase classname="${xmlEsc(e.file)}" name="${xmlEsc(name)}" time="${(t.durationMs / 1000).toFixed(3)}">`,
      );
      if (t.status === "failed" || t.status === "timed-out")
        lines.push(
          `      <failure message="${xmlEsc(t.status)}">${xmlEsc(t.error?.message ?? "")}</failure>`,
        );
      else if (t.status === "infrastructure-error")
        lines.push(
          `      <error message="infrastructure error">${xmlEsc(t.error?.message ?? "")}</error>`,
        );
      else if (t.status === "skipped" || t.status === "pending")
        lines.push(`      <skipped message="${xmlEsc(t.status)}"/>`);
      else if (t.status === "flaky")
        lines.push(`      <system-out>flaky: passed after ${t.attempts} attempts</system-out>`);
      lines.push("    </testcase>");
    }
    lines.push("  </testsuite>");
  }
  if (includeSkipped && report.decision.skippedTests.length) {
    lines.push(
      `  <testsuite name="smarttest: skipped by selection (not run)" tests="${report.decision.skippedTests.length}" skipped="${report.decision.skippedTests.length}" failures="0" errors="0">`,
    );
    for (const t of report.decision.skippedTests) {
      lines.push(
        `    <testcase classname="${xmlEsc(t.filePath)}" name="(not run)"><skipped message="${xmlEsc(`not run — ${t.reasons[0] ?? "not selected"}`)}"/></testcase>`,
      );
    }
    lines.push("  </testsuite>");
  }
  lines.push("</testsuites>");
  return `${lines.join("\n")}\n`;
}

export function toMarkdown(report: RunReport, htmlLink?: string): string {
  const s = report.summary;
  const status = overallStatus(report);
  const icon = status === "passed" ? "✅" : status === "failed" ? "❌" : "⚠️";
  const out: string[] = [];
  out.push(
    `### ${icon} SmartTest — ${s.passed} passed · ${s.failed} failed${s.flaky ? ` · ${s.flaky} flaky` : ""} · ${s.skippedBySelection} skipped (not run) · ${formatDuration(s.durationMs)}`,
  );
  out.push("");
  out.push(
    `**${s.selected} of ${s.totalTests} test files selected** · mode \`${report.decision.safetyMode}\` · analysis \`${report.decision.analysisStatus}\` · ${esc(report.change.description)}`,
  );
  if (report.decision.fallbackApplied)
    out.push(
      "",
      `> ⚠️ Fallback applied: ${esc(report.decision.reasons.find((r) => r.kind === "fallback" || r.kind === "mandatory-trigger")?.message ?? "full suite")}`,
    );
  const failing = report.executions.filter((e) =>
    ["failed", "timed-out", "infrastructure-error"].includes(e.status),
  );
  if (failing.length) {
    out.push("", "| Failing file | Status |", "|---|---|");
    for (const e of failing) out.push(`| \`${e.file}\` | ${e.status} |`);
  }
  out.push("", "<details><summary>Why these tests?</summary>", "");
  for (const t of report.decision.selectedTests.slice(0, 50))
    out.push(`- \`${t.filePath}\` — ${esc(t.reasons.map((r) => r.message).join("; "))}`);
  if (report.decision.selectedTests.length > 50)
    out.push(`- … ${report.decision.selectedTests.length - 50} more`);
  out.push("", "</details>");
  if (report.coverage)
    out.push(
      "",
      `Coverage (${report.coverage.scope === "full" ? "full suite" : "selected tests only — not project coverage"}): lines ${report.coverage.lines}% · branches ${report.coverage.branches}%`,
    );
  if (htmlLink) out.push("", `[Full HTML report](${htmlLink})`);
  let md = `${out.join("\n")}\n`;
  if (md.length > 65_000) md = `${md.slice(0, 64_000)}\n\n… truncated\n`;
  return md;
}

/** Drops runner-internal stack frames (node_modules, node:internal) for readability. */
export function trimStack(message: string): string {
  const lines = message.split("\n");
  const kept = lines.filter(
    (l) =>
      !/^\s*at .*(?:node_modules|node:internal)/.test(l) &&
      !/^\s*(?:file:\/\/|\()?\S*node_modules\S*\)?$/.test(l),
  );
  return kept.length < lines.length
    ? `${kept.join("\n")}\n    … ${lines.length - kept.length} runner frame(s) hidden`
    : message;
}

export function toHtml(report: RunReport): string {
  const s = report.summary;
  const status = overallStatus(report);
  const statusLabel =
    status === "passed" ? "Passed" : status === "failed" ? "Failed" : "Infrastructure error";
  const statusClass: Record<string, string> = {
    passed: "pass",
    failed: "fail",
    flaky: "warn",
    "timed-out": "fail",
    "infrastructure-error": "fail",
    cancelled: "warn",
    skipped: "skip",
    pending: "skip",
  };
  const execRows = report.executions
    .map((e) => {
      const tests = e.tests
        .map(
          (t) =>
            `<li class="t ${statusClass[t.status] ?? "skip"}"><span class="sym" aria-hidden="true">${t.status === "passed" ? "✓" : t.status === "flaky" ? "↻" : t.status === "skipped" || t.status === "pending" ? "○" : "✕"}</span><span class="name">${esc(t.testId.slice(t.testId.indexOf("::") + 2))}</span><span class="badge">${esc(t.status)}</span><span class="dur">${esc(formatDuration(t.durationMs))}</span>${t.error ? `<pre>${esc(trimStack(t.error.message))}</pre>` : ""}</li>`,
        )
        .join("");
      return `<details class="file ${statusClass[e.status] ?? "skip"}" ${e.status !== "passed" ? "open" : ""}><summary><span class="dot"></span><code>${esc(e.file)}</code><span class="badge">${esc(e.status)}</span><span class="dur">${esc(formatDuration(e.durationMs))}</span></summary><ul>${tests}</ul></details>`;
    })
    .join("");
  const selRows = report.decision.selectedTests
    .map(
      (t) =>
        `<details class="reason"><summary><span class="sq pass"></span><code>${esc(t.filePath)}</code></summary><ul>${t.reasons.map((r) => `<li><b>${esc(r.kind)}</b> ${esc(r.message)}${r.path ? `<div class="path">${r.path.map((p) => `<code>${esc(p)}</code>`).join(" → ")}</div>` : ""}</li>`).join("")}</ul></details>`,
    )
    .join("");
  const skipRows = report.decision.skippedTests
    .map(
      (t) =>
        `<details class="reason"><summary><span class="sq skip"></span><code>${esc(t.filePath)}</code> <span class="muted">not run</span></summary><ul>${t.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}${t.confidence ? `<li class="muted">${esc(t.confidence)}</li>` : ""}</ul></details>`,
    )
    .join("");
  const changes = report.change.changeSet.changes
    .map(
      (c) =>
        `<li><span class="ct">${esc(c.type)}</span> <code>${esc(c.path)}</code>${c.previousPath ? ` <span class="muted">← ${esc(c.previousPath)}</span>` : ""}</li>`,
    )
    .join("");
  const timings = Object.entries(report.timings)
    .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(formatDuration(v))}</td></tr>`)
    .join("");
  const warn = [...report.warnings, ...report.decision.warnings]
    .map((w) => `<li>${esc(w)}</li>`)
    .join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<title>SmartTest report — ${esc(statusLabel)}</title>
<style>
:root{--bg:#070B18;--panel:#111A38;--line:#22305C;--text:#E8ECF8;--muted:#8C97BD;--dim:#56618A;--cyan:#22D3EE;--violet:#8B5CF6;--pass:#34D399;--fail:#FB7185;--warn:#FBBF24;--skip:#3A4567;--ease:cubic-bezier(.22,1,.36,1)}
@media (prefers-color-scheme: light){:root{--bg:#fff;--panel:#F5F7FC;--line:#D9DFEE;--text:#0B1020;--muted:#4A5578;--dim:#6B7698;--pass:#047857;--fail:#BE123C;--warn:#B45309;--skip:#CBD2E3;--cyan:#0E7490;--violet:#6D28D9}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 ui-sans-serif,-apple-system,"Segoe UI",Inter,Roboto,Helvetica,Arial,sans-serif}
code,pre,.mono{font-family:ui-monospace,SFMono-Regular,"JetBrains Mono",Menlo,Consolas,monospace;font-size:13px}
main{max-width:1100px;margin:0 auto;padding:32px 24px 64px}
header{display:flex;align-items:center;gap:16px;margin-bottom:24px}
.logo{width:40px;height:40px;border-radius:10px;background:linear-gradient(135deg,var(--cyan),var(--violet));display:grid;place-items:center;color:#fff;font-weight:800}
h1{font-size:28px;letter-spacing:-.5px;margin:0}h2{font-size:13px;letter-spacing:2px;text-transform:uppercase;color:var(--dim);margin:32px 0 12px;font-family:ui-monospace,Menlo,monospace}
.status{padding:4px 12px;border-radius:999px;font-weight:700;font-size:13px}.status.passed{background:var(--pass);color:#06281c}.status.failed{background:var(--fail);color:#3b0712}.status.error{background:var(--warn);color:#3b2603}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:16px;animation:in .36s var(--ease) both}
.card b{display:block;font-size:26px;letter-spacing:-.5px}.card span{color:var(--muted);font-size:13px}
.card.pass b{color:var(--pass)}.card.fail b{color:var(--fail)}.card.warn b{color:var(--warn)}.card.skip b{color:var(--muted)}
.banner{border:1px solid var(--warn);border-radius:12px;padding:12px 16px;margin:16px 0;color:var(--text)}
details{background:var(--panel);border:1px solid var(--line);border-radius:12px;margin:8px 0;padding:0 14px}
summary{cursor:pointer;display:flex;gap:10px;align-items:center;padding:10px 0;list-style:none}summary::-webkit-details-marker{display:none}
summary:focus-visible,a:focus-visible{outline:2px solid var(--cyan);outline-offset:2px;border-radius:6px}
.badge{margin-left:auto;font-size:12px;color:var(--muted);font-family:ui-monospace,Menlo,monospace}.dur{color:var(--dim);font-size:12px;min-width:60px;text-align:right}
.dot,.sq{width:10px;height:10px;border-radius:50%;background:var(--dim);flex:none}.sq{border-radius:3px}
.file.pass .dot,.sq.pass{background:var(--pass)}.file.fail .dot{background:var(--fail)}.file.warn .dot{background:var(--warn)}.sq.skip{background:transparent;border:1.5px dashed var(--dim)}
ul{margin:0 0 12px;padding-left:20px}.t{list-style:none;display:flex;flex-wrap:wrap;gap:8px;align-items:baseline;padding:2px 0}.t .name{flex:1}.t pre{flex-basis:100%;white-space:pre-wrap;background:var(--bg);border-radius:8px;padding:8px;margin:4px 0;overflow:auto;max-height:280px}
.t.pass .sym{color:var(--pass)}.t.fail .sym{color:var(--fail)}.t.warn .sym{color:var(--warn)}.t.skip .sym{color:var(--dim)}
.path{margin-top:4px;color:var(--muted)}.muted{color:var(--muted)}.ct{display:inline-block;min-width:70px;color:var(--muted);font-family:ui-monospace,Menlo,monospace;font-size:12px}
table{border-collapse:collapse;width:100%}td{padding:6px 8px;border-bottom:1px solid var(--line)}
.meta{color:var(--muted);font-size:13px}
@keyframes in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.grid .card:nth-child(2){animation-delay:40ms}.grid .card:nth-child(3){animation-delay:80ms}.grid .card:nth-child(4){animation-delay:120ms}.grid .card:nth-child(5){animation-delay:160ms}.grid .card:nth-child(6){animation-delay:200ms}
@media (prefers-reduced-motion: reduce){*{animation:none!important}}
</style>
</head>
<body>
<main>
<header><div class="logo" aria-hidden="true">✓</div><div><h1>SmartTest report</h1><div class="meta">${esc(report.project)} · ${esc(report.command)} · ${esc(report.startedAt)}</div></div><span class="status ${status}" style="margin-left:auto">${esc(statusLabel)}</span></header>
<section aria-label="Summary" class="grid">
<div class="card"><b>${s.selected}<span> / ${s.totalTests}</span></b><span>test files selected</span></div>
<div class="card pass"><b>${s.passed}</b><span>passed</span></div>
<div class="card fail"><b>${s.failed + s.timedOut}</b><span>failed / timed out</span></div>
<div class="card warn"><b>${s.flaky}</b><span>flaky (passed on retry)</span></div>
<div class="card skip"><b>${s.skippedBySelection}</b><span>skipped by selection — not run</span></div>
<div class="card"><b>${esc(formatDuration(s.durationMs))}</b><span>duration</span></div>
</section>
<p class="meta">Mode <b>${esc(report.decision.safetyMode)}</b>${report.decision.requestedMode && report.decision.requestedMode !== report.decision.safetyMode ? ` (upgraded from ${esc(report.decision.requestedMode)})` : ""} · analysis <b>${esc(report.decision.analysisStatus)}</b> · ${esc(report.change.description)}</p>
${
  report.decision.fallbackApplied
    ? `<div class="banner" role="note">⚠ Fallback applied — ${esc(
        report.decision.reasons
          .filter((r) => r.kind === "fallback" || r.kind === "mandatory-trigger")
          .map((r) => r.message)
          .join("; "),
      )}</div>`
    : ""
}
${warn ? `<h2>Warnings</h2><ul>${warn}</ul>` : ""}
<h2>Executions</h2>${execRows || '<p class="muted">No tests were executed.</p>'}
<h2>Why these tests</h2>${selRows || '<p class="muted">No tests selected.</p>'}
<h2>Skipped by selection (not run)</h2>${skipRows || '<p class="muted">Nothing skipped.</p>'}
<h2>Change analysis</h2><ul>${changes || "<li class=muted>No changes</li>"}</ul>
${report.coverage ? `<h2>Coverage — ${report.coverage.scope === "full" ? "full suite" : "selected tests only (not project coverage)"}</h2><div class="grid"><div class="card"><b>${report.coverage.lines}%</b><span>lines</span></div><div class="card"><b>${report.coverage.branches}%</b><span>branches</span></div><div class="card"><b>${report.coverage.functions}%</b><span>functions</span></div></div>` : ""}
<h2>Performance</h2><table>${timings}</table>
<p class="meta">smarttest ${esc(report.tool.version)} · schema v${report.schemaVersion} · run ${esc(report.runId)}</p>
</main>
</body>
</html>
`;
}

export async function writeReports(
  report: RunReport,
  outputDir: string,
  formats: readonly ("html" | "json" | "junit" | "markdown")[],
): Promise<Record<string, string>> {
  const written: Record<string, string> = {};
  if (formats.includes("json")) {
    written.json = join(outputDir, "report.json");
    await writeJson(written.json, report);
  }
  if (formats.includes("html")) {
    written.html = join(outputDir, "report.html");
    await writeFileAtomic(written.html, toHtml(report));
  }
  if (formats.includes("junit")) {
    written.junit = join(outputDir, "junit.xml");
    await writeFileAtomic(written.junit, toJUnit(report));
  }
  if (formats.includes("markdown")) {
    written.markdown = join(outputDir, "summary.md");
    await writeFileAtomic(
      written.markdown,
      toMarkdown(report, written.html ? "report.html" : undefined),
    );
  }
  return written;
}

export function newRunId(): string {
  return `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

export const TOOL = { name: "smarttest" as const, version: VERSION };
