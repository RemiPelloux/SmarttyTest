/**
 * Tests, Trust and Source. These are the three places a developer checks a selection instead of
 * believing it: what ran, what the evidence has missed, and what the graph actually read.
 */

import { facts, panel, screenHead, section } from "./screens.js";
import {
  button,
  dataTable,
  duration,
  empty,
  h,
  icon,
  loading,
  num,
  pct,
  plural,
  relativeTime,
  selectionMark,
  statusMark,
  tabs,
} from "./ui.js";

function toolbar(...children) {
  return h(
    "div",
    { style: "display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:10px 0" },
    children,
  );
}

function resultMark(row) {
  const result = row.result;
  if (!result) return statusMark("skipped", { text: "not run" });
  if (result.status === "timed-out") return statusMark("timed-out");
  if (result.status === "infrastructure-error")
    return statusMark("infrastructure-error", { text: "infra error" });
  if (result.failed) return statusMark("failed", { text: `${num(result.failed)} failed` });
  if (result.cached === result.tests && result.tests > 0)
    return statusMark("cached-pass", { text: "cached, not run" });
  if (result.status === "failed") return statusMark("failed");
  if (result.cached) return statusMark("passed", { text: `${num(result.cached)} cached` });
  return statusMark("passed");
}

function countTabs(rows) {
  return [
    { id: "all", label: "All", count: rows.length },
    {
      id: "selected",
      label: "Selected",
      count: rows.filter((r) => r.selection === "selected").length,
    },
    { id: "failed", label: "Failed", count: rows.filter((r) => r.result?.failed).length },
    { id: "cached", label: "Cached", count: rows.filter((r) => r.result?.cached).length },
    {
      id: "skipped",
      label: "Skipped",
      count: rows.filter((r) => r.selection === "skipped").length,
    },
    { id: "flaky", label: "Flaky", count: rows.filter((r) => r.flaky).length },
  ];
}

export function filteredTests(state, tests) {
  const query = state.testsQuery.trim().toLowerCase();
  return tests.rows.filter((row) => {
    if (state.testsTab === "selected" && row.selection !== "selected") return false;
    if (state.testsTab === "skipped" && row.selection !== "skipped") return false;
    if (state.testsTab === "failed" && !row.result?.failed) return false;
    if (state.testsTab === "cached" && !row.result?.cached) return false;
    if (state.testsTab === "flaky" && !row.flaky) return false;
    if (!query) return true;
    return `${row.filePath} ${row.adapter ?? ""} ${row.reasons.join(" ")}`
      .toLowerCase()
      .includes(query);
  });
}

