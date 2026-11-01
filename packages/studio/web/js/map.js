/**
 * The impact map: the change's part of the dependency graph, filtered by change, test, edge kind
 * and confidence, and exported as the view on screen (JSON, SVG or Graphviz DOT).
 *
 * The drawing is a picture of the table under it: every path drawn is a row there, read in words,
 * so the map never holds a fact the keyboard or a screen reader cannot reach.
 */
import { announceChange, button, dataTable, download, empty, h, num, plural, toast } from "./ui.js";

const SVG_NS = "http://www.w3.org/2000/svg";

/** Paths drawn at once; the table and every export still hold the whole filtered view. */
export const MAX_DRAWN_PATHS = 120;
const MAX_TABLE_ROWS = 300;

const NODE_W = 208;
const NODE_H = 30;
const COL_GAP = 76;
const ROW_GAP = 10;
const PAD = 12;

export const EMPTY_FILTERS = Object.freeze({ change: "", test: "", kind: "", confidence: "" });

/** Words for the kinds Studio adds to the graph's own edge kinds. */
const KIND_WORDS = {
  CONTAINS: "contains (unit of the same file)",
  UNCLASSIFIED: "no single graph edge",
  OBSERVED_EXECUTION: "observed in a fresh trace",
  RULE: "rule",
  TRIGGER: "mandatory trigger",
  FALLBACK: "fallback",
  UNCERTAINTY: "unresolved import",
  TEST_CHANGED: "test file changed",
  MODIFIED: "modified symbol",
};

export function kindWords(kind) {
  return KIND_WORDS[kind] ?? kind.toLowerCase().replace(/_/g, " ");
}

function svg(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs ?? {}))
    if (value !== null && value !== undefined && value !== false)
      el.setAttribute(key, String(value));
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

/** The paths, nodes and edges a set of filters leaves. Pure: the export reads the same view. */
export function filterMap(map, filters) {
  const paths = map.paths.filter((path) => {
    if (filters.change) {
      const [kind, value] = [filters.change.slice(0, 5), filters.change.slice(5)];
      if (kind === "file:" && path.originFile !== value) return false;
      if (kind === "node:" && path.origin !== value) return false;
    }
    if (filters.test && path.test !== filters.test) return false;
    if (filters.kind && !path.edgeKinds.includes(filters.kind)) return false;
    if (filters.confidence && (path.confidence ?? "not graded") !== filters.confidence)
      return false;
    return true;
  });
  const nodeIds = new Set(paths.flatMap((p) => p.nodes));
  const edgeIds = new Set(paths.flatMap((p) => p.edges));
  return {
    paths,
    nodes: map.nodes.filter((n) => nodeIds.has(n.id)),
    edges: map.edges.filter((e) => edgeIds.has(e.id)),
  };
}

/** Columns by position along the paths (tests always last), rows by first appearance. */
export function layoutMap(paths) {
  const longest = paths.reduce((n, p) => Math.max(n, p.nodes.length), 0);
  const last = Math.max(1, longest - 1);
  const col = new Map();
  const role = new Map();
  for (const path of paths)
    path.nodes.forEach((id, index) => {
      const isTest = index === path.nodes.length - 1 && path.nodes.length > 1;
      if (isTest) role.set(id, "test");
      const at = isTest ? last : Math.min(index, last - 1);
      if (role.get(id) === "test") col.set(id, last);
      else col.set(id, Math.max(col.get(id) ?? 0, at));
    });
  const columns = Array.from({ length: last + 1 }, () => []);
  for (const path of paths)
    for (const id of path.nodes) {
      const c = col.get(id) ?? 0;
      if (!columns[c].includes(id)) columns[c].push(id);
    }
  const pos = new Map();
  columns.forEach((ids, c) => {
    ids.forEach((id, r) => {
      pos.set(id, { x: PAD + c * (NODE_W + COL_GAP), y: PAD + r * (NODE_H + ROW_GAP) });
    });
  });
  const rows = Math.max(1, ...columns.map((ids) => ids.length));
  return {
    pos,
    width: PAD * 2 + (last + 1) * NODE_W + last * COL_GAP,
    height: PAD * 2 + rows * NODE_H + (rows - 1) * ROW_GAP,
  };
}

/** A short label that keeps what tells nodes apart: the file's name and the unit. */
export function shortLabel(node) {
  if (node.role === "evidence") return node.label;
  const file = node.file ?? node.id;
  const base = file.slice(file.lastIndexOf("/") + 1);
  const text = node.unit ? `${base}#${node.unit}` : base;
  return text.length > 30 ? `…${text.slice(-29)}` : text;
}

