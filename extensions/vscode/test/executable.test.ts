import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveExecutable } from "../src/cli/executable.js";

const temporary: string[] = [];

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "smarttest-ext-exec-"));
  temporary.push(dir);
  return dir;
}

function fakeBinary(path: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "#!/bin/sh\nexit 0\n");
  if (process.platform !== "win32") chmodSync(path, 0o755);
}

afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("executable discovery", () => {
  it("prefers a configured path relative to the workspace", () => {
    const root = temp();
    fakeBinary(join(root, "tools", "smarttest"));
    const found = resolveExecutable({
      configuredPath: "tools/smarttest",
      workspaceDir: root,
      pathEnv: "",
      platform: process.platform,
    });
    expect(found).toEqual({ executable: join(root, "tools", "smarttest"), source: "setting" });
  });

  it("walks up from the workspace folder to node_modules/.bin", () => {
    const root = temp();
    const workspace = join(root, "packages", "app");
    mkdirSync(workspace, { recursive: true });
    fakeBinary(join(root, "node_modules", ".bin", "smarttest"));
    expect(
      resolveExecutable({
        configuredPath: "",
        workspaceDir: workspace,
        pathEnv: "",
        platform: process.platform,
      }),
    ).toEqual({ executable: join(root, "node_modules", ".bin", "smarttest"), source: "workspace" });
  });

  it("falls back to PATH and reports the source", () => {
    const root = temp();
    fakeBinary(join(root, "bin", "smarttest"));
    expect(
      resolveExecutable({
        configuredPath: "",
        workspaceDir: join(root, "empty"),
        pathEnv: join(root, "bin"),
        platform: process.platform,
      }),
    ).toEqual({ executable: join(root, "bin", "smarttest"), source: "path" });
  });

  it("returns undefined for a missing configured path instead of silently using PATH", () => {
    const root = temp();
    fakeBinary(join(root, "bin", "smarttest"));
    expect(
      resolveExecutable({
        configuredPath: "missing/smarttest",
        workspaceDir: root,
        pathEnv: join(root, "bin"),
        platform: process.platform,
      }),
    ).toBeUndefined();
  });

  it("ignores non-executable files on Unix", () => {
    const root = temp();
    const binary = join(root, "node_modules", ".bin", "smarttest");
    mkdirSync(join(binary, ".."), { recursive: true });
    writeFileSync(binary, "not executable");
    if (process.platform === "win32") return;
    chmodSync(binary, 0o644);
    expect(
      resolveExecutable({
        configuredPath: "",
        workspaceDir: root,
        pathEnv: "",
        platform: process.platform,
      }),
    ).toBeUndefined();
  });
});