export function renderTests(ctx) {
  const { state } = ctx;
  const tests = state.data.tests;
  if (!tests) return ctx.helpers.loadingOrError("tests");
  const tabItems = countTabs(tests.rows);
  const rows = filteredTests(state, tests);
  const selected = rows.filter((r) => r.selection === "selected").length;
  const failed = rows.filter((r) => r.result?.failed).length;
  const cached = rows.filter((r) => r.result?.cached).length;

  return h(
    "div",
    { class: "screen" },
    screenHead({
      parts: ["tests", `${plural(tests.rows.length, "file")} discovered`, state.testsTab],
      title: "Tests",
      finding: h(
        "span",
        null,
        tests.rows.length
          ? [
              h("strong", null, plural(selected, "selected file")),
              " · ",
              h("strong", null, plural(failed, "failed file")),
              " · ",
              h("strong", null, plural(cached, "file with cached results")),
              ` · last run ${relativeTime(tests.generatedAt)}`,
            ]
          : "No test file was discovered in this project.",
      ),
      actions: [ctx.actions.refreshButton(), ctx.actions.runButton("affected")],
    }),
    facts([
      {
        label: "Selected",
        value: num(tests.counts.selected),
        small: `of ${num(tests.rows.length)}`,
        note: `${num(tests.counts.skipped)} not run by selection`,
      },
      {
        label: "Failed in last run",
        value: num(tests.counts.failed),
        note: tests.counts.failed ? "open the Failed tab" : "no failed file recorded",
        tone: tests.counts.failed ? "fail" : undefined,
      },
      {
        label: "Cached results",
        value: num(tests.counts.cached),
        note: tests.counts.cached ? "not executed in that run" : "nothing served from cache",
      },
      {
        label: "Flaky tests",
        value: num(tests.counts.flaky),
        note: tests.counts.flaky ? "results changed across runs" : "none above the threshold",
      },
    ]),
    tabs({
      items: tabItems.map((item) => ({
        ...item,
        label: item.label,
      })),
      active: state.testsTab,
      onSelect: ctx.actions.selectTestsTab,
      idPrefix: "tests",
    }),
    toolbar(
      h(
        "label",
        { style: "flex:1 1 260px;display:flex;align-items:center;gap:7px" },
        icon("search", 13),
        h("input", {
          class: "input",
          type: "search",
          placeholder: "Filter by path, runner or reason",
          value: state.testsQuery,
          "data-search": "tests",
          "aria-label": "Filter tests",
          onInput: (event) => ctx.actions.setTestsQuery(event.target.value),
        }),
      ),
      h("span", { class: "hint" }, `${num(rows.length)} shown`),
      button({
        label: "Export CSV",
        iconName: "download",
        size: "btn--small",
        onClick: ctx.actions.exportTests,
      }),
      button({
        label: "Run all tests",
        iconName: "all",
        size: "btn--small",
        onClick: () => ctx.actions.run("all"),
      }),
    ),
    rows.length
      ? dataTable({
          caption: "Test files and their selection and last result",
          columns: [
            {
              label: "Test file",
              cell: (row) =>
                h(
                  "button",
                  {
                    class: "row-btn",
                    type: "button",
                    title: row.filePath,
                    onClick: () => ctx.actions.openSource(row.filePath),
                  },
                  row.filePath,
                ),
            },
            {
              label: "Runner",
              hidePhone: true,
              cell: (row) => h("span", { class: "badge" }, row.adapter ?? "unknown"),
            },
            {
              label: "Selection",
              cell: (row) =>
                row.selection
                  ? selectionMark(row.selection)
                  : h("span", { class: "status", dataset: { status: "skipped" } }, "–"),
            },
            {
              label: "Last result",
              cell: (row) => resultMark(row),
            },
            {
              label: "Duration",
              align: "right",
              hidePhone: true,
              cell: (row) =>
                h(
                  "span",
                  { class: "mono", style: "font-variant-numeric:tabular-nums" },
                  row.result ? duration(row.result.durationMs) : "–",
                ),
            },
            {
              label: "Evidence",
              hidePhone: true,
              cell: (row) =>
                row.flaky
                  ? h(
                      "span",
                      { class: "reason-text" },
                      `flaky ${pct(row.flaky.rate * 100, 100)} · ${row.flaky.recent}`,
                    )
                  : h(
                      "span",
                      { class: "reason-text", title: row.reasons.join("\n") },
                      row.reasons[0] ??
                        (row.depth !== null
                          ? `${plural(row.depth, "node", "nodes")} from the change`
                          : "—"),
                    ),
            },
            {
              label: "",
              align: "right",
              cell: (row) =>
                h(
                  "div",
                  { class: "table-actions" },
                  button({
                    label: "Run",
                    iconName: "play",
                    size: "btn--small",
                    title: `Run ${row.filePath} alone`,
                    disabled: Boolean(
                      state.run &&
                        state.runOpen &&
                        state.run.state !== "done" &&
                        state.run.state !== "failed" &&
                        state.run.state !== "cancelled",
                    ),
                    onClick: () => ctx.actions.run("file", row.filePath),
                  }),
                ),
            },
          ],
          rows,
          rowKey: (row) => row.filePath,
          onRowClick: (row) => ctx.actions.openSource(row.filePath),
          rowProps: (row, index) => ({
            class: "row-enter",
            vars: { "--i": String(Math.min(index, 16)) },
            "data-dim": String(row.selection === "skipped"),
          }),
        })
      : empty({
          title: state.testsQuery
            ? "No test matches this filter"
            : state.testsTab === "failed"
              ? "No failed test in the last run"
              : state.testsTab === "cached"
                ? "No cached result in the last run"
                : state.testsTab === "flaky"
                  ? "No flaky test in the recorded history"
                  : "This tab is empty",
          body: state.testsQuery
            ? "Clear the filter to see the tests in this tab."
            : "The count in the tab is the number of rows beside it, not an estimate.",
          actions: state.testsQuery
            ? [button({ label: "Clear filter", onClick: () => ctx.actions.setTestsQuery("") })]
            : [],
        }),
    section({
      title: "Honesty rules",
      body: h(
        "p",
        { class: "hint" },
        "A cached result is shown as cached and was not run. A test skipped by tests or by the selection is not passed. A selection with no trace evidence is a static result, not a measured one.",
      ),
    }),
  );
}