function nodeMark(role, x, y) {
  const cy = y + NODE_H / 2;
  if (role === "test")
    return svg("rect", { class: "map__mark", x: x + 10, y: cy - 4, width: 8, height: 8, rx: 1 });
  if (role === "evidence")
    return svg("path", {
      class: "map__mark",
      d: `M${x + 14} ${cy - 5}l5 5-5 5-5-5z`,
    });
  return svg("circle", { class: "map__mark", cx: x + 14, cy, r: 4 });
}

/** The drawing. Each element carries classes only: CSP forbids inline styles. */
export function mapSvg(view, map, { highlightKind = "" } = {}) {
  const drawn = view.paths.slice(0, MAX_DRAWN_PATHS);
  const layout = layoutMap(drawn);
  const nodeById = new Map(map.nodes.map((n) => [n.id, n]));
  const edgeById = new Map(map.edges.map((e) => [e.id, e]));
  const drawnEdges = [...new Set(drawn.flatMap((p) => p.edges))].map((id) => edgeById.get(id));
  const drawnNodes = [...layout.pos.keys()].map((id) => nodeById.get(id)).filter(Boolean);
  const tests = new Set(drawn.map((p) => p.test)).size;
  const label = edgeLabels(drawnEdges.length);
  return svg(
    "svg",
    {
      class: "map__svg",
      xmlns: SVG_NS,
      width: layout.width,
      height: layout.height,
      viewBox: `0 0 ${layout.width} ${layout.height}`,
      role: "img",
      "aria-labelledby": "map-svg-title",
    },
    svg(
      "title",
      { id: "map-svg-title" },
      `Impact map: ${plural(drawn.length, "path")} to ${plural(tests, "test file")}, ${plural(drawnNodes.length, "node")} and ${plural(drawnEdges.length, "edge")}. The table below lists every path in words.`,
    ),
    svg(
      "g",
      { class: "map__edges" },
      drawnEdges.map((edge) => {
        const a = layout.pos.get(edge.from);
        const b = layout.pos.get(edge.to);
        if (!a || !b) return null;
        const x1 = a.x + NODE_W;
        const y1 = a.y + NODE_H / 2;
        const x2 = b.x;
        const y2 = b.y + NODE_H / 2;
        const mid = (x1 + x2) / 2;
        const tone = edgeTone(edge.kind);
        const match = highlightKind && edge.kind === highlightKind;
        return svg(
          "g",
          { class: `map__edge map__edge--${tone}${match ? " map__edge--match" : ""}` },
          svg(
            "path",
            { d: `M${x1} ${y1}C${mid} ${y1} ${mid} ${y2} ${x2 - 4} ${y2}` },
            svg(
              "title",
              null,
              `${edge.from} to ${edge.to}: ${kindWords(edge.kind)}${edge.confidence ? `, ${edge.confidence} confidence` : ""}`,
            ),
          ),
          svg("path", {
            class: "map__head",
            d: `M${x2 - 6} ${y2 - 4}L${x2} ${y2}L${x2 - 6} ${y2 + 4}`,
          }),
          label
            ? svg(
                "text",
                {
                  class: "map__edge-label",
                  x: x1 + COL_GAP / 2,
                  y: y1 + (y2 - y1) * 0.1 - 4,
                  "text-anchor": "middle",
                },
                edge.kind === "UNCLASSIFIED" ? "?" : edge.kind.toLowerCase().replace(/_/g, " "),
              )
            : null,
        );
      }),
    ),
    svg(
      "g",
      { class: "map__nodes" },
      drawnNodes.map((node) => {
        const { x, y } = layout.pos.get(node.id);
        return svg(
          "g",
          {
            class: `map__node map__node--${node.role}${node.unprotected ? " map__node--unprotected" : ""}`,
          },
          svg(
            "title",
            null,
            `${node.id} · ${node.role}${node.unprotected ? " · no protecting test" : ""}`,
          ),
          svg("rect", {
            class: "map__box",
            x,
            y,
            width: NODE_W,
            height: NODE_H,
            rx: node.role === "test" ? 3 : 14,
          }),
          nodeMark(node.role, x, y),
          svg("text", { class: "map__text", x: x + 26, y: y + NODE_H / 2 + 4 }, shortLabel(node)),
        );
      }),
    ),
  );
}

const edgeLabels = (count) => count <= 40;

function edgeTone(kind) {
  if (kind === "UNCLASSIFIED") return "unclassified";
  if (kind === "CONTAINS") return "contains";
  if (
    [
      "RULE",
      "TRIGGER",
      "FALLBACK",
      "UNCERTAINTY",
      "TEST_CHANGED",
      "MODIFIED",
      "OBSERVED_EXECUTION",
    ].includes(kind)
  )
    return "evidence";
  return "graph";
}

