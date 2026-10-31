/**
 * Studio's shell: pairing, routing, data loading, the one live run, and keyboard access.
 * The screens themselves live in screens.js and screens-b.js; both receive this context.
 */
import { isRunActive, renderRun, runVerdict } from "./run.js";
import { renderImpact, renderOverview } from "./screens.js";
import { filteredTests, renderSource, renderTests, renderTrust } from "./screens-b.js";
import {
  announce,
  button,
  download,
  empty,
  h,
  icon,
  iconButton,
  loading,
  openDialog,
  replace,
  toast,
  toCsv,
} from "./ui.js";

const TOKEN_KEY = "smarttest.studio.token";
const THEME_KEY = "smarttest.studio.theme";
const KEYS_KEY = "smarttest.studio.singleKeyShortcuts";
const app = document.getElementById("app");

const state = {
  token: null,
  session: null,
  data: {
    overview: null,
    impact: null,
    tests: null,
    trust: null,
    files: null,
    source: null,
    impactSource: null,
  },
  loading: new Set(),
  errors: new Map(),
  refreshing: false,
  testsTab: "all",
  testsQuery: "",
  sourceQuery: "",
  sourcePath: null,
  sourceLoading: false,
  impactFile: null,
  impactTest: null,
  impactSourcePath: null,
  run: null,
  runOpen: false,
  runVerdict: null,
  runPhase: null,
  runSelection: null,
  runGroups: [],
  runResults: [],
  runSummary: null,
};

let shell = null;
let streamStop = null;
let reloadTimer = null;
let sourceRequest = 0;
let renderFrame = 0;
let queryTimer = null;
/** Files already in `state.runResults` for the open run, so each streamed result is O(1). */
let runSeen = new Set();
/** How to find the control that opened the run drawer again after a re-render. */
let runOpener = null;

const QUERY_DEBOUNCE_MS = 120;

const ctx = { state, actions: null, navigate, helpers: { loadingOrError } };

const actions = {
  refreshButton: () =>
    button({
      label: state.refreshing ? "Refreshing…" : "Refresh",
      iconName: "refresh",
      size: "btn--small",
      disabled: state.refreshing,
      fk: "refresh",
      onClick: refresh,
    }),
  runButton: (scope = "affected", { fk = `run-${scope}` } = {}) =>
    button({
      label: scope === "all" ? "Run all" : "Run affected",
      iconName: "play",
      variant: "btn--primary",
      size: "btn--small",
      shortcut: scope === "affected" ? "r" : null,
      disabled: isRunActive(state.run),
      fk,
      onClick: () => run(scope),
    }),
  refresh,
  load: (view, force = true) => load(view, { force }),
  run,
  runAgain: () => {
    if (!state.run) return;
    void run(state.run.scope, state.run.scopeFile ?? undefined);
  },
  cancelRun,
  closeRun,
  openRun: (runData) => {
    rememberRunOpener();
    state.run = runData;
    state.runOpen = true;
    state.runVerdict = null;
    state.runPhase = null;
    state.runSelection = null;
    state.runGroups = [];
    setRunResults(runData.executions ?? []);
    state.runSummary = runData.summary;
    render();
    focusRunDrawer();
  },
  selectImpactFile: (path) => {
    state.impactFile = path;
    state.impactTest = null;
    void loadImpactSource(path);
    render();
  },
  openImpact: (file, test) => {
    state.impactFile = file;
    state.impactTest = test;
    if (file) void loadImpactSource(file);
    if (currentRoute().view !== "impact") navigate("/impact");
    else render();
  },
  openSource: (path) => {
    state.sourcePath = path;
    navigate(`/source?path=${encodeURIComponent(path)}`);
  },
  selectSource: (path) => {
    state.sourcePath = path;
    // Keep the address in step, so a background reload (which reads ?path=) and a page reload
    // both stay on the file the reader picked.
    history.replaceState(null, "", `/source?path=${encodeURIComponent(path)}`);
    void loadSource(path);
    render();
  },
  setSourceQuery: (value) => {
    state.sourceQuery = value;
    renderSoon();
  },
  selectTestsTab: (id) => {
    state.testsTab = id;
    render();
  },
  setTestsQuery: (value, { immediate = false } = {}) => {
    state.testsQuery = value;
    if (immediate) render();
    else renderSoon();
  },
  exportTests,
  toggleTheme,
  shortcuts,
};
ctx.actions = actions;