function shadowTable(shadow) {
  return dataTable({
    caption: "Shadow runs that replayed the full suite",
    columns: [
      {
        label: "Commit",
        cell: (r) => h("span", { class: "mono" }, r.head ?? "–"),
      },
      { label: "Changed", align: "right", cell: (r) => num(r.changed) },
      {
        label: "Selected / full",
        align: "right",
        cell: (r) => `${num(r.selected)} / ${num(r.total)}`,
      },
      {
        label: "Missed",
        align: "right",
        cell: (r) =>
          r.missed
            ? statusMark("failed", { text: String(r.missed) })
            : statusMark("passed", { text: "0" }),
      },
      { label: "Mode", hidePhone: true, cell: (r) => h("span", { class: "badge" }, r.mode) },
      {
        label: "Time",
        align: "right",
        hidePhone: true,
        cell: (r) => duration(r.selectedMs),
      },
    ],
    rows: shadow.records,
  });
}

function trustFacts(trust, traces) {
  const shadow = trust.shadow;
  const benchmark = trust.benchmark;
  const saved = benchmark?.savedPct ?? shadow?.savedPct ?? null;
  return facts([
    {
      label: "Missed failures",
      value: shadow ? num(shadow.missed) : "–",
      note: shadow ? `over ${plural(shadow.runs, "replayed run")}` : "no shadow history",
      tone: shadow?.missed ? "fail" : undefined,
    },
    {
      label: "Cache violations",
      value: benchmark ? num(benchmark.cacheViolations) : "–",
      note: benchmark ? `over ${plural(benchmark.commits, "commit")}` : "no benchmark on disk",
      tone: benchmark?.cacheViolations ? "fail" : undefined,
    },
    {
      label: "Time saved",
      value: saved === null ? "–" : `${Math.round(saved)}%`,
      note: benchmark
        ? `${duration(benchmark.smarttestMs)} vs ${duration(benchmark.fullMs)}`
        : shadow
          ? "from shadow replays"
          : "not measured yet",
    },
    {
      label: "Fresh traces",
      value: traces.available ? `${num(traces.fresh)}/${num(traces.tests)}` : "–",
      note: traces.available
        ? `${num(traces.stale)} stale · ${num(traces.missing)} never traced`
        : "run trace --all",
      tone: traces.stale ? "warn" : undefined,
    },
  ]);
}

function coveragePanel(coverage) {
  return panel({
    title: "Coverage",
    note: coverage ? `${coverage.scope} scope` : "none recorded",
    body: coverage
      ? h(
          "div",
          { class: "detail__body" },
          facts([
            { label: "Lines", value: `${coverage.lines}%`, note: "" },
            { label: "Branches", value: `${coverage.branches}%`, note: "" },
            { label: "Functions", value: `${coverage.functions}%`, note: "" },
            { label: "Statements", value: `${coverage.statements}%`, note: "" },
          ]),
          h(
            "p",
            { class: "detail__meta", style: "margin-top:8px" },
            `${plural(coverage.files, "file")} · ${relativeTime(coverage.at)} · ${
              coverage.scope === "full"
                ? "full suite"
                : "selected tests only — this is not whole-project coverage"
            }`,
          ),
        )
      : empty({
          title: "No coverage recorded",
          body: "Coverage is shown only when a run wrote it, and its scope is always named. A selected run is never presented as full coverage.",
        }),
  });
}