// ── Export ─────────────────────────────────────────────────────────────────────────────────

function filterWords(filters) {
  const parts = [];
  if (filters.change) parts.push(`change ${filters.change.slice(5)}`);
  if (filters.test) parts.push(`test ${filters.test}`);
  if (filters.kind) parts.push(`edge ${filters.kind}`);
  if (filters.confidence) parts.push(`confidence ${filters.confidence}`);
  return parts;
}

export function mapJson(map, view, filters) {
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      kind: "smarttest-impact-map",
      exportedAt: new Date().toISOString(),
      generatedAt: map.generatedAt,
      change: map.change,
      filters: { ...filters },
      totalPaths: map.totalPaths,
      truncated: map.truncated,
      paths: view.paths,
      nodes: view.nodes,
      edges: view.edges,
      unreached: map.unreached,
    },
    null,
    2,
  )}\n`;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: removing control characters is the point
const oneLine = (s) => String(s).replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ");

export function mapDot(map, view, filters) {
  const q = (s) => JSON.stringify(String(s));
  const lines = [
    // A comment ends at a line break: repository text in it (refs, --only paths) is one line.
    `// SmartTest impact map · ${oneLine(map.change)}${filterWords(filters).length ? ` · ${oneLine(filterWords(filters).join(" · "))}` : ""}`,
    "digraph impact {",
    "  rankdir=LR;",
    '  node [fontname="monospace", fontsize=10];',
    '  edge [fontname="monospace", fontsize=9];',
  ];
  for (const node of view.nodes) {
    const shape = node.role === "test" ? "box" : node.role === "evidence" ? "diamond" : "ellipse";
    const style = node.role === "changed" ? ", style=bold" : "";
    lines.push(`  ${q(node.id)} [label=${q(node.label)}, shape=${shape}${style}];`);
  }
  for (const edge of view.edges)
    lines.push(
      `  ${q(edge.from)} -> ${q(edge.to)} [label=${q(`${edge.kind}${edge.confidence ? ` (${edge.confidence})` : ""}`)}${edge.kind === "UNCLASSIFIED" ? ", style=dotted" : ""}];`,
    );
  lines.push("}");
  return `${lines.join("\n")}\n`;
}

/** The SVG on screen as a standalone file: the page's theme colours written into it. */
export function mapSvgFile(svgElement) {
  const clone = svgElement.cloneNode(true);
  const css = getComputedStyle(document.documentElement);
  const v = (name) => css.getPropertyValue(name).trim();
  const style = document.createElementNS(SVG_NS, "style");
  style.textContent = [
    `svg{background:${v("--st-bg-0")};font-family:${v("--st-mono")};font-size:11px}`,
    `.map__box{fill:${v("--st-panel")};stroke:${v("--st-line")}}`,
    `.map__node--changed .map__box{stroke:${v("--st-warn")}}`,
    `.map__node--test .map__box{stroke:${v("--st-text")}}`,
    `.map__node--evidence .map__box{stroke-dasharray:4 3}`,
    `.map__text{fill:${v("--st-text")}}`,
    `.map__mark{fill:${v("--st-muted")}}`,
    `.map__node--changed .map__mark{fill:${v("--st-warn")}}`,
    `.map__node--test .map__mark{fill:${v("--st-text")}}`,
    `.map__edge path{fill:none;stroke:${v("--st-muted")};stroke-width:1.2}`,
    ".map__edge--evidence path{stroke-dasharray:5 4}",
    ".map__edge--unclassified path,.map__edge--contains path{stroke-dasharray:2 3}",
    `.map__edge--match path{stroke:${v("--st-cyan")};stroke-width:2}`,
    `.map__edge-label{fill:${v("--st-muted")};font-size:9px}`,
  ].join("");
  clone.insertBefore(style, clone.firstChild);
  return `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(clone)}\n`;
}

// ── Screen block ───────────────────────────────────────────────────────────────────────────

function selectField({ id, label, value, options, onChange }) {
  return h(
    "label",
    { class: "map__field", for: id },
    h("span", { class: "map__field-label" }, label),
    h(
      "select",
      { class: "select", id, "data-fk": id, onChange: (event) => onChange(event.target.value) },
      options.map((option) =>
        h(
          "option",
          { value: option.value, ...(option.value === value ? { selected: true } : {}) },
          option.label,
        ),
      ),
    ),
  );
}

