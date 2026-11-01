#!/usr/bin/env node
/**
 * Studio in real Safari, through safaridriver (WebDriver): axe-core (WCAG 2.2 AA tags) on every
 * screen in both themes, plus the keyboard checks of ../audit.mjs that WebDriver can drive:
 * skip link, Tab order (every control reached, no trap, :focus-visible on each stop), the live run
 * (focus moves into the drawer, progress and verdict reach the persistent live region, Escape
 * returns focus), the shortcuts dialog (focus moves in, Escape closes and returns focus) and the
 * arrow keys on tabs.
 *
 * Safari's Tab key skips links unless "Press Tab to highlight each item on a webpage" is on;
 * Option+Tab always reaches them. The check finds which one this Safari uses and says so.
 *
 * Usage (macOS, after `sudo safaridriver --enable`; in CI see .github/workflows/studio-a11y.yml):
 *   cd scripts/studio-a11y/real && npm ci && node safari.mjs [--browser=safari|chrome] [--out=<dir>]
 *
 * --browser=chrome runs the same WebDriver checks in Chrome, to work on this script off a Mac.
 * Exit code 0 when every gated check passes, 1 when one fails, 2 when the check itself broke.
 */
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs, promisify } from "node:util";
import { Builder, Key } from "selenium-webdriver";
import chrome from "selenium-webdriver/chrome.js";
import { pageHelpers } from "../page-helpers.mjs";
import { SCREENS, startStudioOnFixture, WCAG_TAGS } from "../studio-server.mjs";