function hooksPanel(hooks) {
  return panel({
    title: "Commit hook",
    note: hooks ? (hooks.installedLocally ? "installed" : "not installed locally") : "no history",
    body: hooks
      ? h(
          "div",
          { class: "detail__body" },
          h(
            "div",
            { class: "run-summary" },
            h("div", null, h("b", null, num(hooks.runs)), h("span", null, "runs")),
            h("div", null, h("b", null, duration(hooks.medianMs)), h("span", null, "median")),
            h("div", null, h("b", null, duration(hooks.slowestMs)), h("span", null, "slowest")),
            h("div", null, h("b", null, num(hooks.failures)), h("span", null, "failures")),
          ),
          hooks.bypasses.length
            ? h(
                "div",
                { style: "margin-top:10px" },
                h("p", { class: "fact__label" }, "Bypasses"),
                hooks.bypasses
                  .slice(0, 4)
                  .map((b) =>
                    h(
                      "p",
                      { class: "detail__meta" },
                      `${relativeTime(b.at)} · ${b.stage} · ${b.reason}`,
                    ),
                  ),
              )
            : null,
          hooks.withoutHook.without.length
            ? h(
                "div",
                { style: "margin-top:10px" },
                h("p", { class: "fact__label" }, "Commits without the hook"),
                hooks.withoutHook.without
                  .slice(0, 4)
                  .map((c) =>
                    h("p", { class: "detail__meta" }, `${c.sha.slice(0, 8)} · ${c.subject}`),
                  ),
                h(
                  "p",
                  { class: "detail__meta" },
                  `${num(hooks.withoutHook.checked)} commits checked`,
                ),
              )
            : null,
        )
      : empty({
          title: "No hook history",
          body: "Install the SmartTest hook to record whether commits actually ran the affected tests.",
        }),
  });
}

