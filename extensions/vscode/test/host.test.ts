/**
 * Extension-host wiring (state, commands, results view, status bar) against the
 * `vscode` stub and a fake `smarttest` CLI. The fake is a CommonJS entry, which
 * the extension starts through Node on every platform, so this also exercises
 * the Windows launch and process-tree kill paths when run there.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type * as vscode from "vscode";
import { registerCommands } from "../src/commands.js";
import { activate, deactivate } from "../src/extension.js";
import type { SmartTestCodeLensProvider } from "../src/providers/code-lens.js";
import { SmartTestResultsProvider } from "../src/results-view.js";
import { ExtensionState } from "../src/state.js";
import { SmartTestStatusBar } from "../src/status.js";
import { ExtensionMode, type StatusBarItem, stub, Uri } from "./vscode-stub.js";

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

const temporary: string[] = [];

interface FakeCommand {
  /** Printed on stdout. */
  readonly stdout?: string;
  readonly exitCode?: number;
  /** Write the pid to `<dir>/<command>.pid` and wait until killed. */
  readonly hang?: boolean;
}

/** A project folder with an executable `smarttest` that answers per command. */
function project(commands: Readonly<Record<string, FakeCommand>>): string {
  const dir = mkdtempSync(join(tmpdir(), "smarttest-ext-host-"));
  temporary.push(dir);
  writeFileSync(join(dir, "commands.json"), JSON.stringify(commands));
  const script = join(dir, "smarttest.cjs");
  writeFileSync(
    script,
    `const fs = require("node:fs");
const path = require("node:path");
const command = process.argv[2];
fs.appendFileSync(path.join(${JSON.stringify(dir)}, "calls.log"), JSON.stringify(process.argv.slice(2)) + "\\n");
const spec = JSON.parse(fs.readFileSync(path.join(${JSON.stringify(dir)}, "commands.json"), "utf8"))[command] ?? {};
if (spec.hang) {
  fs.writeFileSync(path.join(${JSON.stringify(dir)}, command + ".pid"), String(process.pid));
  setInterval(() => {}, 1000);
} else {
  process.stdout.write(spec.stdout ?? "", () => process.exit(spec.exitCode ?? 0));
}
`,
  );
  return dir;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Every argv the fake CLI received, in order. */
function calls(dir: string): string[][] {
  if (!existsSync(join(dir, "calls.log"))) return [];
  return readFileSync(join(dir, "calls.log"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[]);
}

const LABELER = "src/core/Labeler.ts";

/** `impact --only` output: the fixture with a scope, optionally selecting nothing. */
function scopedImpact(
  scope: { matched: string[]; unchanged: string[]; excluded: string[] },
  selected = true,
): string {
  const envelope = JSON.parse(fixture("impact.json")) as {
    description: string;
    decision: { selectedTests: unknown[] };
  };
  envelope.description += ` · only ${LABELER}`;
  if (!selected) envelope.decision.selectedTests = [];
  return JSON.stringify({ ...envelope, only: { paths: [LABELER], ...scope } });
}

/** `run --only` output: the fixture run with a scope. */
function scopedRun(excluded: string[], stdout = fixture("run.json")): string {
  const envelope = JSON.parse(stdout) as { report: { change: Record<string, unknown> } };
  envelope.report.change.only = { paths: [LABELER], matched: [LABELER], unchanged: [], excluded };
  return JSON.stringify(envelope);
}

function pidOf(dir: string, command: string): number {
  return Number(readFileSync(join(dir, `${command}.pid`), "utf8"));
}

function host(dir: string) {
  const folder = stub.folder(dir);
  stub.settings.executablePath = join(dir, "smarttest.cjs");
  const file = Uri.file(join(dir, "src", "core", "Labeler.ts"));
  stub.activeDocument = { uri: file };
  const state = new ExtensionState({
    appendLine: (line: string) => stub.output.push(line),
    show: () => {},
  } as unknown as vscode.OutputChannel);
  const status = new SmartTestStatusBar(state);
  const item = stub.statusItems.at(-1) as StatusBarItem;
  const results = new SmartTestResultsProvider();
  const context = { subscriptions: [] as { dispose(): void }[] };
  const commands = registerCommands(context as unknown as vscode.ExtensionContext, {
    state,
    status,
    results,
    codeLens: { refresh: () => {} } as unknown as SmartTestCodeLensProvider,
  });
  const run = (id: string, ...args: unknown[]) => {
    const handler = stub.commands.get(id);
    if (!handler) throw new Error(`${id} is not registered`);
    return handler(...args) as Promise<void>;
  };
  return { folder, file, state, status, item, results, commands, run };
}

/** The fixture run, with every file stopped before its runner started (Vitest missing). */
function infrastructureRun(integrityIssues: string[] = []): string {
  const envelope = JSON.parse(fixture("run.json")) as {
    report: {
      executions: { status: string; tests: unknown[]; error?: string }[];
      summary: Record<string, number>;
      warnings: string[];
    };
    integrityIssues: string[];
  };
  for (const file of envelope.report.executions) {
    file.status = "infrastructure-error";
    file.tests = [];
    file.error = "Vitest is not installed";
  }
  Object.assign(envelope.report.summary, { passed: 0, failed: 0, executed: 2, cached: 0 });
  envelope.report.warnings = ["Vitest is not installed"];
  envelope.integrityIssues = integrityIssues;
  return JSON.stringify(envelope);
}

beforeEach(() => stub.reset());
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("extension host", () => {
  it("shows the report of a run that exited 4 and does not call it passed", async () => {
    const dir = project({
      impact: { stdout: scopedImpact({ matched: [LABELER], unchanged: [], excluded: [] }) },
      run: { stdout: scopedRun([], infrastructureRun()), exitCode: 4 },
    });
    const { file, item, results, run } = host(dir);
    await run("smarttest.runAffectedForFile", file);

    const [summary] = results.getChildren();
    expect(summary).toMatchObject({ kind: "summary", verdict: { state: "incomplete" } });
    expect(item.text).toContain("no test result");
    expect(item.text).not.toContain("passed");
    const announced = stub.messages.at(-1);
    expect(announced?.level).toBe("warning");
    expect(announced?.text).toContain(`selected for the changes in ${LABELER}`);
    expect(stub.output.join("\n")).toContain("exited with code 4");
  });

  it("shows integrity issues from a run that exited 70", async () => {
    const dir = project({
      impact: { stdout: fixture("impact.json") },
      run: { stdout: infrastructureRun(["summary does not match executions"]), exitCode: 70 },
    });
    const { results, run } = host(dir);
    await run("smarttest.runAffected");
    expect(results.getChildren()).toContainEqual(
      expect.objectContaining({ kind: "info", label: "Integrity issues" }),
    );
  });

  it("scopes impact and run to the file with --only", async () => {
    const dir = project({
      impact: {
        stdout: scopedImpact({ matched: [LABELER], unchanged: [], excluded: ["src/util/a.ts"] }),
      },
      run: { stdout: scopedRun(["src/util/a.ts"]), exitCode: 0 },
    });
    const { file, run } = host(dir);
    await run("smarttest.runAffectedForFile", file);
    expect(calls(dir).map((argv) => [argv[0], argv.find((a) => a.startsWith("--only"))])).toEqual([
      ["impact", `--only=${LABELER}`],
      ["run", `--only=${LABELER}`],
    ]);
    expect(stub.messages.at(-1)?.text).toContain(
      `2 test(s) selected for the changes in ${LABELER}. 1 other changed file(s) were not considered`,
    );
  });

  it("says the file has no change, runs nothing and offers its protection", async () => {
    const dir = project({
      impact: {
        stdout: scopedImpact({ matched: [], unchanged: [LABELER], excluded: ["src/a.ts"] }, false),
      },
      run: { stdout: fixture("run.json"), exitCode: 0 },
    });
    const { file, item, results, run } = host(dir);
    await run("smarttest.runAffectedForFile", file);
    expect(calls(dir).map((argv) => argv[0])).toEqual(["impact"]);
    const announced = stub.messages.at(-1);
    expect(announced?.text).toBe(
      `SmartTest: ${LABELER} has no change in git · HEAD…working tree, so no test was selected. Nothing was run; this is not a pass.`,
    );
    expect(announced?.items).toEqual(["Show Protection"]);
    expect(results.getChildren()).toEqual([]);
    expect(item.text).not.toContain("passed");
  });

  it("never widens to the whole change set when the CLI has no --only", async () => {
    const dir = project({
      impact: {
        stdout: JSON.stringify({
          schemaVersion: 1,
          error: { code: "ST_USAGE", category: "usage", message: "Unknown option '--only'" },
        }),
        exitCode: 2,
      },
      run: { stdout: fixture("run.json"), exitCode: 0 },
    });
    const { file, run } = host(dir);
    await run("smarttest.runAffectedForFile", file);
    expect(calls(dir).map((argv) => argv[0])).toEqual(["impact"]);
    expect(stub.messages.at(-1)).toMatchObject({
      level: "error",
      text: expect.stringContaining("`--only` needs SmartTest 1.0.0 or later"),
    });
  });

  it("marks the last run out of date when its folder is invalidated", async () => {
    const dir = project({
      impact: { stdout: fixture("impact.json") },
      run: { stdout: fixture("run.json"), exitCode: 0 },
    });
    const { folder, item, status, results, run } = host(dir);
    await run("smarttest.runAffected");
    expect(item.text).toContain("passed");
    // What the save/watcher refresh does for the folder.
    status.invalidateRun(folder.uri.toString());
    results.markStale(folder.uri.fsPath);
    expect(item.text).not.toContain("passed");
    expect(results.getChildren()).toContainEqual(
      expect.objectContaining({ kind: "info", label: "Out of date" }),
    );
  });

  it("kills a run in flight when the commands are disposed", async () => {
    const dir = project({ impact: { stdout: fixture("impact.json") }, run: { hang: true } });
    const { commands, run } = host(dir);
    const running = run("smarttest.runAffected");
    await until(() => existsSync(join(dir, "run.pid")));
    const pid = pidOf(dir, "run");
    commands.dispose();
    await running;
    await until(() => !alive(pid));
  });

  it("kills snapshot loads when the state is disposed", async () => {
    const dir = project({ scan: { hang: true }, graph: { hang: true } });
    const { file, state } = host(dir);
    const analysing = state
      .analyzeDocument(
        { uri: file } as unknown as vscode.TextDocument,
        new AbortController().signal,
      )
      .catch((error: unknown) => error);
    await until(() => existsSync(join(dir, "scan.pid")) && existsSync(join(dir, "graph.pid")));
    const pids = [pidOf(dir, "scan"), pidOf(dir, "graph")];
    state.dispose();
    await until(() => pids.every((pid) => !alive(pid)));
    await analysing;
  });

  it("kills a removed folder's snapshot load", async () => {
    const dir = project({ scan: { hang: true }, graph: { hang: true } });
    const { file, state } = host(dir);
    const analysing = state
      .analyzeDocument(
        { uri: file } as unknown as vscode.TextDocument,
        new AbortController().signal,
      )
      .catch((error: unknown) => error);
    await until(() => existsSync(join(dir, "scan.pid")) && existsSync(join(dir, "graph.pid")));
    const pids = [pidOf(dir, "scan"), pidOf(dir, "graph")];
    stub.setFolders([]);
    await until(() => pids.every((pid) => !alive(pid)));
    await analysing;
    state.dispose();
  });

  it("exposes the inspection API only when VS Code runs extension tests", async () => {
    const dir = project({
      impact: { stdout: fixture("impact.json") },
      run: { stdout: fixture("run.json"), exitCode: 0 },
    });
    stub.folder(dir);
    stub.settings.executablePath = join(dir, "smarttest.cjs");
    stub.activeDocument = { uri: Uri.file(join(dir, "src", "core", "Labeler.ts")) };
    const contextFor = (extensionMode: ExtensionMode) => ({
      subscriptions: [] as { dispose(): void }[],
      extension: { packageJSON: { version: "0.0.0-test" } },
      extensionMode,
    });

    const production = contextFor(ExtensionMode.Production);
    expect(activate(production as unknown as vscode.ExtensionContext)).toBeUndefined();
    deactivate();
    for (const disposable of production.subscriptions) disposable.dispose();

    const testing = contextFor(ExtensionMode.Test);
    const api = activate(testing as unknown as vscode.ExtensionContext);
    expect(api?.trusted).toBe(true);
    expect(api?.results()).toEqual([]);
    await (stub.commands.get("smarttest.runAffected")?.() as Promise<void>);
    expect(api?.status().text).toContain("passed");
    expect(api?.results()[0]?.label).toMatch(/executed test/);
    deactivate();
    for (const disposable of testing.subscriptions) disposable.dispose();
  });

  it("clears the run verdict on save and stops every process on deactivate", async () => {
    const dir = project({
      impact: { stdout: fixture("impact.json") },
      run: { stdout: fixture("run.json"), exitCode: 0 },
      scan: { hang: true },
      graph: { hang: true },
    });
    stub.folder(dir);
    stub.settings.executablePath = join(dir, "smarttest.cjs");
    stub.settings.refreshDelayMs = 0;
    const file = Uri.file(join(dir, "src", "core", "Labeler.ts"));
    stub.activeDocument = { uri: file };
    const context = {
      subscriptions: [] as { dispose(): void }[],
      extension: { packageJSON: { version: "0.0.0-test" } },
    };
    activate(context as unknown as vscode.ExtensionContext);
    const item = stub.statusItems.at(-1) as StatusBarItem;
    const handler = stub.commands.get("smarttest.runAffected");
    await (handler?.() as Promise<void>);
    expect(item.text).toContain("passed");

    stub.save(file);
    await until(() => !item.text.includes("passed"));
    // The refresh after the save is analysing the file; deactivate must stop it.
    await until(() => existsSync(join(dir, "scan.pid")) && existsSync(join(dir, "graph.pid")));
    const pids = [pidOf(dir, "scan"), pidOf(dir, "graph")];
    deactivate();
    await until(() => pids.every((pid) => !alive(pid)));
    for (const disposable of context.subscriptions) disposable.dispose();
  });
});
