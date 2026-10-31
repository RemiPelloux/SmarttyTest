#!/usr/bin/env node
/**
 * Studio accessibility audit (WCAG 2.2 AA, keyboard and screen-reader proxy checks).
 *
 * Starts Studio against a throwaway git copy of fixtures/projects/ts-lib-vitest with one failing
 * change, then drives every screen in Chromium, Firefox and WebKit, in the light and dark themes:
 *
 *   - axe-core with the wcag2a, wcag2aa, wcag21a, wcag21aa and wcag22aa tags on every state
 *     (best-practice rules are reported as advisory and do not fail the audit);
 *   - keyboard only: the Tab order reaches every control, each stop shows a visible focus change
 *     and is not hidden behind other content, no trap, Escape closes the run drawer and the
 *     shortcuts dialog and focus returns to the control that opened them, arrow keys move tabs;
 *   - skip link, landmarks and heading order;
 *   - a live run: progress and the final verdict are announced through a live region that was
 *     already in the page (a region inserted with its text is not reliably announced);
 *   - prefers-reduced-motion: no animation or transition longer than 10 ms;
 *   - reflow at 320 px and 640 px wide (400% and 200% zoom of a 1280 px window): no horizontal
 *     page scroll, and no focused control hidden behind the fixed navigation;
 *   - target size: every control at least 24 by 24 px or spaced as WCAG 2.5.8 allows;
 *   - the accessibility tree of every state (Playwright's aria snapshot), written to disk for review.
 *
 * Usage:
 *   pnpm studio:a11y [--browsers=chromium,firefox,webkit] [--themes=light,dark] [--out=<dir>]
 *                    [--assets=<web dir>] [--skip-reflow] [--skip-focus-pixels]
 *
 * --assets serves another copy of packages/studio/web, for example one exported from an older
 * commit with `git archive`, to compare a baseline with the working tree.
 *
 * --webkit-libs adds a directory of shared libraries for Playwright's WebKit build, which links
 * against Ubuntu 24.04 libraries (ICU 74, libxml2.so.2, flite). On other Linux distributions,
 * extract the libicu74, libxml2 and libflite1 .deb packages there; nothing is installed system-wide.
 *
 * It needs the Playwright browsers that match playwright-core (`playwright-core install` fetches
 * them). Run it through a machine guard on shared machines: it launches one browser at a time.
 * Exit code 0 when every gated check passes, 1 when one fails, 2 when the audit itself broke.
 */
import { execFileSync } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import AxeBuilder from "@axe-core/playwright";
import { chromium, firefox, webkit } from "playwright-core";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const FIXTURE = join(ROOT, "fixtures/projects/ts-lib-vitest");
const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const ENGINES = { chromium, firefox, webkit };
const SCREENS = [
  { id: "overview", path: "/overview", title: "Overview" },
  { id: "impact", path: "/impact", title: "Impact" },
  { id: "tests", path: "/tests", title: "Tests" },
  { id: "trust", path: "/trust", title: "Trust" },
  { id: "source", path: "/source", title: "Source" },
];

const { values: args } = parseArgs({
  options: {
    browsers: { type: "string", default: "chromium,firefox,webkit" },
    themes: { type: "string", default: "light,dark" },
    out: { type: "string", default: join(tmpdir(), "smarttest-studio-a11y") },
    assets: { type: "string" },
    "webkit-libs": { type: "string" },
    "skip-reflow": { type: "boolean", default: false },
    "skip-focus-pixels": { type: "boolean", default: false },
  },
});
const browsers = args.browsers.split(",").map((b) => b.trim());
const themes = args.themes.split(",").map((t) => t.trim());
const OUT = resolve(args.out);
for (const name of browsers)
  if (!ENGINES[name]) throw new Error(`Unknown browser "${name}" (chromium, firefox, webkit)`);

// ── Page-side helpers, installed before Studio's own scripts ──────────────────────────────

