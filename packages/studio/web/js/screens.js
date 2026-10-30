/**
 * Overview and Impact screens. Both read the same snapshot as the server, so the strip on the
 * overview and the detail behind a row can never disagree about a count.
 */
import { onlyCached, runVerdict, scopeLabel } from "./run.js";
import {
  duration,
  empty,
  eyebrow,
  filePath,
  h,
  icon,
  num,
  pct,
  plural,
  relativeTime,
  selectionMark,
  statusMark,
} from "./ui.js";

export function screenHead({ parts, title, finding, actions = [] }) {
  return h(
    "header",
    { class: "title-row" },
    h(
      "div",
      { class: "title-row__text" },
      eyebrow(...parts),
      h("h1", null, title),
      finding ? h("p", { class: "finding" }, finding) : null,
    ),
    actions.length ? h("div", { class: "title-actions" }, actions) : null,
  );
}

export function facts(items) {
  return h(
    "div",
    { class: "facts" },
    items.map((item) =>
      h(
        "div",
        { class: "fact" },
        h("span", { class: "fact__label" }, item.label),
        h(
          "span",
          { class: "fact__value" },
          item.value,
          item.small ? h("small", null, item.small) : null,
        ),
        h(
          "span",
          { class: "fact__note", ...(item.tone ? { dataset: { tone: item.tone } } : {}) },
          item.note,
        ),
      ),
    ),
  );
}

export function panel({ title, note, body, raised = false }) {
  return h(
    "section",
    { class: `panel${raised ? " panel--raised" : ""}` },
    h(
      "div",
      { class: "panel__head" },
      h("h2", { class: "panel__title" }, title),
      note ? h("span", { class: "panel__note" }, note) : null,
    ),
    body,
  );
}

export function section({ title, note, body }) {
  return h(
    "section",
    { class: "section" },
    h(
      "div",
      { class: "section__head" },
      h("h2", { class: "section__title" }, title),
      note ? h("span", { class: "section__note" }, note) : null,
    ),
    body,
  );
}

function notice(title, lines, tone = "warn") {
  return h(
    "div",
    { class: "notice", dataset: { tone } },
    icon(tone === "warn" ? "warning" : "chevron", 14),
    h(
      "div",
      { class: "notice__body" },
      h("span", { class: "notice__label" }, title),
      lines.filter(Boolean).map((line) => h("p", null, line)),
    ),
  );
}

export function runStatusMark(run) {
  if (!run) return statusMark("skipped", { text: "no run" });
  const verdict = runVerdict(run) ?? "incomplete";
  if (verdict === "cached-pass" || (verdict === "passed" && onlyCached(run.summary)))
    return statusMark("cached-pass", { text: "cached, not run" });
  if (verdict === "no-tests") return statusMark("skipped", { text: "no test ran" });
  if (verdict === "passed") return statusMark("passed", { text: "passed" });
  if (verdict === "failed") return statusMark("failed", { text: "failed" });
  if (verdict === "error") return statusMark("infrastructure-error", { text: "infra error" });
  return statusMark("skipped", { text: "incomplete" });
}

/** Data objects already drawn once: rows animate in on arrival, not on every re-render. */
const drawn = new WeakSet();

export function firstDraw(data) {
  if (!data || drawn.has(data)) return false;
  drawn.add(data);
  return true;
}

/** Search text per selection reason, joined once per loaded impact rather than per render. */
const reasonText = new WeakMap();

function hayOf(reason) {
  let hay = reasonText.get(reason);
  if (hay === undefined) {
    hay = `${reason.message} ${(reason.path ?? []).join(" ")}`;
    reasonText.set(reason, hay);
  }
  return hay;
}

function reasonTouches(reasons, file, unit) {
  const base = unit.includes(".") ? unit.slice(unit.lastIndexOf(".") + 1) : unit;
  for (const reason of reasons) {
    const hay = hayOf(reason);
    if (unit && (hay.includes(unit) || (base.length > 3 && hay.includes(base)))) return true;
    if (hay.includes(file)) return true;
  }
  return false;
}

function chain(nodes) {
  const unique = [...new Set(nodes.filter(Boolean))];
  const out = [];
  unique.forEach((node, index) => {
    if (index) out.push(h("span", { class: "chain__arrow", "aria-hidden": "true" }, "→"));
    const last = index === unique.length - 1 && unique.length > 1;
    out.push(
      h("span", { class: `chain__node${last ? " chain__node--test" : ""}`, title: node }, node),
    );
  });
  return out;
}

