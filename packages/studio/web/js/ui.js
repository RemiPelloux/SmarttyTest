/**
 * Small DOM and formatting helpers. No framework: every screen is built from these, so the
 * markup stays plain, accessible and free of innerHTML.
 */

const SVG_NS = "http://www.w3.org/2000/svg";

export function h(tag, props = null, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === "class") el.className = value;
      else if (key === "text") el.textContent = value;
      else if (key === "vars")
        for (const [name, v] of Object.entries(value)) el.style.setProperty(name, v);
      else if (key === "dataset") Object.assign(el.dataset, value);
      else if (key.startsWith("on") && typeof value === "function")
        el.addEventListener(key.slice(2).toLowerCase(), value);
      else if (key === "attrs") {
        for (const [name, v] of Object.entries(value))
          if (v !== undefined && v !== null) el.setAttribute(name, String(v));
      } else if (key in el && key !== "list" && key !== "form" && typeof value !== "string")
        el[key] = value;
      else el.setAttribute(key, value === true ? "" : String(value));
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) append(el, child);
    else if (child instanceof Node) el.appendChild(child);
    else el.appendChild(document.createTextNode(String(child)));
  }
}

export function frag(...children) {
  const f = document.createDocumentFragment();
  append(f, children);
  return f;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function replace(el, ...children) {
  clear(el);
  append(el, children);
  return el;
}

const ICONS = {
  overview: ["M4 4h7v7H4z", "M13 4h7v4h-7z", "M13 10h7v10h-7z", "M4 13h7v7H4z"],
  impact: ["M6 4v16", "M6 10h6a4 4 0 0 1 4 4v2", "M13 20h6", "M17 16l3 3-3 3", "M3 4h6"],
  tests: ["M4 6h2", "M9 6h11", "M4 12h2", "M9 12h11", "M4 18h2", "M9 18h7"],
  trust: ["M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6z", "M9 12l2 2 4-4"],
  play: ["M7 4l12 8-12 8z"],
  all: ["M4 5h16", "M4 12h16", "M4 19h10"],
  refresh: ["M20 11a8 8 0 1 0-2.3 6.5", "M20 4v7h-7"],
  file: ["M6 3h8l4 4v14H6z", "M13 3v5h5"],
  search: ["M11 19a8 8 0 1 1 0-16 8 8 0 0 1 0 16z", "M21 21l-4.3-4.3"],
  close: ["M6 6l12 12", "M18 6L6 18"],
  copy: ["M9 9h11v11H9z", "M5 15H4V4h11v1"],
  download: ["M12 3v12", "M7 10l5 5 5-5", "M4 20h16"],
  chevron: ["M9 6l6 6-6 6"],
  arrow: ["M4 12h16", "M14 6l6 6-6 6"],
  sun: [
    "M12 4V2",
    "M12 22v-2",
    "M4 12H2",
    "M22 12h-2",
    "M6 6L4.5 4.5",
    "M19.5 19.5L18 18",
    "M18 6l1.5-1.5",
    "M4.5 19.5L6 18",
    "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z",
  ],
  moon: ["M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5z"],
  keyboard: ["M3 6h18v12H3z", "M7 10h.01", "M11 10h.01", "M15 10h.01", "M7 14h10"],
  stop: ["M6 6h12v12H6z"],
  external: ["M14 4h6v6", "M20 4l-9 9", "M18 14v5H5V6h5"],
  layers: ["M12 3l9 5-9 5-9-5z", "M3 13l9 5 9-5"],
  clock: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", "M12 7v5l3 2"],
  warning: ["M12 3l9 17H3z", "M12 9v5", "M12 17h.01"],
  grid: ["M4 4h7v7H4z", "M13 4h7v7h-7z", "M4 13h7v7H4z", "M13 13h7v7h-7z"],
};

export function icon(name, size = 16) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.6");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  for (const d of ICONS[name] ?? ICONS.chevron) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.appendChild(path);
  }
  return svg;
}

const intFormat = new Intl.NumberFormat("en-US");

export function num(n) {
  return typeof n === "number" && Number.isFinite(n) ? intFormat.format(n) : "–";
}

export function pct(part, total) {
  if (!total) return "–";
  return `${Math.round((part / total) * 100)}%`;
}

export function plural(n, one, many = `${one}s`) {
  return `${num(n)} ${n === 1 ? one : many}`;
}

