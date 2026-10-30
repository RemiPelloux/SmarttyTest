import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import type * as vscode from "vscode";
import type { FileAnalysis } from "../src/core/analysis.js";
import { parseRunJson } from "../src/core/contracts.js";
import { ExtensionState } from "../src/state.js";
import { SmartTestStatusBar } from "../src/status.js";
import { type StatusBarItem, stub, Uri } from "./vscode-stub.js";

function report() {
  const value = parseRunJson(
    readFileSync(new URL("./fixtures/run.json", import.meta.url), "utf8"),
  ).report;
  Object.assign(value.decision, { analysisStatus: "complete" });
  return value;
}

function setup() {
  const folder = stub.folder("/repo");
  const file = Uri.file("/repo/src/a.ts");
  stub.activeDocument = { uri: file };
  const state = new ExtensionState({
    appendLine: () => {},
    show: () => {},
  } as unknown as vscode.OutputChannel);
  const status = new SmartTestStatusBar(state);
  const item = stub.statusItems.at(-1) as StatusBarItem;
  return { folder, file: file as unknown as vscode.Uri, state, status, item };
}

const analysis = (overrides: Partial<FileAnalysis> = {}): FileAnalysis => ({
  file: "src/a.ts",
  units: [],
  protections: [],
  warnings: [],
  explainFailures: 0,
  truncated: false,
  ...overrides,
});

beforeEach(() => stub.reset());

describe("status bar", () => {
  it("drops the last run's verdict when its folder changes", () => {
    const { folder, status, item } = setup();
    const key = folder.uri.toString();
    status.setRun(report(), key);
    expect(item.text).toContain("3 passed");
    status.invalidateRun("file:///elsewhere");
    expect(item.text).toContain("3 passed");
    status.invalidateRun(key);
    expect(item.text).not.toContain("passed");
  });

  it("shows a run whose runner never started as having no result", () => {
    const { folder, status, item } = setup();
    const value = report();
    const broken = {
      ...value,
      executions: value.executions.map((file) => ({
        ...file,
        status: "infrastructure-error" as const,
        tests: [],
      })),
      summary: { ...value.summary, passed: 0, executed: 2 },
    };
    status.setRun(broken, folder.uri.toString());
    expect(item.text).toContain("no test result");
    expect(item.text).not.toContain("passed");
  });

  it("says a file above maxUnitsPerFile is too large instead of 'no symbols'", () => {
    const { file, status, item } = setup();
    status.setAnalysis(
      file,
      analysis({
        truncated: true,
        units: Array.from({ length: 151 }, (_, index) => ({
          id: `src/a.ts#f${index}`,
          qualifiedName: `f${index}`,
          kind: "function" as const,
        })),
      }),
    );
    expect(item.text).toBe("$(shield) SmartTest: file too large to analyse");
    expect(String(item.tooltip)).toContain("smarttest.maxUnitsPerFile (150)");
  });

  it("keeps a newer analysis's spinner when a superseded one settles", () => {
    const { file, status, item } = setup();
    const first = status.beginAnalysing(file);
    const second = status.beginAnalysing(file);
    status.endAnalysing(first);
    expect(item.text).toContain("analysing this file");
    status.endAnalysing(second);
    expect(item.text).not.toContain("analysing");
  });
});
