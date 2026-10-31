import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { launchOptions, resolveExecutable } from "../src/cli/executable.js";

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

  // A JS entry has no executable bit after a plain build (packages/cli/dist/bin.js),
  // so it is started through Node instead of being executed directly.
  describe.skipIf(process.platform === "win32")("a JavaScript entry on POSIX", () => {
    function entry(root: string): string {
      const path = join(root, "tools", "bin.js");
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, "console.log('smarttest')\n");
      chmodSync(path, 0o644);
      return path;
    }

    it("runs a configured, non-executable bin.js with node from PATH", () => {
      const root = temp();
      const bin = entry(root);
      fakeBinary(join(root, "nodejs", "node"));
      expect(
        resolveExecutable({
          configuredPath: "tools/bin.js",
          workspaceDir: root,
          pathEnv: join(root, "nodejs"),
          platform: "linux",
        }),
      ).toEqual({
        executable: join(root, "nodejs", "node"),
        source: "setting",
        leadingArgs: [bin],
      });
    });

    it("falls back to the editor's runtime as Node when node is not on PATH", () => {
      const root = temp();
      const bin = entry(root);
      expect(
        resolveExecutable({
          configuredPath: bin,
          workspaceDir: root,
          pathEnv: "",
          platform: "darwin",
          execPath: "/editor/Electron",
        }),
      ).toEqual({
        executable: "/editor/Electron",
        source: "setting",
        leadingArgs: [bin],
        env: { ELECTRON_RUN_AS_NODE: "1" },
      });
    });
  });

  // Windows lookups run on any OS: the platform is a parameter and only `.cmd`
  // names and package manifests are read.
  describe("on Windows", () => {
    function shimWithPackage(root: string, bin: unknown = { smarttest: "dist/bin.js" }): string {
      fakeBinary(join(root, "node_modules", ".bin", "smarttest.cmd"));
      fakeBinary(join(root, "node_modules", "smarttest", "dist", "bin.js"));
      writeFileSync(
        join(root, "node_modules", "smarttest", "package.json"),
        JSON.stringify({ name: "smarttest", bin }),
      );
      return join(root, "node_modules", "smarttest", "dist", "bin.js");
    }

    it("runs the package's JS entry through node instead of the .cmd shim", () => {
      const root = temp();
      const entry = shimWithPackage(root);
      fakeBinary(join(root, "nodejs", "node.exe"));
      const found = resolveExecutable({
        configuredPath: "",
        workspaceDir: root,
        pathEnv: join(root, "nodejs"),
        platform: "win32",
      });
      expect(found).toEqual({
        executable: join(root, "nodejs", "node.exe"),
        source: "workspace",
        leadingArgs: [entry],
      });
      expect(
        launchOptions(found ?? { executable: "", source: "path" }, ["scan", "--json"]),
      ).toEqual({
        executable: join(root, "nodejs", "node.exe"),
        leadingArgs: [entry],
        args: ["scan", "--json"],
      });
    });

    it("falls back to the editor's runtime as Node when no node.exe is found", () => {
      const root = temp();
      const entry = shimWithPackage(root, "dist/bin.js");
      const found = resolveExecutable({
        configuredPath: "",
        workspaceDir: root,
        pathEnv: "",
        platform: "win32",
        execPath: "/editor/Code.exe",
      });
      expect(found).toEqual({
        executable: "/editor/Code.exe",
        source: "workspace",
        leadingArgs: [entry],
        env: { ELECTRON_RUN_AS_NODE: "1" },
      });
      expect(
        launchOptions(found ?? { executable: "", source: "path" }, []).env?.ELECTRON_RUN_AS_NODE,
      ).toBe("1");
    });

    it("starts a shim without a readable package through cmd.exe", () => {
      const root = temp();
      fakeBinary(join(root, "node_modules", ".bin", "smarttest.cmd"));
      const found = resolveExecutable({
        configuredPath: "",
        workspaceDir: root,
        pathEnv: "",
        platform: "win32",
      });
      expect(found).toEqual({
        executable: join(root, "node_modules", ".bin", "smarttest.cmd"),
        source: "workspace",
        shell: true,
      });
    });

    it("runs a configured JS entry through node", () => {
      const root = temp();
      fakeBinary(join(root, "tools", "bin.js"));
      expect(
        resolveExecutable({
          configuredPath: "tools/bin.js",
          workspaceDir: root,
          pathEnv: "",
          platform: "win32",
          execPath: "/editor/Code.exe",
        }),
      ).toMatchObject({
        executable: "/editor/Code.exe",
        leadingArgs: [join(root, "tools", "bin.js")],
      });
    });
  });
});