function pageHelpers() {
  const FOCUSABLE =
    'a[href], button, input:not([type="hidden"]), select, textarea, summary, [tabindex]';
  const LIVE = '[aria-live]:not([aria-live="off"]), [role="status"], [role="alert"], [role="log"]';
  const text = (s) => (s ?? "").replace(/\s+/g, " ").trim();
  const desc = (el) => {
    if (!el || el === document.body || el === document.documentElement) return "body";
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute("role");
    const id = el.dataset?.fk ? `{${el.dataset.fk}}` : el.id ? `#${el.id}` : "";
    const name = text(
      el.getAttribute("aria-label") || el.textContent || el.getAttribute("title") || el.value,
    ).slice(0, 60);
    return `${tag}${role ? `[role=${role}]` : ""}${id} "${name}"`;
  };
  const visible = (el) =>
    el.isConnected &&
    !el.closest("[inert]") &&
    (el.checkVisibility ? el.checkVisibility({ visibilityProperty: true }) : true) &&
    el.getClientRects().length > 0;
  const focusables = () =>
    [...document.querySelectorAll(FOCUSABLE)].filter(
      (el) => !el.disabled && el.tabIndex >= 0 && visible(el),
    );
  const keyOf = (el) => {
    const list = focusables();
    return `${desc(el)}@${list.indexOf(el)}`;
  };
  const hitsElement = (el, x, y) => {
    if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return { ok: false, by: null };
    const hit = document.elementFromPoint(x, y);
    if (!hit) return { ok: false, by: null };
    if (hit === el || el.contains(hit)) return { ok: true, by: null };
    // A <label> wrapping the control, or an ancestor hit through pointer-events: none.
    if (hit.contains(el) && !hit.matches(".drawer, .rail, .toast, .dialog")) return { ok: true };
    return { ok: false, by: hit };
  };
  window.__a11y = {
    desc,
    expected: () => focusables().map((el) => `${desc(el)}@${focusables().indexOf(el)}`),
    focusInfo() {
      const el = document.activeElement;
      if (!el || el === document.body || el === document.documentElement || !document.hasFocus())
        return { key: "body", desc: "body" };
      const r = el.getBoundingClientRect();
      const points = [
        [r.left + r.width / 2, r.top + r.height / 2],
        [r.left + 2, r.top + 2],
        [r.right - 2, r.top + 2],
        [r.left + 2, r.bottom - 2],
        [r.right - 2, r.bottom - 2],
      ];
      const hits = points.map(([x, y]) => hitsElement(el, x, y));
      const shown = hits.filter((h) => h.ok).length;
      const blocker = hits.find((h) => !h.ok && h.by)?.by ?? null;
      return {
        key: keyOf(el),
        desc: desc(el),
        rect: { x: r.left, y: r.top, width: r.width, height: r.height },
        inDrawer: Boolean(el.closest("#run")),
        inDialog: Boolean(el.closest('[role="dialog"]')),
        obscured: shown === 0 ? "entirely" : shown < points.length ? "partly" : null,
        obscuredBy: blocker
          ? blocker.closest("#run")
            ? "run drawer"
            : blocker.closest(".rail")
              ? "navigation rail"
              : desc(blocker)
          : null,
        focusVisible: el.matches(":focus-visible"),
      };
    },
    focusFirst() {
      focusables()[0]?.focus();
    },
    isLast() {
      const list = focusables();
      return list.at(-1) === document.activeElement;
    },
    focusKey(key) {
      const el = focusables().find((e) => keyOf(e) === key);
      el?.focus();
      return Boolean(el);
    },
    blur() {
      document.activeElement?.blur?.();
    },
    async pixelDiff(a, b) {
      const load = async (b64) => {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        return createImageBitmap(new Blob([bytes], { type: "image/png" }));
      };
      const [ia, ib] = await Promise.all([load(a), load(b)]);
      const w = Math.min(ia.width, ib.width);
      const h = Math.min(ia.height, ib.height);
      const read = (img) => {
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const c = canvas.getContext("2d");
        c.drawImage(img, 0, 0);
        return c.getImageData(0, 0, w, h).data;
      };
      const da = read(ia);
      const db = read(ib);
      let changed = 0;
      for (let i = 0; i < da.length; i += 4) {
        const d =
          Math.abs(da[i] - db[i]) +
          Math.abs(da[i + 1] - db[i + 1]) +
          Math.abs(da[i + 2] - db[i + 2]);
        if (d > 60) changed++;
      }
      return changed;
    },
    structure() {
      const issues = [];
      const mains = document.querySelectorAll('main, [role="main"]');
      if (mains.length !== 1) issues.push(`${mains.length} main landmarks (expected 1)`);
      const headings = [...document.querySelectorAll("h1, h2, h3, h4, h5, h6, [role=heading]")]
        .filter(visible)
        .map((el) => ({
          level: Number(el.getAttribute("aria-level") ?? el.tagName.slice(1)),
          text: text(el.textContent).slice(0, 50),
        }));
      const h1 = headings.filter((h) => h.level === 1);
      if (h1.length !== 1) issues.push(`${h1.length} h1 headings (expected 1)`);
      if (headings.length && headings[0].level !== 1)
        issues.push(`first heading is h${headings[0].level} "${headings[0].text}"`);
      for (let i = 1; i < headings.length; i++)
        if (headings[i].level > headings[i - 1].level + 1)
          issues.push(
            `heading jumps from h${headings[i - 1].level} to h${headings[i].level} at "${headings[i].text}"`,
          );
      const labelled = (sel) =>
        [...document.querySelectorAll(sel)].filter(visible).map((el) => ({
          el,
          name: text(
            el.getAttribute("aria-label") ||
              document.getElementById(el.getAttribute("aria-labelledby") ?? "")?.textContent,
          ),
        }));
      for (const role of ["nav, [role=navigation]", "aside, [role=complementary]"]) {
        const items = labelled(role);
        if (items.length > 1 && items.some((i) => !i.name))
          issues.push(`several ${role.split(",")[0]} landmarks and one has no label`);
        const names = items.map((i) => i.name);
        if (new Set(names).size !== names.length)
          issues.push(`duplicate ${role.split(",")[0]} labels`);
      }
      const outside = [...document.body.children].filter(
        (el) =>
          visible(el) &&
          !el.matches(
            "main, nav, aside, header, footer, [role], .skip-link, script, noscript, #toast",
          ) &&
          !el.querySelector("main, [role=main]") &&
          text(el.textContent),
      );
      for (const el of outside) issues.push(`content outside any landmark: ${desc(el)}`);
      return { issues, headings };
    },
    targets() {
      const sel =
        'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="tab"], [role="button"], [tabindex]:not([tabindex="-1"])';
      const all = [...document.querySelectorAll(sel)].filter(
        (el) => visible(el) && !el.matches(".skip-link"),
      );
      const rects = all.map((el) => ({ el, r: el.getBoundingClientRect() }));
      const small = rects.filter(({ el, r }) => {
        if (r.width >= 23.5 && r.height >= 23.5) return false;
        // Inline links inside a sentence are exempt (WCAG 2.5.8 "inline").
        if (
          el.tagName === "A" &&
          el.parentElement &&
          text(el.parentElement.textContent) !== text(el.textContent)
        )
          return false;
        return true;
      });
      const issues = [];
      const circle = ({ r }) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2, rad: 12 });
      const hitsRect = (c, r) => {
        const nx = Math.max(r.left, Math.min(c.x, r.right));
        const ny = Math.max(r.top, Math.min(c.y, r.bottom));
        return (nx - c.x) ** 2 + (ny - c.y) ** 2 < c.rad ** 2;
      };
      for (const s of small) {
        const c = circle(s);
        const clash = rects.find(
          (o) =>
            o !== s &&
            !o.el.contains(s.el) &&
            !s.el.contains(o.el) &&
            (hitsRect(c, o.r) ||
              (small.includes(o) &&
                (() => {
                  const d = circle(o);
                  return (d.x - c.x) ** 2 + (d.y - c.y) ** 2 < (c.rad + d.rad) ** 2;
                })())),
        );
        if (clash)
          issues.push(
            `${desc(s.el)} is ${Math.round(s.r.width)}x${Math.round(s.r.height)} px and too close to ${desc(clash.el)}`,
          );
      }
      return issues;
    },
    motion() {
      const seconds = (list) =>
        Math.max(
          0,
          ...list.split(",").map((v) => {
            const n = Number.parseFloat(v);
            return v.trim().endsWith("ms") ? n / 1000 : n;
          }),
        );
      const issues = [];
      for (const el of document.querySelectorAll("*")) {
        for (const pseudo of [null, "::before", "::after"]) {
          const cs = getComputedStyle(el, pseudo);
          if (cs.animationName !== "none" && seconds(cs.animationDuration) > 0.01)
            issues.push(`${desc(el)}${pseudo ?? ""} animates for ${cs.animationDuration}`);
          if (
            cs.transitionProperty !== "none" &&
            seconds(cs.transitionDuration) > 0.01 &&
            !(cs.transitionProperty === "all" && cs.transitionDuration === "0s")
          )
            issues.push(`${desc(el)}${pseudo ?? ""} transitions for ${cs.transitionDuration}`);
        }
      }
      if (getComputedStyle(document.documentElement).scrollBehavior === "smooth")
        issues.push("html scrolls smoothly");
      return [...new Set(issues)].slice(0, 20);
    },
    reflow() {
      const doc = document.scrollingElement ?? document.documentElement;
      const vw = document.documentElement.clientWidth;
      const issues = [];
      if (doc.scrollWidth > vw + 1)
        issues.push(
          `page scrolls horizontally: ${doc.scrollWidth}px content in a ${vw}px viewport`,
        );
      const scrollsX = (el) => {
        for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
          const cs = getComputedStyle(p);
          if (cs.position === "fixed") return "fixed";
          if (["auto", "scroll"].includes(cs.overflowX)) return "scroll";
          if (["hidden", "clip"].includes(cs.overflowX)) return "clip";
        }
        return null;
      };
      const offenders = [];
      for (const el of document.querySelectorAll("#app *, #run *")) {
        if (!visible(el) || el.closest("[inert]")) continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        if (r.right <= vw + 1 && r.left >= -1) continue;
        const how = scrollsX(el);
        // A control in a fixed bar that sticks out of the viewport cannot be scrolled into view.
        if (how === "fixed" && el.matches("a[href], button, input, select, textarea")) {
          offenders.push(`${desc(el)} sits off screen in a fixed bar`);
          continue;
        }
        if (how === "scroll" || how === "fixed" || how === "clip") continue;
        if ([...el.children].some((c) => c.getBoundingClientRect().right > vw + 1)) continue;
        offenders.push(`${desc(el)} spans ${Math.round(r.left)}–${Math.round(r.right)}px`);
      }
      return [...issues, ...offenders.slice(0, 8)];
    },
    installLive() {
      const seen = new WeakMap();
      const log = [];
      window.__live = log;
      for (const r of document.querySelectorAll(LIVE)) seen.set(r, -1);
      const observer = new MutationObserver((mutations) => {
        const now = performance.now();
        const touched = new Set();
        for (const m of mutations) {
          for (const n of m.addedNodes) {
            if (n.nodeType !== 1) continue;
            const regions = [...(n.matches(LIVE) ? [n] : []), ...n.querySelectorAll(LIVE)];
            for (const r of regions)
              if (!seen.has(r)) {
                seen.set(r, now);
                const t = text(r.textContent);
                if (t) log.push({ kind: "inserted", region: desc(r), text: t.slice(0, 200) });
              }
          }
          const target = m.target.nodeType === 1 ? m.target : m.target.parentElement;
          const region = target?.closest?.(LIVE);
          if (region) touched.add(region);
        }
        for (const r of touched) {
          const born = seen.get(r);
          if (born === undefined || born === now || !r.isConnected) continue;
          const t = text(r.textContent);
          if (!t) continue;
          const hidden = Boolean(r.closest('[aria-hidden="true"], [inert]'));
          log.push({
            kind: hidden ? "hidden" : "announced",
            region: desc(r),
            text: t.slice(0, 200),
          });
        }
      });
      observer.observe(document.body, { subtree: true, childList: true, characterData: true });
    },
  };
}