const { values: args } = parseArgs({
  options: {
    browser: { type: "string", default: "safari" },
    themes: { type: "string", default: "light,dark" },
    out: { type: "string", default: join(tmpdir(), "smarttest-studio-safari") },
  },
});
const OUT = resolve(args.out);
const AXE = await readFile(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const osa = promisify(execFile);

/**
 * Brings Safari to the front (macOS only). Keys sent through WebDriver reach the page either
 * way, but WebKit restyles :focus reliably only for an active window.
 */
async function activateSafari() {
  if (process.platform !== "darwin" || args.browser !== "safari") return;
  await osa("osascript", ["-e", 'tell application "Safari" to activate']).catch((error) =>
    console.log(`osascript activate failed: ${error.message}`),
  );
  await sleep(300);
}

const failures = [];
const advisories = [];
const states = {};
const fail = (state, check, detail) => failures.push({ state, check, detail });
const advise = (state, check, detail) => advisories.push({ state, check, detail });

class Session {
  constructor(driver, studio, theme) {
    this.driver = driver;
    this.studio = studio;
    this.theme = theme;
    /** Keys that move focus to the next control: Tab, or Option+Tab when Tab skips links. */
    this.option = false;
  }

  /** Runs `fn` in the page with the helpers installed; arguments and result are JSON values. */
  async page(fn, ...rest) {
    return this.driver.executeScript(
      `if (!window.__a11y) (${pageHelpers})(); return (${fn}).apply(null, arguments);`,
      ...rest,
    );
  }

  async waitFor(fn, { timeout = 90_000, what = "condition", arg = null } = {}) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await this.page(fn, arg)) return;
      await sleep(150);
    }
    throw new Error(`timed out after ${timeout} ms waiting for ${what}`);
  }

  async open(screen) {
    await this.driver.get(this.studio.url(screen.path, { theme: this.theme }));
    await this.waitFor(
      (title) => {
        const h1 = document.querySelector("#main h1");
        return (
          h1 &&
          h1.textContent.trim() === title &&
          !document.querySelector("#main .loading") &&
          !document.body.textContent.includes("Reading the file…")
        );
      },
      { what: `the ${screen.title} screen`, arg: screen.title },
    );
    // Parts of a screen load after its heading (the Impact screen's code peek): wait until the
    // set of focusable controls stops changing, or the Tab walk sees the page change under it.
    let last = "";
    for (let stable = 0, i = 0; stable < 3 && i < 40; i++) {
      await sleep(200);
      const now = (await this.page(() => window.__a11y.expected())).join("\n");
      stable = now === last ? stable + 1 : 0;
      last = now;
    }
  }

  async axe(state) {
    if (!(await this.driver.executeScript("return Boolean(window.axe)")))
      await this.driver.executeScript(AXE);
    const result = await this.driver.executeAsyncScript(
      `const done = arguments[arguments.length - 1];
       window.axe
         .run(document, { runOnly: { type: "tag", values: arguments[0] }, resultTypes: ["violations"] })
         .then((r) => done({ violations: r.violations.map((v) => ({
           id: v.id, impact: v.impact, help: v.help, count: v.nodes.length,
           nodes: v.nodes.slice(0, 6).map((n) => ({ target: n.target.join(" "), summary: n.failureSummary })),
         })) }))
         .catch((e) => done({ error: String(e && e.stack || e) }));`,
      WCAG_TAGS,
    );
    if (result.error) return fail(state, "axe", result.error);
    states[`${state}:${this.theme}`] = { axe: result.violations };
    for (const v of result.violations)
      fail(`${state}:${this.theme}`, `axe:${v.id}`, `${v.help} (${v.count}) ${v.nodes[0]?.target}`);
  }

  async key(key, { option = false } = {}) {
    let chain = this.driver.actions({ async: true });
    chain = option ? chain.keyDown(Key.ALT).sendKeys(key).keyUp(Key.ALT) : chain.sendKeys(key);
    await chain.perform();
    await this.driver.executeAsyncScript(
      "const done = arguments[0]; requestAnimationFrame(() => requestAnimationFrame(() => done()));",
    );
  }

  tab() {
    return this.key(Key.TAB, { option: this.option });
  }

  focusInfo() {
    return this.page(() => ({
      ...window.__a11y.focusInfo(),
      fk: document.activeElement?.dataset?.fk ?? null,
      id: document.activeElement?.id ?? "",
      isSkip: Boolean(document.activeElement?.classList.contains("skip-link")),
      isLink: document.activeElement?.tagName === "A",
    }));
  }

  /** Finds the key that reaches links (the skip link is the first stop) and checks the skip link. */
  async skipLink() {
    for (const option of [false, true]) {
      await this.open(SCREENS[0]);
      await activateSafari();
      this.option = option;
      await this.tab();
      const info = await this.focusInfo();
      if (!info.isSkip) continue;
      if (option)
        advise(
          "overview",
          "safari-tab-to-links",
          "Tab skips links in this Safari (its default); the checks use Option+Tab",
        );
      if (info.obscured) fail("overview", "skip-link", `skip link is ${info.obscured} hidden`);
      await this.key(Key.ENTER);
      await sleep(150);
      const after = await this.focusInfo();
      if (after.id !== "main")
        fail("overview", "skip-link", `Enter on the skip link focuses "${after.desc}"`);
      return;
    }
    this.option = true;
    fail("overview", "skip-link", "neither Tab nor Option+Tab reaches the skip link first");
  }

  /** Presses Tab until focus wraps; every control must be reached, visibly, without a trap. */
  async walk(state, { max = 260, within = null } = {}) {
    await activateSafari();
    const expected = await this.page(() => window.__a11y.expected());
    const stops = [];
    let first = null;
    let bodies = 0;
    for (let i = 0; i < max; i++) {
      await this.tab();
      const info = await this.focusInfo();
      if (info.key === "body") {
        if (++bodies > 3) {
          fail(state, "keyboard", "Tab leaves focus on the page body");
          break;
        }
        continue;
      }
      if (info.key === first) break;
      if (within === "dialog" && !info.inDialog)
        fail(state, "keyboard", `Tab left the modal dialog for ${info.desc}`);
      if (stops.at(-1) === info.key) {
        fail(state, "keyboard-trap", `Tab stays on ${info.desc}`);
        break;
      }
      if (stops.includes(info.key)) {
        if (within === "dialog") break;
        fail(state, "keyboard", `Tab order revisits ${info.desc} before wrapping`);
        break;
      }
      first ??= info.key;
      stops.push(info.key);
      if (!info.focusVisible)
        fail(state, "focus-visible", `${info.desc} does not match :focus-visible`);
      // As in ../audit.mjs: WebKit can apply :focus styles (the skip link's move on screen) a
      // little late, so an entirely hidden stop is measured again before it counts.
      // Under automation Safari's window can also lose its active state, and WebKit then stops
      // restyling for focus: bring Safari to the front before measuring again.
      let obscured = info;
      for (let retry = 0; retry < 4 && obscured.obscured === "entirely"; retry++) {
        if (retry === 1) await activateSafari();
        await sleep(200);
        obscured = await this.focusInfo();
      }
      // Safari under WebDriver has been seen to keep a focused element's unfocused style:
      // :focus matches, yet getComputedStyle still shows the unfocused rule. An inline-style
      // change forces WebKit to restyle that one element; if the page's own :focus rule then
      // shows it, the page is right and the stale style is the automation's, which is recorded.
      if (obscured.obscured === "entirely") {
        const stale = await this.page(() => {
          const el = document.activeElement;
          if (!el?.matches(":focus")) return null;
          const before = getComputedStyle(el).left;
          el.style.setProperty("--st-restyle", "1");
          void el.offsetWidth;
          el.style.removeProperty("--st-restyle");
          void el.offsetWidth;
          const after = getComputedStyle(el).left;
          return before !== after ? `${before} → ${after}` : null;
        });
        if (stale) {
          const again = await this.focusInfo();
          if (again.obscured !== "entirely") {
            advise(
              state,
              "webkit-stale-focus-style",
              `${info.desc} kept its unfocused style until restyled (left ${stale}); the page's :focus rule is correct`,
            );
            obscured = again;
          }
        }
      }
      if (obscured.obscured === "entirely" && obscured.obscuredBy !== "run drawer") {
        const where = await this.page(() => {
          const el = document.activeElement;
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          return [
            `rect ${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`,
            `scrollY ${Math.round(scrollY)}`,
            `viewport ${innerWidth}x${innerHeight}`,
            `hasFocus ${document.hasFocus()}`,
            `:focus ${el.matches(":focus")}`,
            `:focus-visible ${el.matches(":focus-visible")}`,
            `computed ${cs.position} left ${cs.left}`,
            `visibility ${document.visibilityState}`,
          ].join(", ");
        });
        fail(
          state,
          "focus-obscured",
          `${info.desc} is hidden behind ${obscured.obscuredBy ?? "the edge"} (${where})`,
        );
      }
      if (i === max - 1) fail(state, "keyboard-trap", `no wrap after ${max} Tab presses`);
    }
    if (!within) {
      const reached = new Set(stops);
      for (const key of expected.filter((k) => !reached.has(k)).slice(0, 10))
        fail(state, "keyboard-reach", `Tab never reaches ${key}`);
    }
    states[state] = { ...states[state], tabStops: stops.length };
    return stops;
  }

  async structure(state) {
    const { issues } = await this.page(() => window.__a11y.structure());
    for (const issue of issues) fail(state, "structure", issue);
  }

  async liveRun() {
    await this.open(SCREENS[0]);
    await this.page(() => window.__a11y.installLive());
    await this.page(() => document.querySelector('#main header [data-fk="run-affected"]').focus());
    await this.key(Key.ENTER);
    await this.waitFor(() => document.querySelector('#run[data-open="true"]'), {
      timeout: 30_000,
      what: "the run drawer",
    });
    await sleep(400);
    const during = await this.focusInfo();
    if (!during.inDrawer)
      fail("run-drawer", "focus-management", `opening the run leaves focus on ${during.desc}`);
    await this.waitFor(
      () =>
        document.querySelector('#run[data-open="true"]') &&
        !document.querySelector('[data-fk="run-cancel"]') &&
        document.querySelector("#run .drawer__foot")?.textContent.includes("finished"),
      { timeout: 180_000, what: "the run to finish" },
    );
    await sleep(1200);
    const log = await this.page(() => window.__live);
    const said = log.filter((e) => e.kind === "announced").map((e) => e.text);
    states["run-drawer"] = { announcements: log };
    if (!said.some((t) => /Selecting tests|Running/.test(t)))
      fail(
        "run-drawer",
        "aria-live",
        `progress is not announced (${JSON.stringify(log.slice(0, 6))})`,
      );
    if (!said.some((t) => /Run (passed|finished|hit)|No test|Nothing to run/.test(t)))
      fail("run-drawer", "aria-live", "the final verdict is not announced");
    await this.axe("run-drawer");
    await this.walk("run-drawer");
    await this.page(() => document.querySelector('[data-fk="run-close"]').focus());
    await this.key(Key.ESCAPE);
    await this.waitFor(() => document.querySelector('#run[data-open="false"]'), {
      what: "the drawer to close",
    });
    await sleep(150);
    const back = await this.focusInfo();
    if (back.fk !== "run-affected")
      fail("run-drawer", "focus-return", `Escape returns focus to ${back.desc}`);
  }

  async dialog() {
    await this.open(SCREENS[0]);
    await this.page(() =>
      [...document.querySelectorAll("button")]
        .find((b) => b.getAttribute("aria-label") === "Keyboard shortcuts")
        ?.focus(),
    );
    await this.key(Key.ENTER);
    await this.waitFor(() => document.querySelector('[role="dialog"]'), { what: "the dialog" });
    await sleep(150);
    const inside = await this.focusInfo();
    if (!inside.inDialog)
      fail("shortcuts-dialog", "focus-management", `dialog opens with focus on ${inside.desc}`);
    await this.axe("shortcuts-dialog");
    await this.walk("shortcuts-dialog", { within: "dialog", max: 12 });
    await this.key(Key.ESCAPE);
    await sleep(200);
    if (await this.page(() => Boolean(document.querySelector('[role="dialog"]'))))
      fail("shortcuts-dialog", "keyboard", "Escape does not close the dialog");
    const back = await this.focusInfo();
    if (!back.desc.includes("Keyboard shortcuts"))
      fail("shortcuts-dialog", "focus-return", `Escape returns focus to ${back.desc}`);
  }

  async tabs() {
    await this.open(SCREENS[2]);
    await this.page(() => document.querySelector('[role="tab"][aria-selected="true"]')?.focus());
    await this.key(Key.ARROW_RIGHT);
    await sleep(150);
    const moved = await this.page(() => document.activeElement?.getAttribute("aria-selected"));
    if (moved !== "true") fail("tests", "tabs", "ArrowRight moves focus without selecting the tab");
  }
}

