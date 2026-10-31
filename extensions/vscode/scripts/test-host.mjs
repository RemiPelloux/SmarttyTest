#!/usr/bin/env node
// Real-host test: downloads a pinned VS Code, starts it with the built extension
// against a temporary git copy of fixtures/projects/node-test-esm, and runs
// test/host/suite.ts inside the extension host. Two launches: a trusted
// workspace, then the same workspace in Restricted Mode.
//
//   pnpm build                                   # the CLI under test
//   pnpm --filter smarttest-vscode test:host     # Linux CI: under xvfb-run -a
//
// Environment:
//   SMARTTEST_VSCODE_VERSION  VS Code to download (default below; "stable" for the latest)
//   SMARTTEST_CLI             CLI entry (default: packages/cli/dist/bin.js)
//   SMARTTEST_HOST_KEEP=1     keep the temporary workspace and profile for debugging
//
// Profiles, extensions and workspaces live in one temporary directory that is
// removed afterwards; the user's VS Code profile is never used. Downloads are
// cached in extensions/vscode/.vscode-test (git-ignored).
import { execFileSync, spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

// The newest stable at the time of pinning; it satisfies engines.vscode (^1.85.0).
const DEFAULT_VSCODE_VERSION = "1.143.1";
const LAUNCH_TIMEOUT_MS = 10 * 60_000;

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(packageRoot, "..", "..");
const require = createRequire(join(packageRoot, "package.json"));
const { downloadAndUnzipVSCode } = require("@vscode/test-electron");
const esbuild = require("esbuild");

const version = process.env.SMARTTEST_VSCODE_VERSION || DEFAULT_VSCODE_VERSION;
const cli = process.env.SMARTTEST_CLI || join(repoRoot, "packages", "cli", "dist", "bin.js");
const keep = process.env.SMARTTEST_HOST_KEEP === "1";
const fixture = join(repoRoot, "fixtures", "projects", "node-test-esm");

function fail(message) {
  console.error(`test:host: ${message}`);
  process.exit(1);
}

if (!existsSync(cli))
  fail(`the CLI is not built (${cli}). Run \`pnpm build\` at the repository root.`);

// 1. The extension and the in-host suite.
execFileSync(process.execPath, [join(packageRoot, "scripts", "build.mjs")], { stdio: "inherit" });
const suite = join(packageRoot, ".vscode-test", "suite", "index.cjs");
await esbuild.build({
  entryPoints: [join(packageRoot, "test", "host", "suite.ts")],
  outfile: suite,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["vscode"],
  sourcemap: "inline",
  logLevel: "warning",
  absWorkingDir: packageRoot,
});

// 2. A short temporary root: macOS limits the IPC socket path VS Code creates in the profile.
// The real path: no 8.3 short names on Windows, no /var -> /private/var on macOS.
const root = realpathSync.native(mkdtempSync(join(tmpdir(), "stvh-")));

function git(cwd, ...args) {
  execFileSync(
    "git",
    [
      "-c",
      "user.email=host-test@example.invalid",
      "-c",
      "user.name=SmartTest host test",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.autocrlf=false",
      ...args,
    ],
    { cwd, stdio: "ignore" },
  );
}

/** A git copy of the fixture with an uncommitted, behaviour-preserving change to round(). */
function workspace(name) {
  const dir = join(root, name);
  cpSync(fixture, dir, {
    recursive: true,
    filter: (source) => {
      const top = relative(fixture, source).split(sep)[0];
      return top !== "node_modules" && top !== ".smarttest";
    },
  });
  mkdirSync(join(dir, ".vscode"));
  writeFileSync(
    join(dir, ".vscode", "settings.json"),
    `${JSON.stringify({ "smarttest.executablePath": cli }, null, 2)}\n`,
  );
  git(dir, "init", "-q");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "--no-verify", "-m", "fixture");
  const money = join(dir, "src", "money.js");
  writeFileSync(
    money,
    "export function round(n) {\n  return Math.round(n * 100) / (10 * 10);\n}\n",
  );
  return dir;
}

function profile(name) {
  const userData = join(root, name === "trusted" ? "ut" : "ur");
  mkdirSync(join(userData, "User"), { recursive: true });
  writeFileSync(
    join(userData, "User", "settings.json"),
    `${JSON.stringify(
      {
        "security.workspace.trust.enabled": true,
        "security.workspace.trust.startupPrompt": "never",
        "security.workspace.trust.banner": "never",
        "workbench.startupEditor": "none",
        "workbench.enableExperiments": false,
        "telemetry.telemetryLevel": "off",
        "update.mode": "none",
        "extensions.autoCheckUpdates": false,
        "extensions.autoUpdate": false,
        "git.enabled": false,
        "npm.autoDetect": "off",
        "typescript.disableAutomaticTypeAcquisition": true,
      },
      null,
      2,
    )}\n`,
  );
  return userData;
}

/**
 * Ends VS Code and every helper it started. On POSIX VS Code leads its own process
 * group, which outlives the main process if a helper is left behind.
 */
function killTree(child) {
  if (child.pid === undefined) return;
  try {
    if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
    else if (child.exitCode === null && child.signalCode === null)
      execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } catch {
    // Already gone.
  }
}

let current;
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    if (current) killTree(current);
    if (!keep) rmSync(root, { recursive: true, force: true, maxRetries: 5 });
    process.exit(130);
  });

async function launch(executable, name, trusted) {
  const dir = workspace(name);
  const args = [
    dir,
    "--no-sandbox",
    "--disable-gpu-sandbox",
    "--disable-updates",
    "--skip-welcome",
    "--skip-release-notes",
    "--no-cached-data",
    "--new-window",
    `--user-data-dir=${profile(name)}`,
    `--extensions-dir=${join(root, "extensions")}`,
    `--extensionDevelopmentPath=${packageRoot}`,
    `--extensionTestsPath=${suite}`,
    ...(trusted ? ["--disable-workspace-trust"] : []),
  ];
  const env = { ...process.env, SMARTTEST_HOST_SUITE: name };
  // Started from a VS Code terminal, these would attach the child to that VS Code.
  for (const key of Object.keys(env))
    if (key.startsWith("VSCODE_") || key.startsWith("ELECTRON_")) delete env[key];

  console.log(`test:host: VS Code ${version}, ${name} workspace`);
  return await new Promise((resolve) => {
    const child = spawn(executable, args, {
      env,
      stdio: ["ignore", "inherit", "inherit"],
      detached: process.platform !== "win32",
    });
    current = child;
    const timer = setTimeout(() => {
      console.error(`test:host: ${name} did not finish within ${LAUNCH_TIMEOUT_MS} ms`);
      killTree(child);
    }, LAUNCH_TIMEOUT_MS);
    child.on("error", (error) => {
      clearTimeout(timer);
      console.error(`test:host: could not start VS Code: ${error.message}`);
      resolve(1);
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      // Helpers (GPU, utility, extension host) must not outlive the run.
      killTree(child);
      current = undefined;
      resolve(code ?? (signal ? 1 : 0));
    });
  });
}

let exitCode = 1;
try {
  const executable = await downloadAndUnzipVSCode({
    version,
    cachePath: join(packageRoot, ".vscode-test"),
  });
  const trusted = await launch(executable, "trusted", true);
  const restricted = await launch(executable, "restricted", false);
  console.log(`test:host: trusted exit ${trusted}, restricted exit ${restricted}`);
  exitCode = trusted === 0 && restricted === 0 ? 0 : 1;
} catch (error) {
  console.error(`test:host: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  if (keep) console.log(`test:host: kept ${root}`);
  else rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}
process.exit(exitCode);