/** Derived rows per impact object; a reload replaces the object, which drops the cache. */
const stripCache = new WeakMap();
const impactTestsCache = new WeakMap();

function stripRows(impact) {
  let rows = stripCache.get(impact);
  if (!rows) {
    rows = buildStripRows(impact);
    stripCache.set(impact, rows);
  }
  return rows;
}

function buildStripRows(impact) {
  const rows = [];
  const selected = impact.selected ?? [];
  for (const file of impact.change.files ?? []) {
    const units = file.units?.length ? file.units : [];
    for (const unit of units) {
      const matches = selected.filter((test) => reasonTouches(test.reasons, file.path, unit));
      if (matches.length) {
        for (const test of matches.slice(0, 4))
          rows.push({ file, unit, kind: file.kinds[0] ?? "changed", test });
      } else {
        const unprotected = (impact.unprotected ?? []).some(
          (entry) => entry.file === file.path && entry.unit === unit,
        );
        rows.push({ file, unit, kind: file.kinds[0] ?? "changed", test: null, unprotected });
      }
      if (rows.length >= 140) return rows;
    }
    if (!units.length) {
      const matches = selected.filter((test) =>
        test.reasons.some((reason) => hayOf(reason).includes(file.path)),
      );
      for (const test of matches.slice(0, 3))
        rows.push({ file, unit: null, kind: file.kinds[0] ?? "changed", test });
    }
  }
  return rows;
}

function impactStrip(ctx) {
  const { state } = ctx;
  const impact = state.data.impact;
  const rows = stripRows(impact);
  if (!impact.change.files.length)
    return h(
      "div",
      { class: "strip" },
      h(
        "div",
        { class: "strip__empty" },
        empty({
          title: "No change to analyse",
          body: "SmartTest found no uncommitted, staged or branch change in this repository. Edit a file, then refresh.",
        }),
      ),
    );
  if (!rows.length)
    return h(
      "div",
      { class: "strip" },
      h(
        "div",
        { class: "strip__empty" },
        empty({
          title: "This change reaches no test file",
          body: `${plural(impact.counts.files, "file")} changed, but no test depends on a changed unit. That is a zero, not a failure — and not proof of safety if the change is in a test helper the graph could not resolve.`,
        }),
      ),
    );
  const animate = firstDraw(impact);
  return h(
    "div",
    { class: "strip", "aria-label": "Impact strip: changed units and the tests they reach" },
    h(
      "div",
      { class: "strip__head", "aria-hidden": "true" },
      h("span", null, "Changed unit"),
      h("span", null, "Path through the graph"),
      h("span", { class: "strip__head-test" }, "Test"),
      h("span", { class: "strip__head-state" }, "Selection"),
    ),
    h(
      "div",
      { class: "strip__body", "data-scroll": "strip" },
      rows.map((row, index) => {
        const reason = row.test?.reasons[0];
        const pathNodes = reason?.path?.length
          ? reason.path
          : row.test
            ? [row.file.path, row.test.filePath]
            : [row.file.path];
        const unitName = !row.unit || row.unit === "*" ? "whole file" : row.unit;
        return h(
          "button",
          {
            class: `strip__row${row.test ? "" : " strip__row--unreached"}${animate ? " row-enter" : ""}`,
            type: "button",
            "data-fk": `strip:${index}`,
            ...(animate ? { vars: { "--i": String(Math.min(index, 18)) } } : {}),
            "aria-current": String(ctx.state.impactFile === row.file.path),
            onClick: () =>
              row.test
                ? ctx.actions.openImpact(row.file.path, row.test.filePath)
                : ctx.actions.openImpact(row.file.path, null),
          },
          h(
            "span",
            { class: "strip__unit" },
            h(
              "span",
              { class: "strip__unit-name" },
              h("code", null, unitName),
              h("span", { class: "strip__kind" }, row.kind),
            ),
            filePath(row.file.path),
          ),
          h("span", { class: "chain" }, chain(pathNodes.slice(0, 5))),
          h(
            "span",
            { class: "strip__test" },
            row.test
              ? [
                  filePath(row.test.filePath),
                  reason?.confidence ? h("span", { class: "badge" }, reason.confidence) : null,
                ]
              : h("span", { class: "badge" }, row.unprotected ? "no protected unit" : "no path"),
          ),
          h(
            "span",
            { class: "strip__state" },
            row.test ? selectionMark("selected") : selectionMark("skipped"),
          ),
        );
      }),
    ),
  );
}