// ── Fixture and server ────────────────────────────────────────────────────────────────────

function git(cwd, ...rest) {
  execFileSync(
    "git",
    [
      "-c",
      "user.name=SmartTest",
      "-c",
      "user.email=ci@smarttest.dev",
      "-c",
      "commit.gpgsign=false",
      ...rest,
    ],
    { cwd, stdio: "pipe" },
  );
}

async function makeFixture() {
  const dir = await mkdtemp(join(tmpdir(), "st-studio-a11y-"));
  await cp(FIXTURE, dir, {
    recursive: true,
    filter: (p) => !p.includes("node_modules") && !p.includes(".smarttest"),
  });
  await symlink(join(FIXTURE, "node_modules"), join(dir, "node_modules"), "dir");
  await writeFile(join(dir, ".gitignore"), "node_modules\n.smarttest/\n");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "initial");
  // One real change that a selected test catches, so the run drawer shows a failure.
  const file = join(dir, "src/util/strings.ts");
  const source = await readFile(file, "utf8");
  await writeFile(file, source.replace("s.charAt(0).toUpperCase()", "s.charAt(0)"));
  return dir;
}

function buildStudio() {
  execFileSync(
    process.execPath,
    [join(ROOT, "node_modules/typescript/bin/tsc"), "-b", "packages/studio/tsconfig.json"],
    { cwd: ROOT, stdio: "inherit" },
  );
}