export function renderTrust(ctx) {
  const { state } = ctx;
  const trust = state.data.trust;
  if (!trust) return ctx.helpers.loadingOrError("trust");
  const shadow = trust.shadow;
  const benchmark = trust.benchmark;

  const finding = shadow
    ? h(
        "span",
        null,
        h("strong", null, `${num(shadow.missed)} missed failures`),
        ` across ${plural(shadow.runs, "shadow run")} · `,
        h("strong", null, `${num(shadow.selected)} of ${num(shadow.total)} tests`),
        " selected on average.",
      )
    : h(
        "span",
        null,
        "This repository has no shadow replay yet. ",
        h("strong", null, "Trust is unmeasured"),
        ", not zero.",
      );

  return h(
    "div",
    { class: "screen" },
    screenHead({
      parts: [
        "trust",
        trust.updatedAt ? relativeTime(trust.updatedAt) : "never updated",
        "local evidence",
      ],
      title: "Trust",
      finding,
      actions: [ctx.actions.refreshButton()],
    }),
    trustFacts(trust, trust.traces),
    trust.cache.integrityIssues.length
      ? h(
          "div",
          { class: "notice" },
          icon("warning", 14),
          h(
            "div",
            { class: "notice__body" },
            h("span", { class: "notice__label" }, "Cache integrity"),
            trust.cache.integrityIssues.map((issue) => h("p", null, issue)),
          ),
        )
      : null,
    section({
      title: "What was replayed",
      note: shadow
        ? `${plural(shadow.runs, "run")} · ${num(shadow.runsWithMisses)} with misses`
        : "no data",
      body: shadow?.records.length
        ? shadowTable(shadow)
        : empty({
            title: "No replayed commits yet",
            body: "A shadow run replays the full suite behind an affected-only run and records what it would have missed. Until that exists, Studio will not put a number on trust.",
          }),
    }),
    h(
      "div",
      { class: "split", style: "margin-top:18px" },
      benchmark
        ? panel({
            title: "Benchmark",
            note: `${plural(benchmark.commits, "commit")} · ${benchmark.mode}`,
            body: h(
              "div",
              { class: "detail__body" },
              facts([
                { label: "Full suite", value: duration(benchmark.fullMs), note: "" },
                { label: "SmartTest", value: duration(benchmark.smarttestMs), note: "" },
                { label: "Saved", value: `${Math.round(benchmark.savedPct)}%`, note: "" },
                {
                  label: "Missed",
                  value: num(benchmark.missed),
                  note: `cache ${num(benchmark.cacheViolations)}`,
                  tone: benchmark.missed ? "fail" : undefined,
                },
              ]),
              h(
                "p",
                { class: "detail__meta", style: "margin-top:8px" },
                `${num(benchmark.selectedTests)} of ${num(benchmark.totalTests)} tests selected · generated ${relativeTime(benchmark.at)}`,
              ),
            ),
          })
        : panel({
            title: "Benchmark",
            note: "not run",
            body: empty({
              title: "No benchmark on disk",
              body: "Run smarttest benchmark to replay commits and compare a full suite with the selection.",
            }),
          }),
      coveragePanel(trust.coverage),
    ),
    h(
      "div",
      { class: "split", style: "margin-top:18px" },
      panel({
        title: "Flaky tests",
        note: `${plural(trust.flaky.length, "test")} above the threshold`,
        body: trust.flaky.length
          ? dataTable({
              caption: "Tests whose results changed across recent runs",
              columns: [
                { label: "Test", cell: (f) => h("span", { class: "mono" }, f.testId) },
                {
                  label: "Flake rate",
                  align: "right",
                  cell: (f) => `${Math.round(f.flakeRate * 100)}%`,
                },
                {
                  label: "Runs",
                  align: "right",
                  hidePhone: true,
                  cell: (f) => num(f.runs),
                },
                {
                  label: "Recent",
                  hidePhone: true,
                  cell: (f) => h("span", { class: "mono" }, f.recent),
                },
              ],
              rows: trust.flaky.slice(0, 40),
            })
          : empty({
              title: "No flaky tests recorded",
              body: "Nothing crossed the flake threshold in the stored history. That is a count of observations, not a guarantee.",
            }),
      }),
      hooksPanel(trust.hooks),
    ),
  );
}

