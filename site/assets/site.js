// SmartTest landing page: the live impact panel, the mode switch, the setup dialog, entrances.
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // ── Live impact panel (data computed by SmartTest: scripts/site/demo-data.mjs) ──
  let data;
  try {
    data = JSON.parse($("#demo-data")?.textContent ?? "");
  } catch {
    data = undefined;
  }
  const panel = $("#impact");
  const short = (label) => label.replace(/^.*#/, "");
  const render = () => {
    if (!data || !panel) return;
    const on = $$(".chip")
      .filter((c) => c.getAttribute("aria-pressed") === "true")
      .map((c) => c.dataset.edit);
    const key = data.edits
      .map((e) => e.id)
      .filter((id) => on.includes(id))
      .join("+");
    const combo = data.combos[key];
    const files = [...new Set(data.edits.filter((e) => on.includes(e.id)).map((e) => e.file))];
    const selected = combo ? combo.selected : [];
    const chosen = new Set(selected.map((s) => s.file));
    const skipped = data.tests.filter((t) => !chosen.has(t));
    $("[data-changed]", panel).textContent =
      `${files.length} changed file${files.length === 1 ? "" : "s"}`;
    $("[data-files]", panel).innerHTML = files.length
      ? files
          .map(
            (f) =>
              `<span class="t-dim">  modified </span>${esc(f)}<span class="t-dim">  implementation</span>`,
          )
          .join("<br>")
      : '<span class="t-dim">  no changes · switch an edit on</span>';
    $("[data-count]", panel).textContent = String(selected.length);
    $("[data-skipcount]", panel).textContent = String(skipped.length);
    $("[data-selected]", panel).innerHTML = selected
      .map(
        (s, i) =>
          `<button class="row" type="button" aria-expanded="false" data-i="${i}"><span class="t-pass">■</span><span>${esc(s.file)}</span><span class="why">${esc(s.reason.replace(/src\/[\w/]+\.ts#/g, ""))}</span></button>`,
      )
      .join("");
    $("[data-skipped]", panel).innerHTML = skipped
      .map((t) => `<div class="row skipped"><span>□</span><span>${esc(t)}</span></div>`)
      .join("");
    const pathBox = $("[data-path]", panel);
    pathBox.hidden = true;
    $$("[data-selected] .row", panel).forEach((row) => {
      row.addEventListener("click", () => {
        const s = selected[Number(row.dataset.i)];
        const open = row.getAttribute("aria-expanded") === "true";
        $$("[data-selected] .row", panel).forEach((r) => r.setAttribute("aria-expanded", "false"));
        if (open) {
          pathBox.hidden = true;
          return;
        }
        row.setAttribute("aria-expanded", "true");
        pathBox.innerHTML = `Why: ${s.path.map((p, j) => (j === s.path.length - 1 ? `<b>${esc(p)}</b>` : esc(short(p)))).join(' <span class="t-dim">→</span> ')}`;
        pathBox.hidden = false;
      });
    });
    const ratio = $("[data-ratio]");
    if (ratio) ratio.textContent = `${selected.length} of ${data.tests.length}`;
  };
  $$(".chip").forEach((chip) =>
    chip.addEventListener("click", () => {
      chip.setAttribute(
        "aria-pressed",
        chip.getAttribute("aria-pressed") === "true" ? "false" : "true",
      );
      render();
    }),
  );
  render();

  // ── Safety mode switch ──
  const MODES = {
    fast: {
      field: "var(--warn)",
      word: "Fast",
      text: "For the local loop. Comment and formatting-only changes are skipped, and tests behind imports SmartTest cannot resolve only produce a warning.",
      detail: "Fresh traces can rule tests out and add tests static analysis missed.",
    },
    balanced: {
      field: "var(--cyan)",
      word: "Balanced",
      text: "The default for pull requests and hooks. Every change counts, and a test behind an import SmartTest cannot resolve is selected on its own instead of being ruled out.",
      detail:
        "Rules can only make the mode stricter. A file marked critical upgrades the whole decision to SAFE.",
    },
    safe: {
      field: "var(--pass)",
      word: "Safe",
      text: "For releases and critical code. If the change analysis itself is incomplete, the whole suite runs. Uncertain tests are always selected.",
      detail: "Traces can only add tests in SAFE mode. They never rule one out.",
    },
  };
  const modes = $("#modes");
  $$("[data-mode]").forEach((b) =>
    b.addEventListener("click", () => {
      const m = MODES[b.dataset.mode];
      $$("[data-mode]").forEach((x) => x.setAttribute("aria-checked", String(x === b)));
      modes.style.setProperty("--field", m.field);
      $("[data-mode-word]").textContent = m.word;
      $("[data-mode-text]").textContent = m.text;
      $("[data-mode-detail]").textContent = m.detail;
    }),
  );
  $(".segmented")?.addEventListener("keydown", (e) => {
    if (!["ArrowLeft", "ArrowRight"].includes(e.key)) return;
    const all = $$("[data-mode]");
    const i = all.findIndex((x) => x.getAttribute("aria-checked") === "true");
    const next = all[(i + (e.key === "ArrowRight" ? 1 : all.length - 1)) % all.length];
    next.click();
    next.focus();
    e.preventDefault();
  });

  // ── Setup dialog ──
  const cmd = $("[data-cmd]");
  const version = cmd?.textContent.match(/smarttest-([\d.]+)\.tgz/)?.[1] ?? "";
  let pm = "npm";
  const writeCmd = () => {
    const project = ($("#project")?.value || "~/code/my-app").trim();
    const add = { npm: "npm install -D", pnpm: "pnpm add -D", yarn: "yarn add -D" }[pm];
    const run = { npm: "npx", pnpm: "pnpm exec", yarn: "yarn" }[pm];
    cmd.textContent = [
      "git clone https://github.com/RemiPelloux/SmarttyTest ~/SmarttyTest",
      "cd ~/SmarttyTest && corepack enable && pnpm install && pnpm release:pack",
      `cd ${project}`,
      `${add} ~/SmarttyTest/packages/cli/.publish/smarttest-${version}.tgz`,
      `${run} smarttest init --dry-run`,
    ].join("\n");
  };
  $$("[data-pm]").forEach((b) =>
    b.addEventListener("click", () => {
      pm = b.dataset.pm;
      $$("[data-pm]").forEach((x) => x.setAttribute("aria-checked", String(x === b)));
      writeCmd();
    }),
  );
  $("#project")?.addEventListener("input", writeCmd);
  $("[data-copy]")?.addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    try {
      await navigator.clipboard.writeText(cmd.textContent);
      btn.textContent = "Copied";
    } catch {
      const r = document.createRange();
      r.selectNodeContents(cmd);
      getSelection()?.removeAllRanges();
      getSelection()?.addRange(r);
      btn.textContent = "Selected, press Ctrl+C";
    }
    setTimeout(() => {
      btn.textContent = "Copy commands";
    }, 2000);
  });

  // ── Entrances and the slow drift on the report picture ──
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const items = $$(".reveal");
  if (reduce || !("IntersectionObserver" in window)) items.forEach((el) => el.classList.add("in"));
  else {
    const io = new IntersectionObserver(
      (entries) =>
        entries.forEach((en) => {
          if (en.isIntersecting) {
            en.target.classList.add("in");
            io.unobserve(en.target);
          }
        }),
      { rootMargin: "0px 0px -8% 0px" },
    );
    items.forEach((el) => io.observe(el));
  }
  const drift = $("[data-drift]");
  if (drift && !reduce) {
    const onScroll = () => {
      const r = drift.getBoundingClientRect();
      const p = Math.min(1, Math.max(0, 1 - r.bottom / (innerHeight + r.height)));
      drift.style.transform = `scale(${1.02 + p * 0.06}) translateY(${-p * 24}px)`;
    };
    addEventListener("scroll", onScroll, { passive: true });
    onScroll();
  }
})();