function changeOptions(map) {
  const files = [...new Set(map.changed.map((c) => c.file))];
  const options = [{ value: "", label: "All changed units" }];
  for (const file of files) {
    options.push({ value: `file:${file}`, label: file });
    for (const c of map.changed)
      if (c.file === file && c.unit) options.push({ value: `node:${c.id}`, label: `↳ ${c.unit}` });
  }
  // Evidence that is not a changed unit (a rule, a fallback) is an origin too.
  for (const node of map.nodes)
    if (node.role === "evidence") options.push({ value: `node:${node.id}`, label: node.label });
  return options;
}

export function renderMap(ctx) {
  const { state } = ctx;
  const map = state.data.impactMap;
  if (!map) {
    const error = state.errors.get("impact-map");
    return error
      ? empty({
          title: "The impact map could not load",
          body: `${error.message}${error.hint ? ` ${error.hint}` : ""}`,
          actions: [
            button({
              label: "Try again",
              iconName: "refresh",
              onClick: () => ctx.actions.loadMap(),
            }),
          ],
        })
      : h("p", { class: "hint" }, "Tracing the paths from the change…");
  }
  const filters = state.mapFilters;
  const view = filterMap(map, filters);
  const active = Object.values(filters).some(Boolean);
  const tests = [...new Set(map.paths.map((p) => p.test))].sort();
  announceChange(
    "map",
    JSON.stringify(filters),
    view.paths.length
      ? `${plural(view.paths.length, "path")} shown`
      : "No path matches these filters",
  );
  const set = (key) => (value) => ctx.actions.setMapFilter(key, value);

  const controls = h(
    "div",
    { class: "map__controls", role: "group", "aria-label": "Filter the impact map" },
    selectField({
      id: "map-change",
      label: "Change",
      value: filters.change,
      options: changeOptions(map),
      onChange: set("change"),
    }),
    selectField({
      id: "map-test",
      label: "Test",
      value: filters.test,
      options: [
        { value: "", label: "All selected tests" },
        ...tests.map((t) => ({ value: t, label: t })),
      ],
      onChange: set("test"),
    }),
    selectField({
      id: "map-kind",
      label: "Edge kind",
      value: filters.kind,
      options: [
        { value: "", label: "Any edge" },
        ...map.edgeKinds.map((k) => ({
          value: k,
          label: KIND_WORDS[k]
            ? `${k.toLowerCase().replace(/_/g, " ")} · ${kindWords(k)}`
            : kindWords(k),
        })),
      ],
      onChange: set("kind"),
    }),
    selectField({
      id: "map-confidence",
      label: "Confidence",
      value: filters.confidence,
      options: [
        { value: "", label: "Any confidence" },
        ...map.confidences.map((c) => ({ value: c, label: c })),
      ],
      onChange: set("confidence"),
    }),
    h(
      "div",
      { class: "map__actions" },
      active
        ? button({
            label: "Clear filters",
            size: "btn--small",
            fk: "map-clear",
            onClick: () => ctx.actions.clearMapFilters(),
          })
        : null,
      button({
        label: "JSON",
        iconName: "download",
        size: "btn--small",
        fk: "map-export-json",
        ariaLabel: "Export this view as JSON",
        onClick: () => exportMap(ctx, "json"),
      }),
      button({
        label: "SVG",
        iconName: "download",
        size: "btn--small",
        fk: "map-export-svg",
        ariaLabel: "Export this drawing as SVG",
        onClick: () => exportMap(ctx, "svg"),
      }),
      button({
        label: "DOT",
        iconName: "download",
        size: "btn--small",
        fk: "map-export-dot",
        ariaLabel: "Export this view as Graphviz DOT",
        onClick: () => exportMap(ctx, "dot"),
      }),
    ),
  );

  const nodeById = new Map(map.nodes.map((n) => [n.id, n]));
  const drawing = view.paths.length
    ? h(
        "div",
        {
          class: "map__canvas",
          role: "region",
          "aria-label": "Impact map drawing",
          tabindex: "0",
          "data-fk": "map-canvas",
          "data-scroll": "impact-map",
        },
        mapSvg(view, map, { highlightKind: filters.kind }),
      )
    : empty({
        title: map.paths.length ? "No path matches these filters" : "No path to draw",
        body: map.paths.length
          ? "Clear a filter to see more of the change's paths."
          : "No selected test is reached from the change, so there is no path in the graph to show. Unreached changed units are listed below.",
        actions: active
          ? [button({ label: "Clear filters", onClick: () => ctx.actions.clearMapFilters() })]
          : [],
      });

  const legend = h(
    "div",
    { class: "map__legend" },
    h(
      "span",
      null,
      h("span", { class: "map-key map-key--changed", "aria-hidden": "true" }),
      "changed unit",
    ),
    h(
      "span",
      null,
      h("span", { class: "map-key map-key--affected", "aria-hidden": "true" }),
      "reached on the way",
    ),
    h(
      "span",
      null,
      h("span", { class: "map-key map-key--test", "aria-hidden": "true" }),
      "selected test file",
    ),
    h(
      "span",
      null,
      h("span", { class: "map-key map-key--evidence", "aria-hidden": "true" }),
      "evidence without a graph path",
    ),
    h(
      "span",
      null,
      h("span", { class: "map-key map-key--dotted", "aria-hidden": "true" }),
      "hop with no single graph edge",
    ),
  );

  const rows = view.paths.slice(0, MAX_TABLE_ROWS);
  const table = rows.length
    ? dataTable({
        caption: "Paths in this view, from the change to each selected test",
        columns: [
          { label: "Test", cell: (p) => h("span", { class: "mono" }, p.test) },
          {
            label: "Path",
            cell: (p) =>
              h(
                "span",
                { class: "map__route" },
                p.nodes.map((id, i) => [
                  i
                    ? h(
                        "span",
                        { class: "map__hop" },
                        h("span", { "aria-hidden": "true" }, " → "),
                        h("span", { class: "visually-hidden" }, " to "),
                        h(
                          "span",
                          { class: "map__hop-kind" },
                          `${kindWords(p.edgeKinds[i - 1] ?? "")} `,
                        ),
                      )
                    : null,
                  h("code", { title: id }, nodeById.get(id)?.label ?? id),
                ]),
              ),
          },
          { label: "Confidence", hidePhone: true, cell: (p) => p.confidence ?? "not graded" },
          { label: "Reason", hidePhone: true, cell: (p) => p.reasonKind },
        ],
        rows,
      })
    : null;

  const notes = [];
  if (map.truncated)
    notes.push(
      `The analysis has ${num(map.totalPaths)} selection reasons; Studio received the first ${num(map.paths.length)}. The tests list holds every selected test.`,
    );
  if (view.paths.length > MAX_DRAWN_PATHS)
    notes.push(
      `Drawing the first ${num(MAX_DRAWN_PATHS)} of ${num(view.paths.length)} paths; filter to narrow. The table and the JSON and DOT exports hold the whole view.`,
    );
  if (rows.length < view.paths.length)
    notes.push(
      `The table lists the first ${num(rows.length)} paths; the exports hold all ${num(view.paths.length)}.`,
    );

  return h(
    "section",
    { class: "map", "aria-labelledby": "map-title" },
    h(
      "div",
      { class: "section__head" },
      h("h2", { class: "section__title", id: "map-title" }, "Impact map"),
      h(
        "span",
        { class: "section__note" },
        active
          ? `${plural(view.paths.length, "path")} of ${num(map.paths.length)} · ${plural(view.nodes.length, "node")}`
          : `${plural(map.paths.length, "path")} · ${plural(map.nodes.length, "node")} · ${plural(map.edges.length, "edge")}`,
      ),
    ),
    controls,
    drawing,
    view.paths.length ? legend : null,
    notes.map((note) => h("p", { class: "hint mt-8" }, note)),
    map.unreached.length
      ? h(
          "div",
          { class: "notice mt-12", dataset: { tone: "warn" } },
          h(
            "div",
            { class: "notice__body" },
            h(
              "span",
              { class: "notice__label" },
              `${plural(map.unreached.length, "changed unit")} no selected test reaches`,
            ),
            map.unreached
              .slice(0, 8)
              .map((u) =>
                h(
                  "p",
                  null,
                  h("code", null, u.unit ? `${u.file}#${u.unit}` : u.file),
                  u.unprotected ? " · no protecting test" : " · no path in this selection",
                ),
              ),
          ),
        )
      : null,
    table ? h("div", { class: "mt-12" }, table) : null,
  );
}

function exportMap(ctx, format) {
  const map = ctx.state.data.impactMap;
  if (!map) return;
  const filters = ctx.state.mapFilters;
  const view = filterMap(map, filters);
  if (format === "json")
    download("smarttest-impact-map.json", mapJson(map, view, filters), "application/json");
  else if (format === "dot")
    download(
      "smarttest-impact-map.dot",
      mapDot(map, view, filters),
      "text/vnd.graphviz;charset=utf-8",
    );
  else {
    const element = document.querySelector(".map__svg");
    if (!element) {
      toast("There is no drawing to export for these filters", "fail");
      return;
    }
    download("smarttest-impact-map.svg", mapSvgFile(element), "image/svg+xml");
  }
  toast(`Exported ${plural(view.paths.length, "path")} as ${format.toUpperCase()}`);
}