function findingFor(impact) {
  if (!impact.change.files.length) return "No change in this repository right now.";
  const selected = impact.counts.selected;
  const files = impact.counts.files;
  const unprotected = impact.counts.unprotected;
  return h(
    "span",
    null,
    "This change touches ",
    h("strong", null, plural(files, "file")),
    " and ",
    h("strong", null, plural(impact.counts.units, "unit")),
    ". ",
    selected
      ? h(
          "span",
          null,
          `${plural(selected, "test file")} selected; ${plural(impact.counts.skipped, "test file")} not run by selection.`,
        )
      : h("span", null, "No test file is selected by the graph."),
    unprotected
      ? h(
          "span",
          null,
          ` ${plural(unprotected, "changed unit")} ${unprotected === 1 ? "has" : "have"} no protecting test.`,
        )
      : null,
  );
}

export function renderOverview(ctx) {
  const { state } = ctx;
  const overview = state.data.overview;
  if (!overview) return ctx.helpers.loadingOrError("overview");

  const traces = overview.traces;
  const actions = [ctx.actions.refreshButton(), ctx.actions.runButton("affected")];

  const last = overview.lastRun;
  const lastSummary = last?.summary ?? null;
  const runPanel = panel({
    title: "Last run",
    note: last ? `${scopeLabel(last)} · ${last.mode}` : "none on disk",
    raised: true,
    body: last
      ? h(
          "div",
          { class: "detail__body" },
          h(
            "div",
            { class: "run-head" },
            h(
              "div",
              null,
              runStatusMark(last),
              h(
                "p",
                { class: "detail__meta" },
                `${relativeTime(last.finishedAt ?? last.startedAt)} · ${duration(lastSummary?.durationMs)}`,
              ),
            ),
            h(
              "button",
              {
                class: "btn btn--small",
                type: "button",
                onClick: () => ctx.actions.openRun(last),
              },
              h("span", null, "Open run"),
            ),
          ),
          lastSummary
            ? h(
                "div",
                { class: "run-summary" },
                h(
                  "div",
                  null,
                  h("b", null, num(lastSummary.selected)),
                  h("span", null, "selected"),
                ),
                h("div", null, h("b", null, num(lastSummary.passed)), h("span", null, "passed")),
                h(
                  "div",
                  null,
                  h("b", null, num(lastSummary.failed + lastSummary.timedOut)),
                  h("span", null, "failed"),
                ),
                h("div", null, h("b", null, num(lastSummary.cached)), h("span", null, "cached")),
              )
            : h("p", { class: "hint mt-8" }, "The report has no summary."),
          lastSummary
            ? h(
                "p",
                { class: "detail__meta mt-8" },
                `${num(lastSummary.skippedBySelection)} not run by selection · ${num(lastSummary.skippedByTests)} skipped inside test files`,
              )
            : null,
          last.integrityIssues?.length ? notice("Report integrity", last.integrityIssues) : null,
        )
      : h(
          "div",
          { class: "detail__body" },
          empty({
            title: "No run recorded yet",
            body: "The impact above comes from analysis alone. Run the affected tests to see real results.",
            actions: [ctx.actions.runButton("affected")],
          }),
        ),
  });

  const notices = [];
  if (overview.analysis.fallbackApplied || overview.analysis.status !== "complete")
    notices.push(
      notice("Analysis is not complete", [
        `Status ${overview.analysis.status}${overview.analysis.requestedMode ? ` · requested ${overview.analysis.requestedMode}` : ""}.`,
        ...(overview.analysis.warnings ?? []).slice(0, 3),
        "Selection may be broader than needed; it is never narrower without saying so.",
      ]),
    );
  if (overview.cache.integrityIssues.length)
    notices.push(notice("Cache integrity", overview.cache.integrityIssues.slice(0, 4)));
  if (traces.available && (traces.stale || traces.missing))
    notices.push(
      notice(
        "Trace coverage",
        [
          `${num(traces.fresh)} fresh, ${num(traces.stale)} stale, ${num(traces.missing)} never traced, out of ${num(traces.tests)} test files.`,
          traces.stale
            ? "Stale traces are ignored for selection; refresh them before trusting a narrow selection."
            : null,
        ],
        "info",
      ),
    );
  if (overview.uncertainty)
    notices.push(
      notice(
        "Unresolved relationships",
        [
          `${plural(overview.uncertainty, "file")} contain relationships SmartTest could not resolve. Those tests are selected, not skipped.`,
        ],
        "info",
      ),
    );

  const traceNote = traces.available
    ? `${num(traces.fresh)}/${num(traces.tests)} fresh`
    : "no traces";

  return h(
    "div",
    { class: "screen" },
    screenHead({
      parts: [overview.project.name, overview.project.vcs, `${overview.analysis.mode} mode`],
      title: "Overview",
      finding: findingFor(overview),
      actions,
    }),
    facts([
      {
        label: "Changed files",
        value: num(overview.counts.files),
        note: overview.change.description || "no change detected",
      },
      {
        label: "Affected units",
        value: num(overview.counts.units),
        note: overview.counts.units
          ? `${num(overview.counts.unprotected)} without a protecting test`
          : "nothing changed",
        tone: overview.counts.unprotected ? "warn" : undefined,
      },
      {
        label: "Selected tests",
        value: num(overview.counts.selected),
        small: `of ${num(overview.counts.total)}`,
        note: `${num(overview.counts.skipped)} not run by selection`,
      },
      {
        label: "Selection confidence",
        value: traceNote,
        note: traces.available
          ? `${num(traces.stale)} stale · ${num(traces.missing)} never traced`
          : "run trace --all to collect evidence",
        tone: traces.stale ? "warn" : undefined,
      },
    ]),
    notices,
    impactStrip(ctx),
    section({
      title: "Result and evidence",
      note: `analysed ${relativeTime(overview.updatedAt)} · ${duration(overview.analysis.analysisMs)}`,
      body: h(
        "div",
        { class: "split split--even" },
        runPanel,
        panel({
          title: "Evidence",
          note: "what selection rests on",
          body: h(
            "div",
            { class: "detail__body" },
            h(
              "div",
              { class: "facts facts--panel" },
              h(
                "div",
                { class: "fact" },
                h("span", { class: "fact__label" }, "Fresh traces"),
                h("span", { class: "fact__value" }, num(traces.fresh)),
              ),
              h(
                "div",
                { class: "fact" },
                h("span", { class: "fact__label" }, "Stale traces"),
                h("span", { class: "fact__value" }, num(traces.stale)),
              ),
              h(
                "div",
                { class: "fact" },
                h("span", { class: "fact__label" }, "Flaky tests"),
                h("span", { class: "fact__value" }, num(overview.flaky.count)),
              ),
              h(
                "div",
                { class: "fact" },
                h("span", { class: "fact__label" }, "Cached results"),
                h("span", { class: "fact__value" }, num(overview.cache.lastCached)),
              ),
            ),
            overview.flaky.worst
              ? h(
                  "p",
                  { class: "detail__meta mt-12" },
                  `Worst flake: ${overview.flaky.worst.testId} · ${pct(overview.flaky.worst.rate * 100, 100)} · ${overview.flaky.worst.recent}`,
                )
              : null,
          ),
        }),
      ),
    }),
    overview.topSelected.length
      ? section({
          title: "First selected tests",
          note: "the nearest reachable tests, not a ranking",
          body: h(
            "div",
            { class: "list" },
            overview.topSelected.map((test) =>
              h(
                "button",
                {
                  class: "list__item",
                  type: "button",
                  onClick: () =>
                    ctx.actions.openImpact(overview.change.files[0]?.path ?? null, test.filePath),
                },
                h(
                  "span",
                  { class: "list__name" },
                  h("code", null, test.filePath),
                  test.confidence ? h("span", { class: "list__count" }, test.confidence) : null,
                ),
                h("span", { class: "list__file" }, test.reason),
              ),
            ),
          ),
        })
      : null,
  );
}