function summarise(browser) {
  const lines = [`# Studio in real ${browser}`, ""];
  lines.push(`${failures.length} failures, ${advisories.length} advisories`, "");
  for (const f of failures) lines.push(`- FAIL [${f.state}] ${f.check}: ${f.detail}`);
  for (const a of advisories) lines.push(`- advisory [${a.state}] ${a.check}: ${a.detail}`);
  return `${lines.join("\n")}\n`;
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const studio = await startStudioOnFixture();
  console.log(`Studio on ${studio.origin} for ${studio.fixture}`);
  const builder = new Builder().forBrowser(args.browser);
  if (args.browser === "chrome") {
    // Local development only: headless, and CHROME_BIN for a Chromium that is not on the usual path.
    const options = new chrome.Options().addArguments("--headless=new", "--window-size=1280,900");
    if (process.env.CHROME_BIN) options.setChromeBinaryPath(process.env.CHROME_BIN);
    builder.setChromeOptions(options);
  }
  const driver = await builder.build();
  try {
    const caps = await driver.getCapabilities();
    console.log(`${caps.getBrowserName()} ${caps.getBrowserVersion()} on ${caps.getPlatform()}`);
    await driver.manage().window().setRect({ width: 1280, height: 900, x: 0, y: 0 });
    const themes = args.themes.split(",").map((t) => t.trim());
    for (const theme of themes) {
      const session = new Session(driver, studio, theme);
      for (const screen of SCREENS) {
        await session.open(screen);
        await session.axe(screen.id);
        if (theme === themes[0]) await session.structure(screen.id);
      }
    }
    // Keyboard checks once, in the last theme.
    const session = new Session(driver, studio, themes.at(-1));
    // Same order as ../audit.mjs: the screens are walked with a recorded run in place.
    await session.skipLink();
    await session.liveRun();
    for (const screen of SCREENS) {
      await session.open(screen);
      await session.walk(screen.id);
    }
    await session.dialog();
    await session.tabs();
  } catch (error) {
    fail("check", "crash", error.stack ?? String(error));
  } finally {
    await driver.quit().catch(() => {});
    await studio.close();
  }
  await writeFile(
    join(OUT, "results.json"),
    `${JSON.stringify({ failures, advisories, states }, null, 2)}\n`,
  );
  const summary = summarise(args.browser);
  await writeFile(join(OUT, "summary.md"), summary);
  console.log(`\n${summary}\nReport: ${join(OUT, "summary.md")}`);
  process.exitCode = failures.length ? 1 : 0;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 2;
});
