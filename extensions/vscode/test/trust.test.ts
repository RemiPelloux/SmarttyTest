import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import type * as vscode from "vscode";
import { ExtensionState } from "../src/state.js";
import { stub } from "./vscode-stub.js";

beforeEach(() => stub.reset());

const output = { appendLine: () => {}, show: () => {} } as unknown as vscode.OutputChannel;

describe("Restricted Mode (SR-10)", () => {
  it("refuses to choose an executable for an untrusted workspace, whatever asks", () => {
    stub.trusted = false;
    const folder = stub.folder("/repo") as unknown as vscode.WorkspaceFolder;
    stub.settings = { "smarttest.executablePath": "./evil.sh" };
    const state = new ExtensionState(output);
    expect(() => state.resolveFolder(folder)).toThrow(
      expect.objectContaining({ code: "ST_EXT_UNTRUSTED" }),
    );
    state.dispose();
  });

  it("declares executablePath as a restricted setting", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as {
      capabilities: { untrustedWorkspaces: { restrictedConfigurations?: string[] } };
    };
    expect(manifest.capabilities.untrustedWorkspaces.restrictedConfigurations).toContain(
      "smarttest.executablePath",
    );
  });
});