function impactTests(impact, filePath) {
  let byFile = impactTestsCache.get(impact);
  if (!byFile) {
    byFile = new Map();
    impactTestsCache.set(impact, byFile);
  }
  let tests = byFile.get(filePath);
  if (!tests) {
    tests = buildImpactTests(impact, filePath);
    byFile.set(filePath, tests);
  }
  return tests;
}

function buildImpactTests(impact, filePath) {
  const direct = impact.selected.filter((test) =>
    test.reasons.some((reason) => reasonTouches([reason], filePath, "")),
  );
  if (direct.length) return direct;
  return impact.selected.filter((test) =>
    test.reasons.some((reason) =>
      `${(reason.path ?? []).join(" ")} ${reason.message}`.includes(filePath),
    ),
  );
}

function codePeek(ctx, filePath) {
  const source = stateSource(ctx.state, filePath);
  if (!source)
    return h(
      "p",
      { class: "hint mt-8" },
      sourceLoading(ctx.state, filePath) ? "Reading the file…" : "No code preview for this file.",
    );
  if (!source.exists)
    return h("p", { class: "hint mt-8" }, "This file is not on disk — it was deleted or renamed.");
  const changed = new Set(source.changedLines ?? []);
  const first = [...changed].sort((a, b) => a - b)[0] ?? 1;
  const start = Math.max(1, first - 5);
  const lines = source.lines.filter((line) => line.n >= start && line.n < start + 16);
  if (!lines.length) return h("p", { class: "hint mt-8" }, "No lines to show.");
  return h(
    "div",
    { class: "code-peek", "aria-label": `Code around the change in ${filePath}` },
    lines.map((line) =>
      h(
        "div",
        { class: `code-peek__line${changed.has(line.n) ? " code-peek__line--changed" : ""}` },
        h("span", { class: "code-peek__n" }, line.n),
        h("span", { class: "code-peek__t" }, line.text || " "),
      ),
    ),
  );
}