// ── One browser and theme ─────────────────────────────────────────────────────────────────

class Combo {
  constructor(name, theme, handle) {
    this.name = name;
    this.theme = theme;
    this.handle = handle;
    this.origin = `http://127.0.0.1:${handle.port}`;
    this.visits = 0;
    this.result = { browser: name, theme, states: {}, failures: [], advisories: [] };
  }

  state(name) {
    this.result.states[name] ??= {};
    return this.result.states[name];
  }

  fail(state, check, detail) {
    this.result.failures.push({ state, check, detail });
  }

  advise(state, check, detail) {
    this.result.advisories.push({ state, check, detail });
  }

  url(path, { token = true } = {}) {
    const sep = path.includes("?") ? "&" : "?";
    this.visits += 1;
    return `${this.origin}${path}${sep}theme=${this.theme}&v=${this.visits}${token ? `#token=${this.handle.token}` : ""}`;
  }

  async open(page, screen) {
    await page.goto(this.url(screen.path));
    await page.waitForFunction(
      (title) => {
        const h1 = document.querySelector("#main h1");
        return (
          h1 &&
          h1.textContent.trim() === title &&
          !document.querySelector("#main .loading") &&
          !document.body.textContent.includes("Reading the file…")
        );
      },
      screen.title,
      { timeout: 90_000 },
    );
    await page.waitForTimeout(200);
  }

  async axe(page, state, { include = null } = {}) {
    let builder = new AxeBuilder({ page }).withTags(WCAG_TAGS);
    if (include) builder = builder.include(include);
    const wcag = await builder.analyze();
    let bp = new AxeBuilder({ page }).withTags(["best-practice"]);
    if (include) bp = bp.include(include);
    const best = await bp.analyze();
    const shape = (v) => ({
      id: v.id,
      impact: v.impact,
      help: v.help,
      nodes: v.nodes
        .slice(0, 6)
        .map((n) => ({ target: n.target.join(" "), summary: n.failureSummary })),
      count: v.nodes.length,
    });
    const record = this.state(state);
    record.axe = wcag.violations.map(shape);
    record.axeIncomplete = wcag.incomplete.map((v) => ({ id: v.id, count: v.nodes.length }));
    record.bestPractice = best.violations.map(shape);
    for (const v of wcag.violations)
      this.fail(
        state,
        `axe:${v.id}`,
        `${v.help} (${v.nodes.length}) ${v.nodes[0]?.target.join(" ")}`,
      );
    for (const v of best.violations)
      this.advise(
        state,
        `axe-bp:${v.id}`,
        `${v.help} (${v.nodes.length}) ${v.nodes[0]?.target.join(" ")}`,
      );
  }