// ── Token and theme ────────────────────────────────────────────────────────────────────────

function normalizeToken(input) {
  const text = input.trim();
  if (!text) return "";
  if (text.includes("#token=")) return text.slice(text.indexOf("#token=") + 7).split(/[&#]/)[0];
  if (text.startsWith("http://") || text.startsWith("https://")) {
    try {
      const url = new URL(text);
      return new URLSearchParams(url.hash.slice(1)).get("token") ?? "";
    } catch {
      return "";
    }
  }
  return text.split(/[&#\s]/)[0];
}

function readToken() {
  const fromHash = new URLSearchParams(location.hash.replace(/^#/, "")).get("token");
  if (fromHash) {
    try {
      sessionStorage.setItem(TOKEN_KEY, fromHash);
    } catch {
      /* storage can be unavailable; the fragment still works for this page */
    }
    history.replaceState(null, "", `${location.pathname}${location.search}`);
    return fromHash;
  }
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function storeToken(token) {
  state.token = token;
  try {
    sessionStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* in-memory token is still enough */
  }
}

function forgetToken() {
  state.token = null;
  try {
    sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* nothing to remove */
  }
}

function theme() {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

function toggleTheme() {
  const next = theme() === "light" ? "dark" : "light";
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    /* theme is still applied for this page */
  }
  render();
}

// ── API and stream ─────────────────────────────────────────────────────────────────────────

async function api(path, { method = "GET", body } = {}) {
  const headers = { "x-smarttest-token": state.token ?? "" };
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(path, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    cache: "no-store",
    credentials: "same-origin",
  });
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }
  if (!response.ok) {
    const detail = payload?.error ?? {};
    const error = new Error(detail.message ?? `Studio returned ${response.status}`);
    error.code = detail.code ?? `HTTP_${response.status}`;
    error.hint = detail.hint ?? null;
    error.status = response.status;
    throw error;
  }
  return payload;
}

function handleApiError(error, { quiet = false } = {}) {
  if (!error) return false;
  if (error.code === "ST_STUDIO_TOKEN") {
    forgetToken();
    renderPairing(
      "That session token is missing or no longer valid. Reopen the URL printed by smarttest studio.",
    );
    return true;
  }
  if (!quiet) toast(error.message ?? "The request failed", "fail");
  return false;
}

function scheduleReload() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    if (state.refreshing) return;
    const view = currentRoute().view;
    void load(view, { force: true, quiet: true });
  }, 650);
}

function parseStreamBlock(block) {
  const data = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data) return null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function connectStream() {
  streamStop?.();
  let stopped = false;
  streamStop = () => {
    stopped = true;
  };
  void (async () => {
    while (!stopped && state.token) {
      try {
        const response = await fetch("/api/stream", {
          headers: { "x-smarttest-token": state.token },
          cache: "no-store",
          credentials: "same-origin",
        });
        if (!response.ok) {
          const error = new Error(`Stream returned ${response.status}`);
          error.code = response.status === 401 ? "ST_STUDIO_TOKEN" : `HTTP_${response.status}`;
          throw error;
        }
        // Events sent while the stream was down are lost: catch up on an active run.
        if (state.run && isRunActive(state.run)) void resyncRun(state.run.id);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (!stopped) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let split = buffer.indexOf("\n\n");
          while (split >= 0) {
            const block = buffer.slice(0, split);
            buffer = buffer.slice(split + 2);
            const event = parseStreamBlock(block);
            if (event) applyStreamEvent(event);
            split = buffer.indexOf("\n\n");
          }
        }
      } catch (error) {
        if (stopped) return;
        if (handleApiError(error)) return;
      }
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  })();
}

function applyStreamEvent(event) {
  if (event.type === "snapshot") {
    if (!state.refreshing && !isRunActive(state.run)) scheduleReload();
    return;
  }
  if (event.type === "lastRun") {
    if (!state.refreshing) scheduleReload();
    return;
  }
  if (event.type === "error" && !event.runId) {
    toast(event.error?.message ?? "Studio reported an error", "fail");
    return;
  }
  if (!state.run || (event.runId && event.runId !== state.run.id)) return;
  applyRunEvent(event);
  // A large run streams thousands of results in a burst; draw at most once per frame.
  scheduleRender();
}

/** Replaces the run's result list and the index used to skip duplicates. */
function setRunResults(list) {
  state.runResults = list;
  runSeen = new Set(list.map((result) => result.file));
}

function applyRunEvent(event) {
  if (event.type === "phase") {
    state.run.state = event.phase;
    state.runPhase = event.message;
    return;
  }
  if (event.type === "selection") {
    state.runSelection = {
      selected: event.selected,
      skipped: event.skipped,
      analysisMs: event.analysisMs,
      analysisStatus: event.analysisStatus,
      files: event.files,
    };
    state.run.selected = event.selected;
    state.run.skippedBySelection = event.skipped;
    return;
  }
  if (event.type === "group") {
    state.run.state = "running";
    state.runPhase = "Running tests";
    const key = `${event.adapter}\u0000${event.dir}`;
    const existing = state.runGroups.find((group) => group.key === key);
    if (existing) {
      existing.phase = event.phase;
      existing.files = event.files;
    } else {
      state.runGroups.push({
        key,
        adapter: event.adapter,
        dir: event.dir,
        files: event.files,
        phase: event.phase,
      });
    }
    return;
  }
  if (event.type === "retry") {
    const group = state.runGroups.find(
      (g) => g.adapter === event.adapter && event.files.some((file) => g.files.includes(file)),
    );
    if (group) group.attempt = event.attempt;
    return;
  }
  if (event.type === "result") {
    const file = event.execution.file;
    if (runSeen.has(file)) return;
    runSeen.add(file);
    state.runResults.push(event.execution);
    // A restored run shares one array between the two; push once.
    if (state.run.executions !== state.runResults) state.run.executions.push(event.execution);
    return;
  }
  if (event.type === "summary") {
    state.runSummary = event.summary;
    state.runVerdict = event.status;
    state.run.summary = event.summary;
    state.runPhase = null;
    return;
  }
  if (event.type === "done") {
    state.run = event.run;
    state.runOpen = true;
    state.runSummary = event.run.summary;
    setRunResults(event.run.executions ?? []);
    state.runPhase =
      event.run.error?.message ?? (event.run.state === "cancelled" ? "Run cancelled" : null);
    if (!state.runVerdict) state.runVerdict = runVerdict(event.run);
    void load(currentRoute().view, { force: true, quiet: true });
    return;
  }
  if (event.type === "error") {
    state.run.error = event.error;
    state.run.state = "failed";
    state.runPhase = event.error.message;
    toast(event.error.message, "fail");
  }
}

// ── Data ──────────────────────────────────────────────────────────────────────────────────

function currentRoute() {
  const path = location.pathname.replace(/\/+$/, "") || "/";
  if (path === "/change" || path === "/impact") return { view: "impact" };
  if (path === "/tests") return { view: "tests" };
  if (path === "/trust") return { view: "trust" };
  if (path === "/source") return { view: "source" };
  return { view: "overview" };
}

async function load(view, { force = false, quiet = false } = {}) {
  if (!state.token) return;
  if (!force && state.data[view]) return;
  if (state.loading.has(view)) return;
  state.loading.add(view);
  state.errors.delete(view);
  if (!quiet) render();
  try {
    if (view === "overview") {
      const [overview, impact] = await Promise.all([api("/api/overview"), api("/api/impact")]);
      state.data.overview = overview;
      state.data.impact = impact;
      const files = impact.change.files ?? [];
      if (!state.impactFile || !files.some((file) => file.path === state.impactFile))
        state.impactFile = files[0]?.path ?? null;
    } else if (view === "impact") {
      if (force) state.data.impactSource = null;
      state.data.impact = await api("/api/impact");
      const files = state.data.impact.change.files ?? [];
      if (!state.impactFile || !files.some((file) => file.path === state.impactFile))
        state.impactFile = files[0]?.path ?? null;
      if (state.impactFile) void loadImpactSource(state.impactFile);
    } else if (view === "tests") state.data.tests = await api("/api/tests");
    else if (view === "trust") state.data.trust = await api("/api/trust");
    else if (view === "source") {
      state.data.files = await api("/api/files");
      const wanted = new URLSearchParams(location.search).get("path");
      if (wanted) state.sourcePath = wanted;
      if (
        !state.sourcePath ||
        !state.data.files.files.some((file) => file.path === state.sourcePath)
      )
        state.sourcePath =
          state.data.files.files.find((file) => file.changed)?.path ??
          state.data.files.files[0]?.path ??
          null;
      if (state.sourcePath) await loadSource(state.sourcePath);
    }
  } catch (error) {
    if (handleApiError(error, { quiet })) return;
    state.errors.set(view, error);
  } finally {
    state.loading.delete(view);
    render();
  }
}

async function loadSource(path) {
  if (!path) return;
  state.sourcePath = path;
  const request = ++sourceRequest;
  state.sourceLoading = true;
  render();
  try {
    const source = await api(`/api/source?path=${encodeURIComponent(path)}`);
    if (request === sourceRequest) {
      state.data.source = source;
      state.errors.delete("source-file");
    }
  } catch (error) {
    if (request !== sourceRequest) return;
    handleApiError(error);
    state.errors.set("source-file", error);
    state.data.source = null;
  } finally {
    if (request === sourceRequest) {
      state.sourceLoading = false;
      render();
    }
  }
}

async function loadImpactSource(path) {
  if (!path) return;
  if (state.data.impactSource?.path === path) return;
  if (state.data.impactSource && state.data.impactSource.path !== path) {
    state.impactSourcePath = path;
    render();
  }
  const request = ++sourceRequest;
  state.impactSourcePath = path;
  try {
    const source = await api(`/api/source?path=${encodeURIComponent(path)}`);
    if (request === sourceRequest) state.data.impactSource = source;
  } catch (error) {
    if (request === sourceRequest) handleApiError(error);
  } finally {
    if (request === sourceRequest) {
      state.impactSourcePath = null;
      render();
    }
  }
}

function loadingOrError(view) {
  const error = state.errors.get(view);
  if (error)
    return empty({
      title: "This screen could not load",
      body: `${error.message}${error.hint ? ` ${error.hint}` : ""}`,
      actions: [
        button({
          label: "Try again",
          iconName: "refresh",
          onClick: () => load(view, { force: true }),
        }),
      ],
    });
  const labels = {
    overview: "Analysing the current change…",
    impact: "Tracing the graph from the change…",
    tests: "Reading the discovered tests…",
    trust: "Reading shadow runs and history…",
    source: "Reading the project index…",
  };
  return loading(labels[view] ?? "Loading…");
}

// ── Run ───────────────────────────────────────────────────────────────────────────────────

/** A selector for the focused control, so focus can return to it after the drawer closes. */
function rememberRunOpener() {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || active.closest("#run")) return;
  runOpener = active.dataset.fk
    ? `[data-fk="${CSS.escape(active.dataset.fk)}"]`
    : active.id
      ? `#${CSS.escape(active.id)}`
      : null;
}

/** Opening the drawer moves focus to its title, so a screen reader reads the run it shows. */
function focusRunDrawer() {
  document.getElementById("run-title")?.focus({ preventScroll: true });
}

function closeRun() {
  const hadFocus = document.getElementById("run")?.contains(document.activeElement);
  state.runOpen = false;
  render();
  if (!hadFocus && document.activeElement !== document.body) return;
  const opener = runOpener ? document.querySelector(runOpener) : null;
  const target =
    opener instanceof HTMLElement && !opener.hasAttribute("disabled") ? opener : shell?.main;
  target?.focus(target === opener ? undefined : { preventScroll: true });
  runOpener = null;
}

async function run(scope, file) {
  if (isRunActive(state.run)) {
    toast("A run is already in progress in this Studio session", "fail");
    return;
  }
  try {
    const body = { scope };
    if (file) body.file = file;
    rememberRunOpener();
    const started = await api("/api/run", { method: "POST", body });
    state.run = started.run;
    state.runOpen = true;
    state.runVerdict = null;
    state.runPhase = "Selecting tests for the current change";
    state.runSelection = null;
    state.runGroups = [];
    setRunResults([]);
    state.runSummary = null;
    render();
    focusRunDrawer();
    // Events streamed before this response arrived were dropped (the run id was not known yet);
    // a short run can even finish first. Replaying the run's record is safe: duplicates are ignored.
    void resyncRun(started.run.id);
  } catch (error) {
    handleApiError(error);
  }
}

async function cancelRun() {
  if (!state.run) return;
  try {
    const result = await api(`/api/runs/${encodeURIComponent(state.run.id)}/cancel`, {
      method: "POST",
      body: {},
    });
    toast(result.cancelled ? "Cancelling the run…" : "The run already finished");
  } catch (error) {
    handleApiError(error);
  }
}

async function refresh() {
  if (state.refreshing) return;
  state.refreshing = true;
  render();
  try {
    await api("/api/refresh", { method: "POST", body: {} });
    toast("Analysis refreshed");
    await load(currentRoute().view, { force: true, quiet: true });
  } catch (error) {
    handleApiError(error);
  } finally {
    state.refreshing = false;
    render();
  }
}

/** Replays a run's recorded events; duplicates are ignored, so it is safe after any reconnect. */
async function resyncRun(id) {
  try {
    const one = await api(`/api/runs/${encodeURIComponent(id)}`);
    if (!state.run || state.run.id !== id) return;
    const hadError = Boolean(state.run.error);
    for (const event of one.events ?? []) {
      if (event.type === "error" && hadError) continue;
      applyRunEvent(event);
    }
    // The run finished but its `done` event was pruned from the record.
    if (isRunActive(state.run) && !isRunActive(one.run))
      applyRunEvent({ type: "done", run: one.run });
    scheduleRender();
  } catch {
    /* the next reconnect tries again */
  }
}

async function restoreRun() {
  try {
    const runs = await api("/api/runs");
    if (!runs.active) return;
    const one = await api(`/api/runs/${encodeURIComponent(runs.active)}`);
    state.run = one.run;
    state.runOpen = true;
    setRunResults(one.run.executions ?? []);
    state.runSummary = one.run.summary;
    state.runVerdict = runVerdict(one.run);
    for (const event of one.events ?? []) {
      if (event.type === "phase") state.runPhase = event.message;
      if (event.type === "group") {
        state.runGroups.push({
          key: `${event.adapter}\u0000${event.dir}`,
          adapter: event.adapter,
          dir: event.dir,
          files: event.files,
          phase: event.phase,
        });
      }
    }
  } catch {
    /* a run history is optional; the screens still work */
  }
}

function exportTests() {
  const tests = state.data.tests;
  if (!tests) return;
  const rows = filteredTests(state, tests);
  const csv = [
    [
      "test",
      "runner",
      "selection",
      "last_status",
      "duration_ms",
      "cached",
      "failed",
      "flaky",
      "reasons",
    ],
    ...rows.map((row) => [
      row.filePath,
      row.adapter ?? "",
      row.selection ?? "",
      row.result?.status ?? "not-run",
      row.result?.durationMs ?? "",
      row.result?.cached ?? 0,
      row.result?.failed ?? 0,
      row.flaky ? row.flaky.rate : "",
      row.reasons.join(" | "),
    ]),
  ];
  download("smarttest-tests.csv", toCsv(csv));
  toast(`Exported ${rows.length} test rows`);
}

// ── Shell, pairing, render ────────────────────────────────────────────────────────────────

const NAV = [
  { view: "overview", icon: "overview", label: "Overview" },
  { view: "impact", icon: "impact", label: "Impact" },
  { view: "tests", icon: "tests", label: "Tests" },
  { view: "trust", icon: "trust", label: "Trust" },
  { view: "source", icon: "file", label: "Source" },
];

function mountShell() {
  const navButtons = {};
  const nav = h(
    "nav",
    { class: "rail__nav", "aria-label": "Screens" },
    NAV.map((item) => {
      const buttonNode = h(
        "button",
        {
          class: "rail__item",
          type: "button",
          "data-tip": item.label,
          "aria-label": item.label,
          onClick: () => navigate(item.view === "overview" ? "/overview" : `/${item.view}`),
        },
        icon(item.icon, 18),
        h("span", { class: "rail__label" }, item.label),
      );
      navButtons[item.view] = buttonNode;
      return buttonNode;
    }),
  );
  const themeButton = iconButton({
    name: theme() === "light" ? "sun" : "moon",
    label: theme() === "light" ? "Use dark theme" : "Use light theme",
    onClick: toggleTheme,
  });
  const helpButton = iconButton({
    name: "keyboard",
    label: "Keyboard shortcuts",
    onClick: () => shortcuts(),
  });
  const mark = h(
    "button",
    {
      class: "rail__mark",
      type: "button",
      title: "SmartTest Studio",
      "aria-label": "Studio overview",
      onClick: () => navigate("/overview"),
    },
    h("img", { src: "./favicon.svg", alt: "" }),
  );
  const rail = h(
    "aside",
    { class: "rail", "aria-label": "Studio" },
    mark,
    nav,
    h("div", { class: "rail__spacer" }),
    h("div", { class: "rail__bottom" }, helpButton, themeButton),
  );
  const main = h("main", { id: "main", class: "main", tabindex: "-1" });
  app.className = "shell";
  replace(app, rail, main);
  shell = { main, nav: navButtons, themeButton };
}

function updateShell() {
  if (!shell) return;
  const active = currentRoute().view;
  for (const [view, buttonNode] of Object.entries(shell.nav)) {
    if (view === active) buttonNode.setAttribute("aria-current", "page");
    else buttonNode.removeAttribute("aria-current");
  }
  shell.themeButton.replaceChildren(icon(theme() === "light" ? "sun" : "moon", 14));
  shell.themeButton.title = theme() === "light" ? "Use dark theme" : "Use light theme";
  shell.themeButton.setAttribute("aria-label", shell.themeButton.title);
}

function renderPairing(message) {
  streamStop?.();
  document.getElementById("run")?.remove();
  // A full-screen run drawer makes the page inert; the drawer is gone, so the page is not.
  app.removeAttribute("inert");
  document.querySelector(".skip-link")?.removeAttribute("inert");
  shell = null;
  app.className = "pairing";
  const input = h("input", {
    class: "input",
    type: "text",
    name: "token",
    autocomplete: "off",
    spellcheck: false,
    placeholder: "Paste the URL or token",
    "aria-label": "Studio session token",
  });
  const form = h(
    "form",
    {
      onSubmit: (event) => {
        event.preventDefault();
        const token = normalizeToken(input.value);
        if (!token) {
          toast("That does not contain a Studio token", "fail");
          return;
        }
        storeToken(token);
        void start();
      },
    },
    input,
    button({ label: "Open Studio", type: "submit", variant: "btn--primary" }),
  );
  replace(
    app,
    h(
      "main",
      { id: "main", class: "pairing__card", tabindex: "-1" },
      h("h1", { class: "pairing__title" }, "Pair this tab with Studio"),
      h(
        "p",
        { class: "pairing__body" },
        message ??
          "Studio only answers the tab opened from the URL printed by smarttest studio. The session token is in that URL's fragment; paste the URL or the token to continue.",
      ),
      form,
      h(
        "p",
        { class: "hint pairing__hint" },
        "The token stays in this tab. Studio never stores it in a cookie or sends it to another host.",
      ),
    ),
  );
}

/** Coalesces renders requested in a burst (stream events) into one per animation frame. */
function scheduleRender() {
  if (renderFrame) return;
  renderFrame = requestAnimationFrame(() => {
    renderFrame = 0;
    render();
  });
}

/** Debounced render for typing in a filter field. */
function renderSoon() {
  clearTimeout(queryTimer);
  queryTimer = setTimeout(() => {
    queryTimer = null;
    render();
  }, QUERY_DEBOUNCE_MS);
}

/**
 * A render rebuilds the screen and the run drawer. Before it does, remember which control had
 * focus (by id, `data-search` or `data-fk`), and afterwards put back focus and every `data-scroll`
 * region's position, so a streamed result or a filter keystroke never drops the reader's place.
 */
function captureView() {
  const active = document.activeElement;
  let focus = null;
  if (active instanceof HTMLElement && active !== document.body) {
    const selector = active.id
      ? `#${CSS.escape(active.id)}`
      : active.dataset.search
        ? `[data-search="${CSS.escape(active.dataset.search)}"]`
        : active.dataset.fk
          ? `[data-fk="${CSS.escape(active.dataset.fk)}"]`
          : null;
    if (selector) {
      focus = { selector, start: null, end: null, direction: "none" };
      if (active instanceof HTMLInputElement) {
        focus.start = active.selectionStart;
        focus.end = active.selectionEnd;
        focus.direction = active.selectionDirection ?? "none";
      }
    }
  }
  return { focus };
}

/**
 * Where each `data-scroll` region was last scrolled by the reader. Recorded on scroll rather than
 * read back at render time, so a render that lands mid-layout can never record a zero.
 */
const scrollMemory = new Map();
document.addEventListener(
  "scroll",
  (event) => {
    const el = event.target;
    if (el instanceof HTMLElement && el.dataset.scroll)
      scrollMemory.set(el.dataset.scroll, [el.scrollTop, el.scrollLeft]);
  },
  { capture: true, passive: true },
);

function restoreView({ focus }) {
  for (const el of document.querySelectorAll("[data-scroll]")) {
    const saved = scrollMemory.get(el.dataset.scroll);
    if (!saved) continue;
    el.scrollTop = saved[0];
    el.scrollLeft = saved[1];
  }
  if (!focus) return;
  const current = document.activeElement;
  if (current && current !== document.body && current.isConnected) return;
  const el = document.querySelector(focus.selector);
  if (!(el instanceof HTMLElement) || el.hasAttribute("disabled")) return;
  el.focus({ preventScroll: true });
  if (el instanceof HTMLInputElement && focus.start !== null && focus.end !== null) {
    const length = el.value.length;
    try {
      el.setSelectionRange(
        Math.min(focus.start, length),
        Math.min(focus.end, length),
        focus.direction,
      );
    } catch {
      /* some input types do not expose a selection */
    }
  }
}

function render() {
  if (!state.token) return;
  if (renderFrame) {
    cancelAnimationFrame(renderFrame);
    renderFrame = 0;
  }
  if (queryTimer) {
    clearTimeout(queryTimer);
    queryTimer = null;
  }
  if (!shell) mountShell();
  updateShell();
  const view = captureView();
  replace(shell.main, buildScreen());
  renderRun(ctx);
  restoreView(view);
  document.title = `Studio · ${NAV.find((item) => item.view === currentRoute().view)?.label ?? "Overview"}`;
}

function buildScreen() {
  const route = currentRoute();
  if (route.view === "impact") return renderImpact(ctx);
  if (route.view === "tests") return renderTests(ctx);
  if (route.view === "trust") return renderTrust(ctx);
  if (route.view === "source") return renderSource(ctx);
  return renderOverview(ctx);
}

function navigate(path) {
  history.pushState(null, "", path);
  const route = currentRoute();
  if (route.view === "source") {
    const wanted = new URLSearchParams(location.search).get("path");
    if (wanted) state.sourcePath = wanted;
  }
  window.scrollTo({ top: 0 });
  void load(route.view);
  render();
  announce(`${NAV.find((item) => item.view === route.view)?.label ?? "Overview"} screen`);
}

function singleKeys() {
  try {
    return localStorage.getItem(KEYS_KEY) !== "off";
  } catch {
    return true;
  }
}

function setSingleKeys(on) {
  try {
    localStorage.setItem(KEYS_KEY, on ? "on" : "off");
  } catch {
    /* the setting still applies until the page reloads */
  }
  singleKeysOn = on;
}

let singleKeysOn = singleKeys();

function shortcuts() {
  let close = () => {};
  const row = (keys, text) =>
    h("div", { class: "dl-row" }, h("dt", null, keys), h("dd", null, text));
  const toggle = h("input", {
    type: "checkbox",
    id: "single-key-shortcuts",
    checked: singleKeysOn,
    onChange: (event) => {
      setSingleKeys(event.target.checked);
      announce(event.target.checked ? "Single-key shortcuts on" : "Single-key shortcuts off");
    },
  });
  close = openDialog({
    title: "Keyboard shortcuts",
    body: h(
      "div",
      null,
      h(
        "label",
        { class: "check", for: "single-key-shortcuts" },
        toggle,
        h("span", null, "Use single-key shortcuts (r, ?, /, g)"),
      ),
      h(
        "p",
        { class: "hint mt-4" },
        "Turn them off if you use speech input or they fire by accident. Esc always works.",
      ),
      h(
        "dl",
        null,
        row("r", "Run the affected tests"),
        row("?", "This list"),
        row("/", "Focus the search field on Tests or Source"),
        row("Esc", "Clear a filter, leave a field, close the run panel or this dialog"),
        row("g o", "Go to Overview"),
        row("g i", "Go to Impact"),
        row("g t", "Go to Tests"),
      ),
    ),
    footer: button({ label: "Close", onClick: () => close() }),
  });
}

// ── Boot and keyboard ─────────────────────────────────────────────────────────────────────

async function start() {
  state.data = {
    overview: null,
    impact: null,
    tests: null,
    trust: null,
    files: null,
    source: null,
    impactSource: null,
  };
  state.errors.clear();
  state.run = null;
  state.runOpen = false;
  state.runVerdict = null;
  state.runPhase = null;
  setRunResults([]);
  state.runSummary = null;
  render();
  try {
    state.session = await api("/api/session");
  } catch (error) {
    if (error.code === "ST_STUDIO_TOKEN") {
      forgetToken();
      renderPairing(
        "That session token was not accepted. Reopen the URL printed by smarttest studio.",
      );
    } else {
      renderPairing(`Studio could not reach its local server: ${error.message}`);
    }
    return;
  }
  await restoreRun();
  connectStream();
  await load(currentRoute().view, { force: true });
  render();
}

function isTyping(event) {
  const target = event.target;
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.tagName === "SELECT")
  );
}

