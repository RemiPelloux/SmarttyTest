/**
 * Runs inside a real VS Code extension host, started by `scripts/test-host.mjs`
 * (`pnpm --filter smarttest-vscode test:host`). Not a Vitest file: VS Code loads
 * the bundled `run()` through `--extensionTestsPath` and exits with its result.
 *
 * The workspace is a temporary git copy of `fixtures/projects/node-test-esm`
 * with an uncommitted change to `src/money.js#round`, and
 * `smarttest.executablePath` pointing at this repository's built CLI.
 * `SMARTTEST_HOST_SUITE` picks the trusted or the Restricted Mode suite.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import type { SmartTestTestApi } from "../../src/extension.js";

const EXTENSION_ID = "smarttest.smarttest-vscode";
const WAIT_MS = 90_000;

type Test = readonly [name: string, body: () => Promise<void>];

function log(line: string): void {
  console.log(`[host] ${line}`);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls until `probe` returns a value; the last observation is in the error. */
async function until<T>(
  what: string,
  probe: () => Promise<T | undefined> | T | undefined,
  timeoutMs = WAIT_MS,
): Promise<T> {
  const started = Date.now();
  let last: unknown;
  for (;;) {
    try {
      const value = await probe();
      if (value !== undefined) return value;
    } catch (error) {
      last = error;
    }
    if (Date.now() - started > timeoutMs)
      throw new Error(
        `Timed out after ${timeoutMs} ms waiting for ${what}${
          last === undefined ? "" : `: ${last instanceof Error ? last.message : String(last)}`
        }`,
      );
    await sleep(250);
  }
}

function folder(): vscode.WorkspaceFolder {
  const first = vscode.workspace.workspaceFolders?.[0];
  assert.ok(first, "VS Code opened no workspace folder");
  return first;
}

function fileUri(...parts: string[]): vscode.Uri {
  return vscode.Uri.joinPath(folder().uri, ...parts);
}

async function activateExtension(): Promise<{
  readonly extension: vscode.Extension<SmartTestTestApi | undefined>;
  readonly api: SmartTestTestApi;
}> {
  const extension = vscode.extensions.getExtension<SmartTestTestApi | undefined>(EXTENSION_ID);
  assert.ok(extension, `${EXTENSION_ID} is not installed in the extension host`);
  // `onStartupFinished` may already have activated it; activate() then returns the same exports.
  const api = await extension.activate();
  assert.equal(extension.isActive, true, "the extension did not activate");
  assert.ok(api, "activate() returned no Test-mode API (extensionMode is not Test?)");
  return { extension, api };
}

async function assertCommandsRegistered(
  extension: vscode.Extension<SmartTestTestApi | undefined>,
): Promise<void> {
  const contributed = (
    extension.packageJSON as { contributes: { commands: { command: string }[] } }
  ).contributes.commands.map((entry) => entry.command);
  assert.ok(contributed.length >= 7, `only ${contributed.length} contributed commands`);
  const registered = new Set(await vscode.commands.getCommands(true));
  const missing = contributed.filter((command) => !registered.has(command));
  assert.deepEqual(missing, [], `contributed but not registered: ${missing.join(", ")}`);
}

async function smartTestLenses(uri: vscode.Uri): Promise<vscode.CodeLens[]> {
  const lenses =
    (await vscode.commands.executeCommand<vscode.CodeLens[]>(
      "vscode.executeCodeLensProvider",
      uri,
      100,
    )) ?? [];
  return lenses.filter((lens) => lens.command?.command.startsWith("smarttest.") ?? false);
}

async function openMoney(): Promise<vscode.TextEditor> {
  const document = await vscode.workspace.openTextDocument(fileUri("src", "money.js"));
  return await vscode.window.showTextDocument(document);
}