  async snapshot(page, state) {
    const tree = await page.locator("body").ariaSnapshot();
    const dir = join(OUT, "aria");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${this.name}-${this.theme}-${state}.yml`), `${tree}\n`);
  }

  async page(context) {
    const page = await context.newPage();
    page.on("pageerror", (error) => this.fail("page", "script-error", error.message));
    return page;
  }

  async structure(page, state) {
    const { issues } = await page.evaluate(() => window.__a11y.structure());
    for (const issue of issues) this.fail(state, "structure", issue);
  }

  async targets(page, state) {
    for (const issue of await page.evaluate(() => window.__a11y.targets()))
      this.fail(state, "target-size", issue);
  }

  async motion(page, state) {
    for (const issue of await page.evaluate(() => window.__a11y.motion()))
      this.fail(state, "reduced-motion", issue);
  }

  /**
   * Presses Tab until focus wraps. Every stop must be a new control, show a visible change when
   * focused and not be entirely hidden. Every visible control must be reached.
   */
  async walk(page, state, { pixels = !args["skip-focus-pixels"], max = 260, within = null } = {}) {
    const expected = await page.evaluate(() => window.__a11y.expected());
    const stops = [];
    let first = null;
    let bodies = 0;
    let wrapped = false;
    for (let i = 0; i < max; i++) {
      await this.tab(page);
      let info = await page.evaluate(() => window.__a11y.focusInfo());
      // Headless Firefox keeps focus on the last control instead of moving into browser UI. A
      // real Firefox moves on to its toolbar and comes back to the first control: do that here.
      if (
        !within &&
        !wrapped &&
        info.key === stops.at(-1) &&
        (await page.evaluate(() => window.__a11y.isLast()))
      ) {
        wrapped = true;
        await page.evaluate(() => window.__a11y.focusFirst());
        await this.settle(page);
        info = await page.evaluate(() => window.__a11y.focusInfo());
      }
      if (info.key === "body") {
        // Past the last control the browser moves focus to its own UI, then wraps.
        if (++bodies > 2) {
          this.fail(state, "keyboard", "Tab leaves focus on the page body");
          break;
        }
        continue;
      }
      if (info.key === first) break;
      if (within === "dialog" && !info.inDialog)
        this.fail(state, "keyboard", `Tab left the modal dialog for ${info.desc}`);
      if (stops.at(-1) === info.key) {
        this.fail(state, "keyboard-trap", `Tab stays on ${info.desc}`);
        break;
      }
      if (stops.includes(info.key)) {
        if (within === "dialog") break;
        this.fail(state, "keyboard", `Tab order revisits ${info.desc} before wrapping`);
        break;
      }
      first ??= info.key;
      stops.push(info.key);
      // WebKit can apply :focus styles late (the skip link moves on screen only then): look again.
      for (let retry = 0; retry < 4 && info.obscured === "entirely"; retry++) {
        await page.waitForTimeout(200);
        info = await page.evaluate(() => window.__a11y.focusInfo());
      }
      if (info.obscured === "entirely") {
        const dismissible = info.obscuredBy === "run drawer";
        (dismissible ? this.advise : this.fail).call(
          this,
          state,
          "focus-obscured",
          `${info.desc} is hidden behind ${info.obscuredBy ?? "the viewport edge"}${dismissible ? " (Escape closes it)" : ""}`,
        );
      }
      if (pixels && info.rect && info.obscured !== "entirely") {
        const changed = await this.focusChange(page, info);
        if (changed !== null && changed < 12)
          this.fail(
            state,
            "focus-visible",
            `${info.desc} shows no visible focus change (${changed} px)`,
          );
      }
      if (i === max - 1) this.fail(state, "keyboard-trap", `no wrap after ${max} Tab presses`);
    }
    if (!within) {
      const reached = new Set(stops);
      const missing = expected.filter((key) => !reached.has(key));
      for (const key of missing.slice(0, 10))
        this.fail(state, "keyboard-reach", `Tab never reaches ${key}`);
    }
    this.state(state).tabStops = stops.length;
    this.state(state).tabOrder = stops;
    return stops;
  }

  async focusChange(page, info) {
    const vp = page.viewportSize();
    const x = Math.max(0, Math.floor(info.rect.x - 6));
    const y = Math.max(0, Math.floor(info.rect.y - 6));
    const width = Math.min(vp.width - x, Math.ceil(info.rect.width + 12));
    const height = Math.min(vp.height - y, Math.ceil(info.rect.height + 12));
    if (width < 2 || height < 2) return null;
    const clip = { x, y, width, height };
    const shot = () => page.screenshot({ clip, animations: "disabled", caret: "hide" });
    const focused = await shot();
    await page.evaluate(() => window.__a11y.blur());
    const blurred = await shot();
    // Put focus back from the keyboard so :focus-visible and the Tab position stay true.
    await this.tab(page, "Shift+Tab");
    await this.tab(page);
    const again = await page.evaluate(() => window.__a11y.focusInfo());
    if (again.key !== info.key) await page.evaluate((key) => window.__a11y.focusKey(key), info.key);
    return page.evaluate(
      ([a, b]) => window.__a11y.pixelDiff(a, b),
      [focused.toString("base64"), blurred.toString("base64")],
    );
  }

  /** Waits two frames: Firefox and WebKit apply :focus styles a frame after a key press. */
  async settle(page) {
    await page.evaluate(
      () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
    );
  }

  async tab(page, keys = "Tab") {
    await page.keyboard.press(keys);
    await this.settle(page);
  }

  // ── Scenarios ──────────────────────────────────────────────────────────────────────────

  async pairing(context) {
    const page = await this.page(context);
    await page.goto(this.url("/overview", { token: false }));
    await page.waitForSelector(".pairing__card");
    await this.axe(page, "pairing");
    await this.snapshot(page, "pairing");
    await this.structure(page, "pairing");
    await this.walk(page, "pairing");
    await page.close();
  }

  async skipLink(page) {
    await this.open(page, SCREENS[0]);
    await this.tab(page);
    const info = await page.evaluate(() => ({
      ...window.__a11y.focusInfo(),
      isSkip: document.activeElement?.classList.contains("skip-link"),
    }));
    if (!info.isSkip) return this.fail("overview", "skip-link", `first Tab stop is ${info.desc}`);
    if (info.obscured)
      this.fail("overview", "skip-link", `skip link is ${info.obscured} hidden when focused`);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(150);
    const after = await page.evaluate(() => document.activeElement?.id ?? "");
    if (after !== "main")
      this.fail("overview", "skip-link", `Enter on the skip link focuses "${after || "body"}"`);
    const h1 = await page.locator("#main h1").count();
    if (!h1) this.fail("overview", "skip-link", "following the skip link lost the screen");
  }

  async liveRun(page) {
    await this.open(page, SCREENS[0]);
    await page.evaluate(() => window.__a11y.installLive());
    const opener = page.locator('#main header [data-fk="run-affected"]');
    await opener.focus();
    await page.keyboard.press("Enter");
    await page.waitForSelector('#run[data-open="true"]', { timeout: 30_000 });
    await page.waitForTimeout(400);
    const during = await page.evaluate(() => window.__a11y.focusInfo());
    if (!during.inDrawer)
      this.fail("run-drawer", "focus-management", `opening the run leaves focus on ${during.desc}`);
    await page.waitForFunction(
      () =>
        document.querySelector('#run[data-open="true"]') &&
        !document.querySelector('[data-fk="run-cancel"]') &&
        document.querySelector("#run .drawer__foot")?.textContent.includes("finished"),
      null,
      { timeout: 180_000 },
    );
    await page.waitForTimeout(1200);
    const log = await page.evaluate(() => window.__live);
    const announced = log.filter((entry) => entry.kind === "announced").map((entry) => entry.text);
    this.state("run-drawer").announcements = log;
    if (!announced.some((t) => /Selecting tests|Running tests|Running/.test(t)))
      this.fail(
        "run-drawer",
        "aria-live",
        `run progress is not announced (log: ${JSON.stringify(log.slice(0, 6))})`,
      );
    if (
      !announced.some((t) =>
        /Run (passed|finished|hit)|No test|Nothing to run|Run cancelled/.test(t),
      )
    )
      this.fail("run-drawer", "aria-live", "the final verdict is not announced");
    if (announced.length > 25)
      this.advise("run-drawer", "aria-live", `${announced.length} announcements in one run`);
    await this.axe(page, "run-drawer");
    await this.snapshot(page, "run-drawer");
    await this.motion(page, "run-drawer");
    await this.targets(page, "run-drawer");
    // Keyboard inside the drawer: Tab from the close button never gets stuck.
    await this.walk(page, "run-drawer", { pixels: false });
    // Escape returns focus to the control that started the run.
    await page.locator('[data-fk="run-close"]').focus();
    await page.keyboard.press("Escape");
    await page.waitForSelector('#run[data-open="false"]');
    await page.waitForTimeout(150);
    const back = await page.evaluate(
      () => document.activeElement?.dataset?.fk ?? window.__a11y.desc(document.activeElement),
    );
    if (back !== "run-affected")
      this.fail("run-drawer", "focus-return", `Escape returns focus to ${back}`);

    // The recorded run reopened from the overview.
    await this.open(page, SCREENS[0]);
    const openRun = page.getByRole("button", { name: "Open run" });
    if (!(await openRun.count()))
      return this.fail("overview", "last-run", "no Open run button after a run");
    await openRun.focus();
    await page.keyboard.press("Enter");
    await page.waitForSelector('#run[data-open="true"]');
    await page.waitForTimeout(300);
    const inside = await page.evaluate(() => window.__a11y.focusInfo());
    if (!inside.inDrawer)
      this.fail("run-drawer", "focus-management", `Open run leaves focus on ${inside.desc}`);
    await page.keyboard.press("Escape");
    await page.waitForSelector('#run[data-open="false"]');
    await page.waitForTimeout(150);
    const returned = await page.evaluate(() => window.__a11y.desc(document.activeElement));
    if (!returned.includes("Open run"))
      this.fail("run-drawer", "focus-return", `Escape after Open run focuses ${returned}`);
  }

  async screens(page) {
    for (const screen of SCREENS) {
      await this.open(page, screen);
      await this.axe(page, screen.id);
      await this.snapshot(page, screen.id);
      await this.structure(page, screen.id);
      await this.targets(page, screen.id);
      await this.motion(page, screen.id);
      await this.walk(page, screen.id);
      if (screen.id === "tests") await this.testsScreen(page);
      if (screen.id === "impact") await this.impactScreen(page);
    }
  }

  async impactScreen(page) {
    const rows = page.locator("#main .list__scroll .list__item");
    if ((await rows.count()) > 1) {
      await rows.nth(1).focus();
      await page.keyboard.press("Enter");
      await page.waitForTimeout(400);
      await this.axe(page, "impact-second-file");
    }
  }

  async testsScreen(page) {
    await this.open(page, SCREENS[2]);
    await page.evaluate(() => window.__a11y.installLive());
    const tab = page.locator('[role="tab"][aria-selected="true"]');
    await tab.focus();
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(150);
    const moved = await page.evaluate(() => ({
      id: document.activeElement?.id,
      selected: document.activeElement?.getAttribute("aria-selected"),
    }));
    if (moved.selected !== "true")
      this.fail("tests", "tabs", `ArrowRight focuses ${moved.id} without selecting it`);
    await this.axe(page, "tests-selected-tab");
    await page.keyboard.press("ArrowLeft");
    const search = page.locator('[data-search="tests"]');
    await search.focus();
    await page.keyboard.type("strings");
    await page.waitForTimeout(900);
    const log = await page.evaluate(() => window.__live);
    const said = log.filter((e) => e.kind === "announced").map((e) => e.text);
    if (!said.some((t) => /shown|match/.test(t)))
      this.fail(
        "tests",
        "aria-live",
        `filtering does not announce the result count (${JSON.stringify(log.slice(0, 4))})`,
      );
    await this.axe(page, "tests-filtered");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    const cleared = await search.inputValue();
    if (cleared) this.fail("tests", "keyboard", "Escape does not clear the filter");
  }

  async dialog(page) {
    await this.open(page, SCREENS[0]);
    const help = page.getByRole("button", { name: "Keyboard shortcuts" });
    await help.focus();
    await page.keyboard.press("Enter");
    await page.waitForSelector('[role="dialog"]');
    await page.waitForTimeout(150);
    const inside = await page.evaluate(() => window.__a11y.focusInfo());
    if (!inside.inDialog)
      this.fail(
        "shortcuts-dialog",
        "focus-management",
        `dialog opens with focus on ${inside.desc}`,
      );
    await this.axe(page, "shortcuts-dialog");
    await this.snapshot(page, "shortcuts-dialog");
    await this.targets(page, "shortcuts-dialog");
    await this.walk(page, "shortcuts-dialog", { within: "dialog", max: 12 });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
    if (await page.locator('[role="dialog"]').count())
      this.fail("shortcuts-dialog", "keyboard", "Escape does not close the dialog");
    const back = await page.evaluate(() => window.__a11y.desc(document.activeElement));
    if (!back.includes("Keyboard shortcuts"))
      this.fail("shortcuts-dialog", "focus-return", `Escape returns focus to ${back}`);
    // WCAG 2.1.4: single-key shortcuts can be turned off from the same dialog.
    await help.focus();
    await page.keyboard.press("Enter");
    await page.waitForSelector('[role="dialog"]');
    const toggle = page.getByRole("checkbox", { name: /single-key shortcuts/i });
    if (!(await toggle.count())) {
      this.fail(
        "shortcuts-dialog",
        "character-key-shortcuts",
        "no way to turn off single-key shortcuts",
      );
      await page.keyboard.press("Escape");
    } else {
      await toggle.focus();
      await page.keyboard.press("Space");
      await page.keyboard.press("Escape");
      await page.locator("#main").focus();
      await page.keyboard.press("?");
      await page.waitForTimeout(200);
      if (await page.locator('[role="dialog"]').count()) {
        this.fail(
          "shortcuts-dialog",
          "character-key-shortcuts",
          "? still opens the dialog when single-key shortcuts are off",
        );
        await page.keyboard.press("Escape");
      }
      await help.focus();
      await page.keyboard.press("Enter");
      await page.waitForSelector('[role="dialog"]');
      await toggle.focus();
      await page.keyboard.press("Space");
      await page.keyboard.press("Escape");
    }
    // The ? shortcut from the page body.
    await page.locator("#main").focus();
    await page.keyboard.press("?");
    await page.waitForSelector('[role="dialog"]');
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
    const fromKey = await page.evaluate(() => document.activeElement?.id ?? "");
    if (fromKey !== "main")
      this.fail(
        "shortcuts-dialog",
        "focus-return",
        `? then Escape returns focus to "${fromKey || "body"}"`,
      );
  }

  async reflow(browser) {
    for (const width of [320, 640]) {
      const context = await browser.newContext({
        viewport: { width, height: 720 },
        colorScheme: this.theme,
        reducedMotion: "reduce",
        bypassCSP: true,
      });
      await context.addInitScript(pageHelpers);
      const page = await this.page(context);
      for (const screen of SCREENS) {
        const state = `${screen.id}@${width}`;
        await this.open(page, screen);
        for (const issue of await page.evaluate(() => window.__a11y.reflow()))
          this.fail(state, "reflow", issue);
        await this.targets(page, state);
        if (width === 320) {
          await this.axe(page, state);
          await this.walk(page, state, { pixels: false });
        }
      }
      const openRun = page.getByRole("button", { name: "Open run" });
      await this.open(page, SCREENS[0]);
      if (await openRun.count()) {
        await openRun.click();
        await page.waitForSelector('#run[data-open="true"]');
        await page.waitForTimeout(300);
        for (const issue of await page.evaluate(() => window.__a11y.reflow()))
          this.fail(`run-drawer@${width}`, "reflow", issue);
        if (width === 320) await this.walk(page, `run-drawer@${width}`, { pixels: false });
      }
      await context.close();
    }
  }

  async run(engine) {
    let browser;
    try {
      browser = await engine.launch(await launchOptions(this.name));
    } catch (error) {
      this.fail("audit", "launch", String(error.message).split("\n").slice(0, 4).join(" "));
      return this.result;
    }
    try {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 900 },
        colorScheme: this.theme,
        reducedMotion: "reduce",
        bypassCSP: true,
      });
      await context.addInitScript(pageHelpers);
      await this.pairing(context);
      const page = await this.page(context);
      await this.skipLink(page);
      await this.liveRun(page);
      await this.screens(page);
      await this.dialog(page);
      await context.close();
      if (!args["skip-reflow"]) await this.reflow(browser);
    } catch (error) {
      this.fail("audit", "crash", error.stack ?? String(error));
    } finally {
      await browser.close();
    }
    return this.result;
  }
}

/**
 * Launch options per engine. With --webkit-libs, WebKit starts through a small shim that adds
 * those libraries after the bundle's own; the browser cache itself is never modified.
 */
async function launchOptions(name) {
  if (name !== "webkit" || !args["webkit-libs"]) return {};
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(homedir(), ".cache/ms-playwright");
  const browsersJson = join(ROOT, "node_modules/playwright-core/browsers.json");
  const { browsers: list } = JSON.parse(await readFile(browsersJson, "utf8"));
  const dir = join(cache, `webkit-${list.find((b) => b.name === "webkit").revision}`);
  const wpe = join(dir, "minibrowser-wpe");
  const shim = join(OUT, "webkit-shim.sh");
  await writeFile(
    shim,
    [
      "#!/bin/sh",
      `export WEBKIT_EXEC_PATH="${wpe}/bin"`,
      `export WEBKIT_INJECTED_BUNDLE_PATH="${wpe}/lib"`,
      `export WEBKIT_INSPECTOR_RESOURCES_PATH="${wpe}/share"`,
      `export LD_LIBRARY_PATH="${wpe}/lib:${wpe}/sys/lib:${resolve(args["webkit-libs"])}"`,
      'export WEBKIT_FORCE_COMPLEX_TEXT="1"',
      `exec "${wpe}/bin/MiniBrowser" "$@"`,
      "",
    ].join("\n"),
  );
  await chmod(shim, 0o755);
  return { executablePath: shim };
}

// ── Main ──────────────────────────────────────────────────────────────────────────────────

function summarise(results) {
  const lines = ["# Studio accessibility audit", ""];
  lines.push("| Browser | Theme | Failures | Advisories |", "| --- | --- | --- | --- |");
  for (const r of results)
    lines.push(`| ${r.browser} | ${r.theme} | ${r.failures.length} | ${r.advisories.length} |`);
  for (const r of results) {
    if (!r.failures.length && !r.advisories.length) continue;
    lines.push("", `## ${r.browser} · ${r.theme}`, "");
    for (const f of r.failures) lines.push(`- FAIL [${f.state}] ${f.check}: ${f.detail}`);
    for (const a of r.advisories) lines.push(`- advisory [${a.state}] ${a.check}: ${a.detail}`);
  }
  return `${lines.join("\n")}\n`;
}