export function stateSource(state, filePath) {
  const source = state.data.impactSource;
  return source && source.path === filePath ? source : null;
}

export function sourceLoading(state, filePath) {
  return state.impactSourcePath === filePath;
}

function reasonBlock(reason) {
  return h(
    "div",
    { class: "reason" },
    h(
      "div",
      { class: "reason__head" },
      h("span", { class: "reason__kind" }, reason.kind),
      reason.confidence ? h("span", { class: "reason__conf" }, reason.confidence) : null,
      reason.ruleName ? h("span", { class: "badge" }, reason.ruleName) : null,
    ),
    h("p", { class: "reason__message" }, reason.message),
    reason.path?.length
      ? h(
          "div",
          { class: "reason__path" },
          reason.path.map((node, index) => [
            index ? h("span", { class: "reason__arrow", "aria-hidden": "true" }, "→") : null,
            h(
              "span",
              {
                class: `reason__node${index === reason.path.length - 1 ? " reason__node--test" : ""}`,
              },
              node,
            ),
          ]),
        )
      : null,
  );
}

export function renderImpact(ctx) {
  const { state } = ctx;
  const impact = state.data.impact;
  if (!impact) return ctx.helpers.loadingOrError("impact");
  const files = impact.change.files ?? [];
  const selectedPath =
    state.impactFile && files.some((f) => f.path === state.impactFile)
      ? state.impactFile
      : (files[0]?.path ?? null);
  const file = files.find((f) => f.path === selectedPath) ?? null;
  const tests = file ? impactTests(impact, file.path) : [];
  const selectedTest = state.impactTest;

  const head = screenHead({
    parts: [impact.change.provider, impact.change.completeness, impact.analysis.mode],
    title: "Impact",
    finding: h(
      "span",
      null,
      impact.change.description ? `${impact.change.description}. ` : "",
      h("strong", null, plural(files.length, "changed file")),
      files.length === 1 ? " reaches " : " reach ",
      h("strong", null, plural(impact.counts.selected, "test file")),
      "; ",
      h("strong", null, plural(impact.counts.skipped, "test file")),
      " not run by selection.",
    ),
    actions: [ctx.actions.refreshButton(), ctx.actions.runButton("affected")],
  });

  if (!files.length)
    return h(
      "div",
      { class: "screen" },
      head,
      empty({
        title: "No change to explain",
        body: "The graph is ready, but there is no changed file to trace. Once a file changes, this screen shows every edge that reaches a test.",
        actions: [ctx.actions.refreshButton()],
      }),
    );

  const list = h(
    "div",
    { class: "list" },
    h("div", { class: "list__head" }, `Changed files · ${num(files.length)}`),
    h(
      "div",
      { class: "list__scroll", "data-scroll": "impact-files" },
      files.map((changedFile) =>
        h(
          "button",
          {
            class: "list__item",
            type: "button",
            "data-fk": `impact:${changedFile.path}`,
            "aria-current": String(changedFile.path === selectedPath),
            onClick: () => ctx.actions.selectImpactFile(changedFile.path),
          },
          h(
            "span",
            { class: "list__name" },
            h("code", { title: changedFile.path }, changedFile.path),
            h("span", { class: "list__count" }, plural(changedFile.units.length, "unit")),
          ),
          h(
            "span",
            { class: "list__file" },
            `${changedFile.previousPath ? `renamed from ${changedFile.previousPath}` : changedFile.type}${changedFile.trivialOnly ? " · whitespace only" : ""}${changedFile.confidence ? ` · ${changedFile.confidence}` : ""}`,
          ),
        ),
      ),
    ),
  );

  const detailBody = h("div", { class: "detail__body" });
  if (!file) {
    detailBody.appendChild(
      empty({
        title: "Pick a changed file",
        body: "Its units and the tests that reach them appear here.",
      }),
    );
  } else {
    if (file.units.length) {
      detailBody.appendChild(
        h(
          "div",
          { class: "units" },
          h("p", { class: "fact__label units__label" }, "Changed units"),
          file.units.map((unit) =>
            h(
              "div",
              { class: "unit-row", dataset: { changed: "true" } },
              h("span", { class: "unit-row__name" }, unit),
              h(
                "span",
                { class: "unit-row__meta" },
                impact.unprotected.some((u) => u.file === file.path && u.unit === unit)
                  ? "no protecting test"
                  : "protected",
              ),
            ),
          ),
        ),
      );
    } else {
      detailBody.appendChild(
        h(
          "p",
          { class: "hint mb-8" },
          file.trivialOnly
            ? "Only whitespace or formatting changed, so no unit is named."
            : "No named unit was extracted from this diff.",
        ),
      );
    }
    detailBody.appendChild(
      section({
        title: selectedTest ? `Why ${selectedTest.split("::")[0]} runs` : "Why these tests run",
        note: selectedTest ? "selected test" : `${num(tests.length)} selected`,
        body: tests.length
          ? h(
              "div",
              null,
              tests
                .filter((test) => !selectedTest || test.filePath === selectedTest)
                .map((test) =>
                  h(
                    "div",
                    { class: "impact-test" },
                    h(
                      "p",
                      { class: "detail__title" },
                      test.filePath,
                      h(
                        "span",
                        { class: "detail__meta" },
                        ` · ${plural(test.depth, "node", "nodes")} from the change`,
                      ),
                    ),
                    test.reasons.map(reasonBlock),
                  ),
                ),
            )
          : empty({
              title: "No selected test reaches this file",
              body: "A changed file can be real and still reach no test. Treat that as a gap to inspect, not as safety.",
            }),
      }),
    );
    detailBody.appendChild(
      section({
        title: "Code at the change",
        note: file.addedLines?.length
          ? plural(file.addedLines.length, "marked line")
          : "no added lines",
        body: codePeek(ctx, file.path),
      }),
    );
  }

  const notRun = section({
    title: "Not run, by reason",
    note: `${num(impact.counts.skipped)} test files`,
    body: impact.skippedGroups.length
      ? h(
          "div",
          { class: "list" },
          impact.skippedGroups.map((group) =>
            h(
              "div",
              { class: "list__item list__item--static" },
              h(
                "span",
                { class: "list__name" },
                h("code", null, group.reason),
                h("span", { class: "list__count" }, num(group.count)),
              ),
            ),
          ),
        )
      : empty({
          title: "Every discovered test is selected",
          body: "Nothing was left out by the graph for this change.",
        }),
  });

  const riskLines = [];
  if (impact.analysis.status !== "complete")
    riskLines.push(
      `Analysis status ${impact.analysis.status}; warnings: ${impact.analysis.warnings.join("; ") || "none"}`,
    );
  for (const item of impact.uncertainty ?? [])
    riskLines.push(`${item.file}: ${item.reasons.join("; ")}`);
  for (const item of impact.observedSkips ?? [])
    riskLines.push(`${item.test} skipped a traced unit last seen ${relativeTime(item.tracedAt)}`);

  return h(
    "div",
    { class: "screen" },
    head,
    riskLines.length ? notice("Unresolved or observed risk", riskLines.slice(0, 6), "info") : null,
    h(
      "div",
      { class: "split split--impact split--spaced" },
      h("div", { class: "impact-side" }, list, notRun),
      h(
        "div",
        { class: "detail" },
        h(
          "div",
          { class: "detail__head" },
          h(
            "div",
            { class: "detail__title" },
            file?.path ?? "No file",
            file
              ? h(
                  "p",
                  { class: "detail__meta" },
                  `${file.previousPath ? `renamed from ${file.previousPath}` : file.type} · ${file.kinds.join(", ") || "no kind"} · ${file.confidence}`,
                )
              : null,
          ),
          file
            ? h(
                "button",
                {
                  class: "btn btn--small",
                  type: "button",
                  "data-fk": "impact-open-source",
                  onClick: () => ctx.navigate(`/source?path=${encodeURIComponent(file.path)}`),
                },
                h("span", null, "Open source"),
              )
            : null,
        ),
        detailBody,
      ),
    ),
  );
}
