/**
 * The run drawer: one live run, streamed from `/api/stream`.
 */
import {
  clockTime,
  duration,
  h,
  icon,
  iconButton,
  num,
  plural,
  relativeTime,
  statusMark,
} from "./ui.js";

const ACTIVE = new Set(["queued", "analysing", "running"]);

export function isRunActive(run) {
  return !!run && ACTIVE.has(run.state) && !run.finishedAt;
}

/** Conservative label when the stream's summary verdict is not available (for example a reload). */
export function runVerdict(run) {
  if (!run) return null;
  if (run.integrityIssues?.length) return "incomplete";
  if (run.state === "cancelled") return "incomplete";
  if (!run.summary)
    return run.state === "failed" ? "error" : run.state === "done" ? "incomplete" : null;
  if (run.summary.cancelled) return "incomplete";
  if (run.executions.length < run.summary.selected) return "incomplete";
  if (run.summary.infrastructureErrors) return "error";
  if (run.summary.failed || run.summary.timedOut) return "failed";
  if (onlyCached(run.summary)) return "cached-pass";
  if (!run.summary.passed) return "no-tests";
  return "passed";
}

/**
 * One file's mark in the drawer. A file whose tests were all served from cache is "cached, not
 * run"; a file in which nothing passed and nothing was cached ran no test and is never "passed".
 */
export function runFileStatus(result) {
  if (result.failed || result.status === "failed") return "failed";
  if (result.status === "timed-out") return "timed-out";
  if (result.status === "cancelled") return "cancelled";
  if (result.error || result.status === "infrastructure-error") return "infrastructure-error";
  if (result.tests > 0 && result.cached === result.tests) return "cached-pass";
  if (!result.passed && !result.cached) return "skipped";
  return "passed";
}

/** True when a run "passed" only because every executed test was served from cache. */
export function onlyCached(summary) {
  return Boolean(summary && summary.cached > 0 && !summary.passed && !summary.failed);
}

function finishedMessage(verdict, summary) {
  if (verdict === "cached-pass" || (verdict === "passed" && onlyCached(summary)))
    return "No test ran: every selected test was served from cache";
  if (verdict === "no-tests")
    return summary?.selected
      ? "No test passed: every selected test was skipped"
      : "Nothing to run: the change selects no test";
  if (verdict === "passed" && summary?.cached)
    return `Run passed · ${num(summary.cached)} cached, not run`;
  if (verdict === "passed") return "Run passed";
  if (verdict === "failed") return "Run finished with failures";
  if (verdict === "error") return "Run hit infrastructure errors";
  if (verdict === "incomplete") return "Run finished without a complete result";
  return "Run finished";
}

export function scopeLabel(run) {
  if (run.scope === "file") return run.scopeFile ?? "one file";
  if (run.scope === "all") return "all tests";
  return "affected tests";
}