async function main() {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  console.log("Building @smarttest/studio…");
  buildStudio();
  const { startStudio } = await import(
    pathToFileURL(join(ROOT, "packages/studio/dist/index.js")).href
  );
  const fixture = await makeFixture();
  const handle = await startStudio({
    root: fixture,
    port: 0,
    watch: false,
    storeDir: join(fixture, ".smarttest"),
    ...(args.assets ? { assetDir: resolve(args.assets) } : {}),
  });
  console.log(`Studio on http://127.0.0.1:${handle.port} for ${fixture}`);
  const results = [];
  try {
    for (const name of browsers)
      for (const theme of themes) {
        const started = Date.now();
        const result = await new Combo(name, theme, handle).run(ENGINES[name]);
        results.push(result);
        console.log(
          `${name.padEnd(8)} ${theme.padEnd(5)} ${String(result.failures.length).padStart(3)} failures, ${String(result.advisories.length).padStart(3)} advisories (${Math.round((Date.now() - started) / 1000)} s)`,
        );
      }
  } finally {
    await handle.close();
    await rm(fixture, { recursive: true, force: true });
  }
  await writeFile(join(OUT, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
  const summary = summarise(results);
  await writeFile(join(OUT, "summary.md"), summary);
  console.log(`\n${summary}`);
  console.log(`Report: ${join(OUT, "summary.md")}\nAccessibility trees: ${join(OUT, "aria")}`);
  process.exitCode = results.some((r) => r.failures.length) ? 1 : 0;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 2;
});