export function duration(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "–";
  if (ms < 1) return "<1 ms";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

export function relativeTime(iso) {
  if (!iso) return "never";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "unknown";
  const diff = Date.now() - then;
  if (diff < 45_000) return "just now";
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} min ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} h ago`;
  if (diff < 7 * 86_400_000) return `${Math.round(diff / 86_400_000)} d ago`;
  return new Date(then).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function clockTime(iso) {
  if (!iso) return "–";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "–";
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function label(text) {
  return h("span", { class: "eyebrow" }, text);
}

export function eyebrow(...parts) {
  const out = [];
  parts.filter(Boolean).forEach((part, index) => {
    if (index) out.push(h("span", { class: "eyebrow__sep", "aria-hidden": "true" }, "/"));
    out.push(h("span", null, part));
  });
  return h("div", { class: "eyebrow" }, out);
}

const STATUS = {
  passed: { glyph: "✓", text: "passed" },
  failed: { glyph: "×", text: "failed" },
  flaky: { glyph: "↻", text: "flaky" },
  "cached-pass": { glyph: "⧉", text: "cached, not run" },
  "cached-failure": { glyph: "⧉", text: "cached failure" },
  skipped: { glyph: "", text: "not run" },
  pending: { glyph: "", text: "pending" },
  "timed-out": { glyph: "◷", text: "timed out" },
  cancelled: { glyph: "–", text: "cancelled" },
  "infrastructure-error": { glyph: "!", text: "infra error" },
  error: { glyph: "!", text: "error" },
};

export function statusMark(status, { text = null, title = null } = {}) {
  const known = STATUS[status] ?? { glyph: "·", text: status ?? "unknown" };
  return h(
    "span",
    {
      class: "status",
      dataset: { status: status ?? "unknown" },
      ...(title ? { title } : {}),
    },
    h("span", { class: "status__glyph", "aria-hidden": "true" }, known.glyph),
    h("span", null, text ?? known.text),
  );
}

export function selectionMark(selection) {
  if (selection === "selected")
    return h(
      "span",
      { class: "status", dataset: { status: "passed" } },
      h("span", { class: "status__glyph", "aria-hidden": "true" }, "■"),
      h("span", null, "selected"),
    );
  if (selection === "skipped")
    return h(
      "span",
      { class: "status", dataset: { status: "skipped" } },
      h("span", { class: "status__glyph", "aria-hidden": "true" }),
      h("span", null, "not run"),
    );
  return h("span", { class: "status", dataset: { status: "skipped" } }, "–");
}

export function empty({ title, body, actions = [], children = [] }) {
  return h(
    "div",
    { class: "empty" },
    h("p", { class: "empty__title" }, title),
    body ? h("p", { class: "empty__body" }, body) : null,
    children,
    actions.length ? h("div", { class: "empty__actions" }, actions) : null,
  );
}

export function loading(text = "Loading…") {
  return h(
    "div",
    { class: "loading", role: "status" },
    h("span", { class: "loading__bar", "aria-hidden": "true" }),
    h("span", null, text),
  );
}

export function button({
  label: text,
  iconName,
  onClick,
  variant = "",
  size = "",
  title,
  disabled = false,
  shortcut = null,
  type = "button",
}) {
  return h(
    "button",
    {
      class: `btn ${variant} ${size}`.trim(),
      type,
      ...(title ? { title } : {}),
      ...(disabled ? { disabled: true } : {}),
      onClick,
    },
    iconName ? icon(iconName, 13) : null,
    h("span", null, text),
    shortcut ? h("span", { class: "kbd", "aria-hidden": "true" }, shortcut) : null,
  );
}

export function iconButton({ name, label: text, onClick, disabled = false }) {
  return h(
    "button",
    {
      class: "icon-btn",
      type: "button",
      title: text,
      "aria-label": text,
      ...(disabled ? { disabled: true } : {}),
      onClick,
    },
    icon(name, 14),
  );
}

/**
 * One table for every list screen. Rows can be dimmed (skipped), selected, and opened.
 */
export function dataTable({ caption, columns, rows, rowProps, onRowClick }) {
  const head = h(
    "tr",
    null,
    columns.map((column) =>
      h(
        "th",
        {
          scope: "col",
          ...(column.align ? { "data-align": column.align } : {}),
          ...(column.hidePhone ? { "data-hide": "phone" } : {}),
        },
        column.label,
      ),
    ),
  );
  const body = h("tbody");
  rows.forEach((row, index) => {
    const props = rowProps ? rowProps(row, index) : {};
    const tr = h("tr", props);
    if (onRowClick) {
      tr.tabIndex = 0;
      tr.style.cursor = "pointer";
      tr.addEventListener("click", (event) => {
        if (event.target.closest("button, a, input")) return;
        onRowClick(row);
      });
      tr.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && !event.target.closest("button, a, input")) {
          event.preventDefault();
          onRowClick(row);
        }
      });
    }
    for (const column of columns) {
      const value = column.cell(row, index);
      const td = h("td", {
        ...(column.align ? { "data-align": column.align } : {}),
        ...(column.hidePhone ? { "data-hide": "phone" } : {}),
      });
      append(td, [value]);
      tr.appendChild(td);
    }
    body.appendChild(tr);
  });
  return h(
    "div",
    { class: "table-wrap" },
    h("table", { class: "data" }, h("caption", null, caption), h("thead", null, head), body),
  );
}

export function tabs({ items, active, onSelect, idPrefix = "tab" }) {
  const list = h("div", { class: "tabs", role: "tablist", "aria-label": "Test states" });
  const buttons = [];
  items.forEach((item, index) => {
    const button = h(
      "button",
      {
        class: "tab",
        type: "button",
        role: "tab",
        id: `${idPrefix}-${item.id}`,
        "aria-selected": String(item.id === active),
        "aria-controls": `${idPrefix}-panel`,
        tabindex: item.id === active ? "0" : "-1",
        onClick: () => onSelect(item.id),
      },
      item.label,
      item.count !== undefined ? h("span", { class: "tab__count" }, num(item.count)) : null,
    );
    button.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
      event.preventDefault();
      const direction = event.key === "ArrowRight" ? 1 : -1;
      const next = items[(index + direction + items.length) % items.length];
      onSelect(next.id);
      buttons[(index + direction + items.length) % items.length]?.focus();
    });
    buttons.push(button);
    list.appendChild(button);
  });
  return list;
}

export function segmented({ items, active, onSelect, label: ariaLabel }) {
  return h(
    "div",
    { class: "seg", role: "group", "aria-label": ariaLabel },
    items.map((item) =>
      h(
        "button",
        {
          class: "seg__btn",
          type: "button",
          "aria-pressed": String(item.id === active),
          onClick: () => onSelect(item.id),
        },
        item.label,
        item.count !== undefined ? ` ${num(item.count)}` : "",
      ),
    ),
  );
}

export function copyText(text) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  document.body.appendChild(area);
  area.select();
  document.execCommand("copy");
  area.remove();
  return Promise.resolve();
}

function csvCell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(rows) {
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

export function download(filename, text, type = "text/csv;charset=utf-8") {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = h("a", { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

let toastTimer = null;

export function toast(message, tone = "info") {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = message;
  el.dataset.show = "true";
  el.dataset.tone = tone;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(
    () => {
      el.dataset.show = "false";
    },
    tone === "fail" ? 6000 : 3200,
  );
}

export function openDialog({ title, body, footer = null }) {
  const previous = document.activeElement;
  const card = h(
    "div",
    { class: "dialog__card", role: "dialog", "aria-modal": "true", "aria-label": title },
    h("p", { class: "dialog__title" }, title),
    h("div", { class: "dialog__body" }, body),
    footer ? h("div", { class: "dialog__foot" }, footer) : null,
  );
  const overlay = h("div", { class: "dialog" }, card);
  const close = () => {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
    if (previous instanceof HTMLElement) previous.focus();
  };
  const onKey = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
    if (event.key === "Tab") {
      const focusable = card.querySelectorAll(
        "button, [href], input, [tabindex]:not([tabindex='-1'])",
      );
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  };
  overlay.addEventListener("mousedown", (event) => {
    if (event.target === overlay) close();
  });
  document.addEventListener("keydown", onKey);
  document.body.appendChild(overlay);
  const focusable = card.querySelector("button, input");
  focusable?.focus();
  return close;
}

export function warnNotice({ title, lines = [], tone = "warn" }) {
  return h(
    "div",
    { class: "notice", dataset: { tone } },
    icon(tone === "warn" ? "warning" : "chevron", 14),
    h(
      "div",
      { class: "notice__body" },
      h("span", { class: "notice__label" }, title),
      lines.map((line) => h("p", null, line)),
    ),
  );
}
