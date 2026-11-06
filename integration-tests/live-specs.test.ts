/**
 * Live specs (S34): a Playwright spec whose projects only target a deployed environment (an
 * https:// baseURL that is not local) is never run by `run`, a hook or `validate-selection`
 * unless `--live` is given; it is reported as live, not run, never as passed. Setup projects run
 * once per run. Fixture: playwright-live (a local project with a setup project and a webServer, a
 * live project with its own setup project; no browser needed).
 */
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SmartTest } from "@smarttest/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { edit, git, materialize } from "./helpers.js";

const LIVE_SPEC = "e2e/live/greeting.live.spec.js";
const LOCAL_GREETING = "e2e/local/greeting.spec.js";
const LOCAL_STATUS = "e2e/local/status.spec.js";
// The live project's setup file: selected (its page visits cannot be mapped), and live too.
const LIVE_SETUP = "e2e/setup/live.setup.js";

let log: string;
const setupRuns = async () =>
  (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean).sort();

beforeEach(async () => {
  log = join(await mkdtemp(join(tmpdir(), "st-setup-log-")), "setup.log");
  process.env.SETUP_LOG = log;
});
afterEach(() => {
  delete process.env.SETUP_LOG;
});

describe("live Playwright specs", () => {
  it("run: selected, reported as live and not run; the local specs run, setup once", async () => {
    const dir = await materialize("playwright-live", { git: true });
    // Both local specs and the live spec are affected; one change each.
    await edit(
      dir,
      "lib/greeting.js",
      "export function greeting",
      "// edited\nexport function greeting",
    );
    await edit(dir, "lib/status.js", "export function status", "// edited\nexport function status");
    const st = await SmartTest.open({ root: dir });
    const { report, exitCode, integrityIssues } = await st.run({ cache: false, formats: [] });
    const selected = report.decision.selectedTests.map((t) => t.filePath);
    expect(selected).toEqual(expect.arrayContaining([LIVE_SPEC, LOCAL_GREETING, LOCAL_STATUS]));
    expect(report.live?.map((l) => l.file)).toEqual([LIVE_SPEC, LIVE_SETUP]);
    expect(report.live?.[0]).toMatchObject({
      projects: ["live"],
      baseURL: "https://staging.example.invalid",
    });
    expect(report.summary.live).toBe(2);
    const executed = report.executions.map((e) => e.file);
    expect(executed).not.toContain(LIVE_SPEC);
    expect(executed).toEqual(expect.arrayContaining([LOCAL_GREETING, LOCAL_STATUS]));
    expect(report.executions.every((e) => e.status === "passed")).toBe(true);
    expect(report.warnings.join("\n")).toContain("were not run (live)");
    expect(integrityIssues).toEqual([]);
    expect(exitCode).toBe(0);
    // Two selected local specs, one run: the setup project they depend on ran once; the live
    // setup project never ran.
    expect(await setupRuns()).toEqual(["local-setup"]);
  }, 180_000);

  it("run --live: the live spec runs (and fails here: the deployed environment does not exist)", async () => {
    const dir = await materialize("playwright-live", { git: true });
    await edit(
      dir,
      "lib/greeting.js",
      "export function greeting",
      "// edited\nexport function greeting",
    );
    const st = await SmartTest.open({ root: dir });
    const { report, exitCode } = await st.run({ cache: false, formats: [], live: true });
    expect(report.live ?? []).toEqual([]);
    const liveRun = report.executions.find((e) => e.file === LIVE_SPEC);
    expect(liveRun, "the live spec has an execution record").toBeDefined();
    expect(liveRun?.status).not.toBe("passed");
    expect(exitCode).not.toBe(0);
    expect(await setupRuns()).toEqual(["live-setup", "local-setup"]);
  }, 180_000);

  it("a hook reports the live spec as not run and records it", async () => {
    const dir = await materialize("playwright-live", { git: true });
    await edit(
      dir,
      "lib/greeting.js",
      "export function greeting",
      "// staged\nexport function greeting",
    );
    git(dir, "add", "lib/greeting.js");
    const st = await SmartTest.open({ root: dir });
    const result = await st.runHook("pre-commit", { cache: false });
    expect(result.outcome?.exitCode).toBe(0);
    expect(result.outcome?.report.live?.map((l) => l.file)).toEqual([LIVE_SPEC, LIVE_SETUP]);
    const records = JSON.parse(await readFile(join(dir, ".smarttest/state/hooks.json"), "utf8"));
    expect(records.runs.at(-1)).toMatchObject({ passed: true, live: 2 });
    expect(await setupRuns()).toEqual(["local-setup"]);
  }, 180_000);

  it("validate-selection leaves live specs out of the reference run", async () => {
    const dir = await materialize("playwright-live", { git: true });
    await edit(dir, "lib/greeting.js", "`Hello, ", "`Hi, ");
    const st = await SmartTest.open({ root: dir });
    const v = await st.validateSelection();
    expect(v.failuresFound).toEqual([LOCAL_GREETING]);
    expect(v.failuresMissed).toEqual([]);
    expect(v.live?.map((l) => l.file).sort()).toEqual([LIVE_SPEC, LIVE_SETUP]);
  }, 180_000);
});
