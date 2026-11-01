#!/usr/bin/env node
/**
 * Studio with a real screen reader, through Guidepup: VoiceOver with Safari on macOS, NVDA with
 * Chrome (or Edge) on Windows. Only the keyboard is used, as a screen-reader user would:
 *
 *   1. landmarks: the screen reader's next-landmark command reaches the navigation and main;
 *   2. headings: next-heading reaches the screen's level-1 heading;
 *   3. the run: Tab to "Run affected", Enter, and the progress ("Selecting tests…", "Running
 *      tests") and the verdict ("Run finished with failures. N passed, M failed.") are spoken
 *      from the page's live region;
 *   4. the results: reading on in the run drawer speaks the failing test;
 *   5. another screen: Escape, Tab back to the Tests screen in the navigation, Enter, and the
 *      screen change and its heading are spoken.
 *
 * Every spoken phrase is written to <out>/spoken-<reader>.txt (and .json, with the step that
 * produced it), which CI uploads as an artifact. Assertions are on that log.
 *
 * Needs an environment prepared by guidepup/setup-action (see .github/workflows/studio-a11y.yml).
 * Exit code 0 when every check passes, 1 when one fails, 2 when the check itself broke.
 */
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs, promisify } from "node:util";
import { nvda, voiceOver } from "@guidepup/guidepup";
import { startStudioOnFixture } from "../studio-server.mjs";

const { values: args } = parseArgs({
  options: {
    out: { type: "string", default: join(tmpdir(), "smarttest-studio-sr") },
    browser: { type: "string" },
  },
});
const OUT = resolve(args.out);
const MAC = process.platform === "darwin";
const READER = MAC ? "voiceover" : "nvda";
const sr = MAC ? voiceOver : nvda;
const run = promisify(execFile);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// ── Spoken log ──────────────────────────────────────────────────────────────────────────────

const spoken = [];
let step = "start";
const failures = [];
const fail = (check, detail) => {
  failures.push({ check, detail });
  console.log(`FAIL ${check}: ${detail}`);
};
const hear = (phrase, source) => {
  const text = String(phrase ?? "").trim();
  if (!text) return;
  // Pollers see the same last phrase many times: keep a phrase once per step until it changes.
  const last = spoken.at(-1);
  if (source === "poll" && last && last.text === text) return;
  spoken.push({ at: Date.now(), step, source, text });
  console.log(`  [${step}] ${text}`);
};
const heardSince = (index) => spoken.slice(index).map((s) => s.text);
/** True once a second NVDA client streams every phrase: commands then need no own record. */
let streaming = false;

/**
 * Speech that no command asked for (live regions) is only in Guidepup's log while a command
 * captures it. On Windows a second NVDA Remote client joins Guidepup's channel and hears every
 * phrase; on macOS VoiceOver's last phrase is polled while waiting.
 */
async function listen() {
  if (MAC) return { stop() {} };
  const require = createRequire(import.meta.url);
  const { NVDAClient } = require("@guidepup/guidepup/lib/windows/NVDA/NVDAClient.js");
  const client = new NVDAClient();
  try {
    await client.connect({ capture: false });
    client.on("speak", (phrase) => hear(phrase, "nvda-remote"));
    streaming = true;
    console.log("Listening to every NVDA phrase through a second NVDA Remote client");
    return { stop: () => client.disconnect() };
  } catch (error) {
    console.log(`No second NVDA client (${error.message}); polling the last phrase instead`);
    return { stop() {} };
  }
}

async function poll(ms, until) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (MAC) hear(await sr.lastSpokenPhrase().catch(() => ""), "poll");
    if (until?.()) return true;
    await sleep(MAC ? 150 : 250);
  }
  return false;
}

/** Runs a screen-reader command and records what it made the reader say. */
async function command(fn) {
  const before = (await sr.spokenPhraseLog()).length;
  await fn();
  const after = await sr.spokenPhraseLog();
  if (streaming) await sleep(300);
  else for (const phrase of after.slice(before)) hear(phrase, "command");
  if (MAC) hear(await sr.lastSpokenPhrase().catch(() => ""), "poll");
}

// ── Browser ─────────────────────────────────────────────────────────────────────────────────

async function openBrowser(url) {
  if (MAC) {
    await run("open", ["-a", "Safari", url]);
    await sleep(4000);
    await run("osascript", ["-e", 'tell application "Safari" to activate']);
    return { close: () => run("osascript", ["-e", 'tell application "Safari" to quit']) };
  }
  const candidates = [
    args.browser,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ].filter(Boolean);
  const exe = candidates.find((p) => existsSync(p));
  if (!exe) throw new Error(`no Chrome or Edge in ${candidates.join(", ")}`);
  console.log(`Browser: ${exe}`);
  const profile = await mkdtemp(join(tmpdir(), "st-sr-profile-"));
  const child = spawn(
    exe,
    [
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-search-engine-choice-screen",
      "--disable-features=Translate,PrivacySandboxSettings4",
      "--force-renderer-accessibility",
      "--start-maximized",
      "--new-window",
      url,
    ],
    { stdio: "ignore", detached: true },
  );
  child.unref();
  await sleep(6000);
  return { close: async () => child.kill() };
}

// ── Steps ───────────────────────────────────────────────────────────────────────────────────

/** Presses Tab (or Shift+Tab) until the spoken phrase matches `pattern`. */
async function tabTo(pattern, { back = false, max = 40 } = {}) {
  for (let i = 0; i < max; i++) {
    const before = spoken.length;
    await command(() => sr.press(back ? "Shift+Tab" : "Tab"));
    if (heardSince(before).some((t) => pattern.test(t))) return true;
  }
  return false;
}