export function renderSource(ctx) {
  const { state } = ctx;
  const index = state.data.files;
  if (!index) return ctx.helpers.loadingOrError("source");
  const query = state.sourceQuery.trim().toLowerCase();
  const all = index.files.filter((f) => !query || f.path.toLowerCase().includes(query));
  const visible = all.slice(0, 600);
  const path = state.sourcePath ?? visible[0]?.path ?? null;
  const source = state.data.source && state.data.source.path === path ? state.data.source : null;
  const changed = source ? new Set(source.changedLines ?? []) : new Set();
  const unitStarts = new Map();
  if (source) for (const unit of source.units) unitStarts.set(unit.startLine, unit);
  const changedFiles = index.files.filter((f) => f.changed).length;
  const testFiles = index.files.filter((f) => f.test).length;

  const list = h(
    "div",
    { class: "list" },
    h("div", { class: "list__head" }, `${num(all.length)} files`),
    toolbar(
      h(
        "label",
        { style: "flex:1;display:flex;align-items:center;gap:7px;padding:0 10px" },
        icon("search", 13),
        h("input", {
          class: "input",
          type: "search",
          placeholder: "Filter files",
          value: state.sourceQuery,
          "data-search": "source",
          "aria-label": "Filter source files",
          onInput: (event) => ctx.actions.setSourceQuery(event.target.value),
        }),
      ),
    ),
    h(
      "div",
      { class: "list__scroll" },
      visible.map((file) =>
        h(
          "button",
          {
            class: "list__item",
            type: "button",
            "aria-current": String(file.path === path),
            onClick: () => ctx.actions.selectSource(file.path),
          },
          h(
            "span",
            { class: "list__name" },
            h("code", { title: file.path }, file.path),
            file.changed ? h("span", { class: "badge badge--changed" }, "changed") : null,
            file.test ? h("span", { class: "badge badge--test" }, "test") : null,
          ),
          h("span", { class: "list__file" }, file.test ? "test file" : "source file"),
        ),
      ),
    ),
    all.length > visible.length
      ? h(
          "p",
          { class: "hint", style: "padding:8px 12px" },
          `Showing the first ${num(visible.length)} of ${num(all.length)}. Filter to narrow the list.`,
        )
      : null,
  );

  const viewer = h(
    "div",
    { class: "source" },
    h(
      "div",
      { class: "source__head" },
      h("div", { class: "source__title" }, path ?? "No file"),
      source
        ? h(
            "div",
            { class: "source__meta" },
            h("span", null, source.language),
            h("span", null, `${num(source.lines.length)} lines`),
            source.traces
              ? h(
                  "span",
                  null,
                  `${num(source.traces.fresh)} fresh · ${num(source.traces.stale)} stale · ${num(source.traces.missing)} missing`,
                )
              : h("span", null, "no traces"),
          )
        : null,
    ),
    !source
      ? state.sourceLoading
        ? loading("Reading the file…")
        : empty({
            title: "Pick a file",
            body: "The source viewer shows only files in the analysed project.",
          })
      : !source.exists
        ? empty({
            title: "This file is not on disk",
            body:
              source.note ??
              "It was deleted or renamed by the current change. Its changed lines are still listed in the impact.",
          })
        : h(
            "div",
            { class: "source__body" },
            h(
              "div",
              { class: "code", "aria-label": `Source of ${source.path}` },
              source.lines.map((line) => {
                const unit = unitStarts.get(line.n);
                return h(
                  "div",
                  {
                    class: `code__line${changed.has(line.n) ? " code__line--changed" : ""}${unit ? " code__line--unit" : ""}${unit?.observedBy.length ? " code__line--observed" : ""}`,
                  },
                  h("span", { class: "code__n" }, line.n),
                  h("span", { class: "code__t" }, line.text || " "),
                );
              }),
            ),
          ),
    source?.note ? h("p", { class: "hint", style: "padding:0 14px 8px" }, source.note) : null,
    h(
      "div",
      { class: "source__legend" },
      h(
        "span",
        null,
        h("span", { class: "legend-swatch legend-swatch--changed" }),
        "changed by this diff",
      ),
      h(
        "span",
        null,
        h("span", { class: "legend-swatch legend-swatch--observed" }),
        "unit ran under a fresh trace",
      ),
      h("span", null, "a dot marks a unit start"),
    ),
  );

  return h(
    "div",
    { class: "screen" },
    screenHead({
      parts: ["source", `${num(index.files.length)} indexed files`, `${num(changedFiles)} changed`],
      title: "Source",
      finding: h(
        "span",
        null,
        h("strong", null, plural(changedFiles, "changed file")),
        " and ",
        h("strong", null, plural(testFiles, "test file")),
        " in the graph. Lines are marked only where the diff or a fresh trace proves something.",
      ),
      actions: [ctx.actions.refreshButton(), ctx.actions.runButton("affected")],
    }),
    h("div", { class: "split split--source", style: "margin-top:14px" }, list, viewer),
    source?.units.length
      ? section({
          title: "Units in this file",
          note: `${plural(source.units.length, "unit")} · ${num(source.units.filter((u) => u.observedBy.length).length)} observed`,
          body: h(
            "div",
            { class: "units" },
            source.units.map((unit) =>
              h(
                "div",
                { class: "unit-row", dataset: { changed: String(unit.changed) } },
                h(
                  "span",
                  { class: "unit-row__name" },
                  unit.name,
                  unit.unprotected
                    ? h("span", { class: "badge badge--warn" }, "unprotected")
                    : null,
                ),
                h(
                  "span",
                  { class: "unit-row__meta" },
                  `${unit.kind} · ${unit.startLine}–${unit.endLine}${unit.observedBy.length ? ` · ${num(unit.observedBy.length)} observed` : ""}`,
                ),
              ),
            ),
          ),
        })
      : null,
  );
}