const trusted = (): Test[] => {
  let api: SmartTestTestApi;
  return [
    [
      "activates without errors and returns the Test-mode API",
      async () => {
        const activated = await activateExtension();
        api = activated.api;
        assert.equal(vscode.workspace.isTrusted, true);
        assert.equal(api.trusted, true);
      },
    ],
    [
      "registers every contributed command",
      async () => {
        const { extension } = await activateExtension();
        await assertCommandsRegistered(extension);
      },
    ],
    [
      "status bar shows the protection of the changed file",
      async () => {
        await openMoney();
        const status = await until("the status bar to show an analysis", () => {
          const current = api.status();
          if (current.text.includes("analysis failed"))
            throw new Error(`${current.text}: ${current.tooltip}`);
          return current.text.includes("protected") ? current : undefined;
        });
        assert.equal(status.text, "$(shield) SmartTest: 1 protected");
        assert.match(status.tooltip, /1 distinct test file\(s\) reach this file/);
        assert.equal(status.command, "smarttest.showImpact");
      },
    ],
    [
      "CodeLens says which tests protect round()",
      async () => {
        // The TypeScript server supplies the symbol ranges; it may still be starting.
        const lenses = await until("a SmartTest CodeLens on src/money.js", async () => {
          const found = await smartTestLenses(fileUri("src", "money.js"));
          return found.length > 0 ? found : undefined;
        });
        assert.equal(lenses.length, 1);
        const [lens] = lenses;
        assert.equal(lens?.command?.title, "Protected by 1 test");
        assert.equal(lens?.command?.command, "smarttest.showImpact");
        assert.equal(lens?.range.start.line, 0, "the lens is not on round()'s line");
      },
    ],
    [
      "hover names the test file that reaches round()",
      async () => {
        const hovers = await until("a SmartTest hover on round()", async () => {
          const found =
            (await vscode.commands.executeCommand<vscode.Hover[]>(
              "vscode.executeHoverProvider",
              fileUri("src", "money.js"),
              new vscode.Position(0, 17),
            )) ?? [];
          const text = found
            .flatMap((hover) => hover.contents)
            .map((content) => (typeof content === "string" ? content : content.value))
            .join("\n");
          return text.includes("test/cart.test.js") ? text : undefined;
        });
        assert.match(hovers, /Protected by 1 test/);
      },
    ],
    [
      "Show Impact opens a file summary",
      async () => {
        await vscode.commands.executeCommand("smarttest.showImpact", fileUri("src", "money.js"));
        const summary = await until("the impact summary document", () =>
          vscode.workspace.textDocuments.find(
            (document) =>
              document.languageId === "markdown" && document.getText().startsWith("# SmartTest"),
          ),
        );
        assert.match(summary.getText(), /1 protected unit\(s\)/);
        assert.match(summary.getText(), /## round — Protected by 1 test/);
        await openMoney();
      },
    ],
    [
      "Run Affected Tests runs only the affected test and reports a pass",
      async () => {
        assert.deepEqual(api.results(), [], "the results view is not empty before a run");
        await vscode.commands.executeCommand("smarttest.runAffected");
        const results = api.results();
        assert.equal(results[0]?.label, "1 test(s) passed", JSON.stringify(results));
        const files = results.filter((node) => node.label.endsWith(".test.js"));
        assert.deepEqual(
          files.map((node) => node.label),
          ["test/cart.test.js"],
        );
        assert.match(files[0]?.description ?? "", /^passed/);
        assert.equal(api.status().text, "$(shield) $(pass) 1 passed");
      },
    ],
    [
      "a breaking edit marks the results out of date and the next run fails",
      async () => {
        const editor = await openMoney();
        const document = editor.document;
        const text = document.getText();
        const from = text.indexOf("/ (10 * 10)");
        assert.ok(from >= 0, `unexpected src/money.js:\n${text}`);
        const edit = new vscode.WorkspaceEdit();
        edit.replace(
          document.uri,
          new vscode.Range(document.positionAt(from), document.positionAt(from + 11)),
          "/ 10",
        );
        assert.equal(await vscode.workspace.applyEdit(edit), true);
        assert.equal(await document.save(), true);
        await until("the results view to mark the run out of date", () =>
          api.results().some((node) => node.label === "Out of date") ? true : undefined,
        );
        assert.doesNotMatch(api.status().text, /passed/, "the old verdict survived the save");
        // Let the save's debounced refresh settle so it cannot clear the next verdict.
        await until("the refresh after the save", () =>
          api.status().text.includes("protected") ? true : undefined,
        );

        await vscode.commands.executeCommand("smarttest.runAffected");
        const results = api.results();
        assert.equal(results[0]?.label, "1 of 1 executed test(s) failed", JSON.stringify(results));
        assert.equal(api.status().text, "$(shield) $(error) 1 failed");
        const cart = results.find((node) => node.label === "test/cart.test.js");
        assert.match(cart?.description ?? "", /^failed/);
        assert.ok(
          cart?.children?.some((test) => /failed/.test(test.description)),
          `no failed test under test/cart.test.js: ${JSON.stringify(cart)}`,
        );
      },
    ],
  ];
};

const restricted = (): Test[] => {
  let api: SmartTestTestApi;
  return [
    [
      "activates in Restricted Mode and registers every command",
      async () => {
        assert.equal(
          vscode.workspace.isTrusted,
          false,
          "the workspace is trusted; Restricted Mode cannot be tested",
        );
        const activated = await activateExtension();
        api = activated.api;
        assert.equal(api.trusted, false);
        await assertCommandsRegistered(activated.extension);
      },
    ],
    [
      "shows the Restricted Mode status and no CodeLens",
      async () => {
        await openMoney();
        await sleep(2_000);
        const status = api.status();
        assert.equal(status.text, "$(lock) SmartTest: Restricted Mode");
        assert.equal(status.command, "smarttest.showRestrictedMode");
        assert.deepEqual(await smartTestLenses(fileUri("src", "money.js")), []);
      },
    ],
    [
      "commands start no smarttest process",
      async () => {
        // Each command answers with the Restricted Mode notification, which waits for a
        // click; the promises are left pending on purpose.
        for (const command of [
          "smarttest.runAffected",
          "smarttest.showImpact",
          "smarttest.refresh",
        ])
          void vscode.commands.executeCommand(command);
        await sleep(3_000);
        assert.deepEqual(api.results(), []);
        assert.equal(api.status().text, "$(lock) SmartTest: Restricted Mode");
        assert.equal(
          existsSync(join(folder().uri.fsPath, ".smarttest")),
          false,
          "smarttest ran in an untrusted workspace (.smarttest/ was created)",
        );
      },
    ],
  ];
};

export async function run(): Promise<void> {
  const suite = process.env.SMARTTEST_HOST_SUITE ?? "trusted";
  const tests = suite === "restricted" ? restricted() : trusted();
  log(`VS Code ${vscode.version}, suite "${suite}", workspace ${folder().uri.fsPath}`);
  const failures: string[] = [];
  for (const [name, body] of tests) {
    const started = Date.now();
    try {
      await body();
      log(`ok   ${name} (${Date.now() - started} ms)`);
    } catch (error) {
      const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
      log(`FAIL ${name} (${Date.now() - started} ms)\n${detail}`);
      failures.push(name);
      // Later steps build on earlier ones; stop at the first failure.
      break;
    }
  }
  if (failures.length > 0) throw new Error(`${failures.length} host test(s) failed`);
  log(`${tests.length} host test(s) passed`);
}