let goUntil = 0;
document.addEventListener("keydown", (event) => {
  if (document.querySelector('[role="dialog"]')) return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (isTyping(event)) {
    if (event.key !== "Escape" || !(event.target instanceof HTMLElement)) return;
    const target = event.target;
    // A native search field clears itself on Escape without an input event, which would leave
    // the filter applied to an empty-looking field. Clear it through the filter instead; a
    // second Escape leaves the field.
    if (target instanceof HTMLInputElement && target.dataset.search && target.value) {
      event.preventDefault();
      target.value = "";
      target.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
    target.blur();
    return;
  }
  if (event.key === "Escape" && state.runOpen) {
    event.preventDefault();
    actions.closeRun();
    return;
  }
  if (!singleKeysOn) return;
  if (goUntil > Date.now()) {
    goUntil = 0;
    const path = { o: "/overview", i: "/impact", t: "/tests" }[event.key];
    if (path) {
      event.preventDefault();
      navigate(path);
      return;
    }
  }
  if (event.key === "g") {
    goUntil = Date.now() + 1000;
    return;
  }
  if (event.key === "r") {
    event.preventDefault();
    void run("affected");
    return;
  }
  if (event.key === "?") {
    event.preventDefault();
    shortcuts();
    return;
  }
  if (event.key === "/") {
    const input = document.querySelector("[data-search]");
    if (input) {
      event.preventDefault();
      input.focus();
    }
  }
});

// popstate fires on window, never on document: Back and Forward depend on this listener.
window.addEventListener("popstate", () => {
  const route = currentRoute();
  if (route.view === "source") {
    const wanted = new URLSearchParams(location.search).get("path");
    if (wanted) state.sourcePath = wanted;
  }
  void load(route.view);
  render();
});

function boot() {
  try {
    const forced = new URLSearchParams(location.search).get("theme");
    const stored = localStorage.getItem(THEME_KEY);
    const next =
      forced === "light" || forced === "dark" ? forced : stored === "light" ? "light" : "dark";
    if (forced === "light" || forced === "dark") localStorage.setItem(THEME_KEY, next);
    document.documentElement.dataset.theme = next;
  } catch {
    document.documentElement.dataset.theme = "dark";
  }
  state.token = readToken();
  if (!state.token) {
    renderPairing();
    return;
  }
  void start();
}

boot();