export function renderRun(ctx) {
  const { state } = ctx;
  const run = state.run;
  let root = document.getElementById("run");
  if (!root) {
    root = h("aside", {
      id: "run",
      class: "drawer",
      "aria-label": "Test run",
      dataset: { open: "false" },
    });
    document.body.appendChild(root);
  }
  const open = Boolean(state.runOpen && run);
  root.dataset.open = String(open);
  root.setAttribute("aria-hidden", open ? "false" : "true");
  if (open) root.removeAttribute("inert");
  else root.setAttribute("inert", "");
  if (!open) return;

  const active = isRunActive(run);
  const verdict = state.runVerdict ?? runVerdict(run);
  const phaseMessage =
    state.runPhase ??
    (active
      ? run.state === "analysing"
        ? "Selecting tests for the current change"
        : "Running tests"
      : run.error
        ? run.error.message
        : run.state === "cancelled"
          ? "Run cancelled"
          : finishedMessage(verdict, state.runSummary ?? run.summary));

  const children = [
    h(
      "div",
      { class: "drawer__head" },
      h(
        "div",
        { class: "drawer__text" },
        h(
          "p",
          { class: "drawer__title" },
          active ? "Running" : "Run",
          " ",
          h("span", { class: "drawer__id" }, run.id),
        ),
        h(
          "p",
          { class: "drawer__meta" },
          `${scopeLabel(run)} · ${run.mode} · ${run.source || "current change"}`,
        ),
      ),
      iconButton({
        name: "close",
        label: "Close run panel",
        fk: "run-close",
        onClick: () => ctx.actions.closeRun(),
      }),
    ),
  ];

  const body = h("div", { class: "drawer__body", "data-scroll": `run:${run.id}` });
  children.push(body);

  body.appendChild(
    h(
      "div",
      { class: "phase", dataset: { state: run.state, live: String(active) } },
      h("span", { class: "phase__dot", "aria-hidden": "true" }),
      h("span", { "aria-live": "polite" }, phaseMessage),
    ),
  );
  if (active) body.appendChild(h("div", { class: "progress", dataset: { live: "true" } }));

  const selection = state.runSelection;
  const selectedCount = selection?.selected ?? run.selected;
  const skippedCount = selection?.skipped ?? run.skippedBySelection;
  if (selectedCount || skippedCount || !active) {
    body.appendChild(
      h(
        "p",
        { class: "drawer__meta mb-8" },
        `${plural(selectedCount, "test file")} selected · ${num(skippedCount)} not run by selection`,
        selection ? ` · selection ${duration(selection.analysisMs)}` : "",
        selection ? ` · ${selection.analysisStatus}` : "",
      ),
    );
  }

  const groups = state.runGroups ?? [];
  if (groups.length) {
    body.appendChild(
      h(
        "div",
        { class: "groups", "aria-label": "Runner groups" },
        groups.map((group) =>
          h(
            "div",
            { class: "group-line" },
            h(
              "span",
              null,
              `${group.adapter} · ${group.dir || "."}${group.phase === "end" ? "" : " …"}`,
            ),
            h("span", null, plural(group.files.length, "file")),
          ),
        ),
      ),
    );
  }

  const results = state.runResults ?? [];
  if (results.length) {
    body.appendChild(
      h("p", { class: "drawer__meta drawer__section" }, `Files · ${num(results.length)}`),
    );
    body.appendChild(
      h(
        "div",
        { class: "run-files" },
        results.map((result) => {
          const status = runFileStatus(result);
          return h(
            "div",
            { class: "run-file" },
            h(
              "div",
              { class: "run-file__body" },
              h("div", { class: "run-file__path" }, result.file),
              h(
                "div",
                { class: "run-file__line" },
                statusMark(status),
                [
                  plural(result.tests, "test"),
                  `${num(result.passed)} passed`,
                  result.failed ? `${num(result.failed)} failed` : null,
                  result.cached ? `${num(result.cached)} cached` : null,
                  result.skipped ? `${num(result.skipped)} skipped` : null,
                  duration(result.durationMs),
                ]
                  .filter(Boolean)
                  .map((part) => h("span", { class: "run-file__meta" }, part)),
              ),
              result.failures?.length
                ? h(
                    "div",
                    { class: "run-file__error" },
                    result.failures
                      .slice(0, 3)
                      .map((failure) => `${failure.test}: ${failure.message}`)
                      .join("\n"),
                  )
                : null,
            ),
            h("span", { class: "run-file__meta" }, result.adapter),
          );
        }),
      ),
    );
  }

  if (run.error) {
    body.appendChild(
      h(
        "div",
        { class: "notice mt-12" },
        icon("warning", 14),
        h(
          "div",
          { class: "notice__body" },
          h("span", { class: "notice__label" }, run.error.code),
          h("p", null, run.error.message),
          run.error.hint ? h("p", { class: "mono" }, run.error.hint) : null,
        ),
      ),
    );
  }

  const summary = state.runSummary ?? run.summary;
  if (summary) {
    body.appendChild(
      h(
        "div",
        { class: "run-summary", "aria-label": "Run summary" },
        h("div", null, h("b", null, num(summary.executed)), h("span", null, "files reported")),
        h("div", null, h("b", null, num(summary.passed)), h("span", null, "tests passed")),
        h("div", null, h("b", null, num(summary.cached)), h("span", null, "tests cached")),
        h(
          "div",
          null,
          h("b", null, num(summary.failed + summary.timedOut)),
          h("span", null, "tests failed"),
        ),
      ),
    );
    body.appendChild(
      h(
        "p",
        { class: "drawer__meta mt-8" },
        `${plural(summary.totalTests, "test")} discovered · ${summary.skippedBySelection} not run by selection · ${duration(summary.durationMs)}`,
      ),
    );
    if (summary.cached)
      body.appendChild(
        h("p", { class: "drawer__meta mt-4" }, "Cached results were not executed in this run."),
      );
    if (summary.skippedByTests)
      body.appendChild(
        h(
          "p",
          { class: "drawer__meta mt-4" },
          `${plural(summary.skippedByTests, "test")} skipped inside the test files — skipped, not passed.`,
        ),
      );
  }

  if (run.integrityIssues?.length)
    body.appendChild(
      h(
        "div",
        { class: "notice mt-12" },
        icon("warning", 14),
        h(
          "div",
          { class: "notice__body" },
          h("span", { class: "notice__label" }, "Report integrity"),
          run.integrityIssues.map((issue) => h("p", null, issue)),
        ),
      ),
    );

  const foot = h("div", { class: "drawer__foot" });
  if (active) {
    foot.appendChild(
      h("span", { class: "drawer__meta" }, `started ${relativeTime(run.startedAt)}`),
    );
    foot.appendChild(
      h(
        "button",
        {
          class: "btn btn--small",
          type: "button",
          "data-fk": "run-cancel",
          onClick: () => ctx.actions.cancelRun(),
        },
        icon("stop", 12),
        h("span", null, "Cancel"),
      ),
    );
  } else {
    foot.appendChild(
      h(
        "span",
        { class: "drawer__meta" },
        run.finishedAt ? `finished ${clockTime(run.finishedAt)}` : `state ${run.state}`,
      ),
    );
    foot.appendChild(
      h(
        "div",
        { class: "drawer__actions" },
        run.scope === "affected" || run.scope === "all"
          ? h(
              "button",
              { class: "btn btn--small", type: "button", onClick: () => ctx.actions.runAgain() },
              icon("play", 12),
              h("span", null, "Run again"),
            )
          : null,
        h(
          "button",
          { class: "btn btn--small", type: "button", onClick: () => ctx.navigate("/tests") },
          h("span", null, "Open tests"),
        ),
      ),
    );
  }
  children.push(foot);

  root.replaceChildren(...children);
}
