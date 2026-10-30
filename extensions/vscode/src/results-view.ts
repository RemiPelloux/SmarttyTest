import { join } from "node:path";
import * as vscode from "vscode";
import type { FileExecution, RunReport, RunResult, TestExecution } from "./core/contracts.js";
import {
  type FileResultGroup,
  groupFiles,
  groupHasFailure,
  type ResultState,
  type RunVerdict,
  statusIcon,
  statusLabel,
  verdict,
} from "./core/results.js";

type Node = SummaryNode | FileNode | TestNode | InfoNode;

interface SummaryNode {
  readonly kind: "summary";
  readonly verdict: RunVerdict;
  readonly report: RunReport;
}

interface FileNode {
  readonly kind: "file";
  readonly file: FileExecution;
  readonly state: ResultState;
  readonly group: FileResultGroup;
}

interface TestNode {
  readonly kind: "test";
  readonly test: TestExecution;
  readonly file: string;
}

interface InfoNode {
  readonly kind: "info";
  readonly label: string;
  readonly description?: string;
}

function iconFor(state: ResultState): vscode.ThemeIcon {
  const id = statusIcon(
    // statusIcon accepts TestStatus; the two unions share the interesting members.
    state as Parameters<typeof statusIcon>[0],
  );
  if (state === "failed" || state === "cached-failure")
    return new vscode.ThemeIcon(id, new vscode.ThemeColor("testing.iconFailed"));
  if (state === "passed")
    return new vscode.ThemeIcon(id, new vscode.ThemeColor("testing.iconPassed"));
  if (state === "cached-pass")
    return new vscode.ThemeIcon(id, new vscode.ThemeColor("charts.blue"));
  if (state === "skipped" || state === "pending")
    return new vscode.ThemeIcon(id, new vscode.ThemeColor("testing.iconSkipped"));
  if (state === "flaky" || state === "timed-out" || state === "infrastructure-error")
    return new vscode.ThemeIcon(id, new vscode.ThemeColor("testing.iconErrored"));
  return new vscode.ThemeIcon(id);
}

export class SmartTestResultsProvider implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  readonly #onDidChangeTreeData = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.#onDidChangeTreeData.event;
  #report: RunReport | undefined;
  #groups: readonly FileResultGroup[] = [];
  #integrityIssues: readonly string[] = [];
  #projectDir: string | undefined;

  setReport(result: RunResult, projectDir: string): void {
    this.#report = result.report;
    this.#groups = groupFiles(result.report);
    this.#integrityIssues = result.integrityIssues;
    this.#projectDir = projectDir;
    this.#onDidChangeTreeData.fire(undefined);
  }

  clear(): void {
    this.#report = undefined;
    this.#groups = [];
    this.#projectDir = undefined;
    this.#integrityIssues = [];
    this.#onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: Node): vscode.TreeItem {
    switch (element.kind) {
      case "summary": {
        const item = new vscode.TreeItem(
          element.verdict.headline,
          vscode.TreeItemCollapsibleState.None,
        );
        item.description = `analysis ${element.report.decision.analysisStatus} · mode ${element.report.mode}`;
        item.tooltip = element.verdict.details.join("\n") || element.verdict.headline;
        item.iconPath =
          element.verdict.state === "passed"
            ? new vscode.ThemeIcon("pass", new vscode.ThemeColor("testing.iconPassed"))
            : element.verdict.state === "failed"
              ? new vscode.ThemeIcon("error", new vscode.ThemeColor("testing.iconFailed"))
              : new vscode.ThemeIcon("warning", new vscode.ThemeColor("testing.iconErrored"));
        return item;
      }
      case "file": {
        // Large runs have thousands of tests; only files with a failure open.
        const item = new vscode.TreeItem(
          element.file.file,
          element.group.tests.length === 0
            ? vscode.TreeItemCollapsibleState.None
            : groupHasFailure(element.group)
              ? vscode.TreeItemCollapsibleState.Expanded
              : vscode.TreeItemCollapsibleState.Collapsed,
        );
        item.description = `${statusLabel(element.file.status)} · ${element.file.tests.length} test(s)`;
        item.tooltip = element.file.error
          ? `${element.file.file}\n${element.file.error}`
          : element.file.file;
        item.iconPath = iconFor(element.state);
        item.resourceUri = this.#uri(element.file.file);
        item.contextValue = "smarttest.testFile";
        return item;
      }
      case "test": {
        const item = new vscode.TreeItem(element.test.testId, vscode.TreeItemCollapsibleState.None);
        item.description = `${statusLabel(element.test.status)} · ${Math.round(
          element.test.durationMs,
        )} ms`;
        if (element.test.error) {
          item.tooltip = new vscode.MarkdownString(
            `**${statusLabel(element.test.status)}**\n\n\`\`\`\n${element.test.error.message}\n\`\`\``,
          );
        } else {
          item.tooltip = `${statusLabel(element.test.status)} (${element.test.testId})`;
        }
        item.iconPath = iconFor(element.test.status);
        item.resourceUri = this.#uri(element.file);
        item.command = {
          command: "vscode.open",
          title: "Open test file",
          arguments: [this.#uri(element.file)],
        };
        item.contextValue = "smarttest.test";
        return item;
      }
      case "info": {
        const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
        if (element.description !== undefined) item.description = element.description;
        item.iconPath = new vscode.ThemeIcon("info");
        return item;
      }
    }
  }

  getChildren(element?: Node): Node[] {
    if (!this.#report) return [];
    if (!element) {
      const nodes: Node[] = [
        { kind: "summary", verdict: verdict(this.#report), report: this.#report },
      ];
      if (this.#integrityIssues.length > 0)
        nodes.push({
          kind: "info",
          label: "Integrity issues",
          description: this.#integrityIssues.join("; "),
        });
      if (this.#report.warnings.length > 0)
        nodes.push({
          kind: "info",
          label: "Warnings",
          description: this.#report.warnings.join("; "),
        });
      for (const group of this.#groups)
        nodes.push({ kind: "file", file: group.file, state: group.state, group });
      return nodes;
    }
    if (element.kind === "file")
      return element.group.tests.map((test) => ({
        kind: "test",
        test,
        file: element.file.file,
      }));
    return [];
  }

  #uri(projectPath: string): vscode.Uri {
    if (!this.#projectDir) return vscode.Uri.file(projectPath);
    return vscode.Uri.file(join(this.#projectDir, projectPath));
  }

  dispose(): void {
    this.#onDidChangeTreeData.dispose();
  }
}
