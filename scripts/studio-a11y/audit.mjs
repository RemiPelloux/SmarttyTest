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
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import AxeBuilder from "@axe-core/playwright";
import { chromium, firefox, webkit } from "playwright-core";
import { pageHelpers } from "./page-helpers.mjs";
import { ROOT, SCREENS, startStudioOnFixture, WCAG_TAGS } from "./studio-server.mjs";

const ENGINES = { chromium, firefox, webkit };

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
  const studio = await startStudioOnFixture({ assets: args.assets });
  const { handle, fixture } = studio;
  console.log(`Studio on ${studio.origin} for ${fixture}`);
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
    await studio.close();
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