/** Prints why the screen reader could not start: the error causes and the machine's state. */
async function diagnose(error) {
  console.log("\n── Screen reader start failed: diagnostics ──");
  for (let e = error, depth = 0; e && depth < 6; e = e.cause, depth++)
    console.log(`${"  ".repeat(depth)}${depth ? "caused by: " : ""}${e.stack ?? String(e)}`);
  const probes = MAC
    ? [
        ["sw_vers", []],
        ["uname", ["-a"]],
        ["defaults", ["read", "com.apple.VoiceOver4/default", "SCREnableAppleScript"]],
        ["defaults", ["read", "com.apple.VoiceOverUtility"]],
        ["pgrep", ["-lf", "VoiceOver"]],
        ["ls", ["-la", "/System/Library/CoreServices/VoiceOver.app/Contents/MacOS"]],
        ["csrutil", ["status"]],
      ]
    : [
        ["cmd", ["/c", "ver"]],
        ["reg", ["query", "HKCU\\Software\\Guidepup\\Nvda"]],
        ["tasklist", ["/fi", "imagename eq nvda.exe"]],
      ];
  for (const [cmd, rest] of probes) {
    const out = await run(cmd, rest, { timeout: 15_000 }).then(
      (r) => `${r.stdout}${r.stderr}`,
      (e) => `(${e.code ?? "error"}) ${e.stdout ?? ""}${e.stderr ?? e.message}`,
    );
    console.log(`$ ${cmd} ${rest.join(" ")}\n${out.trim()}`);
  }
  console.log("── end of diagnostics ──\n");
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const studio = await startStudioOnFixture();
  console.log(`Studio on ${studio.origin} for ${studio.fixture}`);
  let browser = null;
  let listener = { stop() {} };
  try {
    step = "start";
    try {
      await sr.start({ capture: "initial" });
    } catch (error) {
      await diagnose(error);
      throw error;
    }
    listener = await listen();
    step = "load";
    browser = await openBrowser(studio.url("/overview", { theme: "dark" }));
    await poll(8000);
    // Put keyboard focus (and with it the reader's cursor) in the page.
    await command(() => sr.press("Tab"));

    step = "landmarks";
    let mark = spoken.length;
    for (let i = 0; i < 8; i++) await command(() => sr.nextLandmark());
    const landmarks = heardSince(mark).join(" | ");
    if (!/navigation/i.test(landmarks)) fail("landmarks", `no navigation landmark: ${landmarks}`);
    if (!/\bmain\b/i.test(landmarks)) fail("landmarks", `no main landmark: ${landmarks}`);

    step = "headings";
    mark = spoken.length;
    for (let i = 0; i < 6; i++) await command(() => sr.nextHeading());
    const headings = heardSince(mark).join(" | ");
    if (!/heading/i.test(headings) || !/Overview/.test(headings))
      fail("headings", `the Overview heading is not spoken: ${headings}`);

    step = "run";
    if (!(await tabTo(/Run affected/i))) {
      fail("run", "Tab never reaches the Run affected button");
    } else {
      mark = spoken.length;
      await command(() => sr.press("Enter"));
      const verdict = /Run (passed|finished|hit)|No test|Nothing to run/;
      await poll(180_000, () => heardSince(mark).some((t) => verdict.test(t)));
      await poll(2000);
      const said = heardSince(mark);
      if (!said.some((t) => /Selecting tests|Running tests/.test(t)))
        fail("run-progress", `run progress is not spoken: ${said.join(" | ")}`);
      if (!said.some((t) => verdict.test(t)))
        fail("run-verdict", `the verdict is not spoken: ${said.join(" | ")}`);
      else if (!said.some((t) => /\d+ passed, \d+ failed/.test(t)))
        fail("run-verdict", "the verdict is spoken without its counts");

      step = "results";
      mark = spoken.length;
      for (let i = 0; i < 30; i++) {
        await command(() => sr.next());
        if (heardSince(mark).some((t) => /capitaliz|strings\.test|labeler/i.test(t))) break;
      }
      const results = heardSince(mark).join(" | ");
      if (!/capitaliz|strings\.test|labeler/i.test(results))
        fail("results", `reading the run drawer never speaks the failing test: ${results}`);

      step = "close-run";
      await command(() => sr.press("Escape"));
      await poll(1500);
    }

    step = "tests-screen";
    if (!(await tabTo(/\bTests\b/, { back: true }))) {
      fail("navigation", "Shift+Tab never reaches the Tests screen button");
    } else {
      mark = spoken.length;
      await command(() => sr.press("Enter"));
      await poll(3000);
      for (let i = 0; i < 4; i++) await command(() => sr.nextHeading());
      const said = heardSince(mark).join(" | ");
      if (!/Tests screen|Tests.*heading|heading.*Tests/i.test(said))
        fail("navigation", `the Tests screen is not spoken: ${said}`);
    }
  } catch (error) {
    fail("check", error.stack ?? String(error));
  } finally {
    step = "end";
    listener.stop();
    await sr.stop().catch(() => {});
    await browser?.close().catch(() => {});
    await studio.close().catch(() => {});
  }
  await writeFile(
    join(OUT, `spoken-${READER}.txt`),
    `${spoken.map((s) => `[${s.step}] ${s.text}`).join("\n")}\n`,
  );
  await writeFile(
    join(OUT, `spoken-${READER}.json`),
    `${JSON.stringify({ reader: READER, failures, spoken }, null, 2)}\n`,
  );
  console.log(
    `\n${READER}: ${failures.length} failures, ${spoken.length} phrases → ${join(OUT, `spoken-${READER}.txt`)}`,
  );
  for (const f of failures) console.log(`- FAIL ${f.check}: ${f.detail}`);
  process.exitCode = failures.length ? 1 : 0;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 2;
});
