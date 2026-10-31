/**
 * Finds the local `smarttest` executable. No download, no `npx`, no network:
 * a configured path, then `<folder>/node_modules/.bin` and its ancestors, then
 * PATH. The extension never installs anything on the user's behalf.
 *
 * On Windows the `.bin` entry is a `smarttest.cmd` batch shim, which `spawn`
 * refuses without a shell. The shim's package entry is run through Node
 * instead, the way the shim itself would; only when that entry cannot be found
 * is the shim started through cmd.exe.
 *
 * A JavaScript entry (`.js`, `.mjs`, `.cjs`), configured or found, is started
 * through Node on every platform: its executable bit and shebang are not needed,
 * so `smarttest.executablePath` can point at `node_modules/smarttest/dist/bin.js`.
 */
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";

export interface ExecutableLookup {
  readonly configuredPath: string;
  readonly workspaceDir: string;
  readonly pathEnv?: string | undefined;
  readonly platform?: NodeJS.Platform;
  readonly homeDir?: string;
  /** The extension host's runtime, the last resort for running a JS entry. */
  readonly execPath?: string;
}

export interface ExecutableResolution {
  readonly executable: string;
  readonly source: "setting" | "workspace" | "path";
  /** Arguments before the CLI's own: the JS entry when the CLI is started through Node. */
  readonly leadingArgs?: readonly string[];
  /** Extra environment, set when the editor's own runtime runs the JS entry. */
  readonly env?: Readonly<Record<string, string>>;
  /** A Windows batch shim whose JS entry was not found: started through cmd.exe. */
  readonly shell?: boolean;
}

/** The `runCli` fields for one call with `args`. */
export function launchOptions(
  resolution: ExecutableResolution,
  args: readonly string[],
): {
  readonly executable: string;
  readonly leadingArgs?: readonly string[];
  readonly args: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly shell?: boolean;
} {
  return {
    executable: resolution.executable,
    ...(resolution.leadingArgs ? { leadingArgs: resolution.leadingArgs } : {}),
    args,
    ...(resolution.env ? { env: { ...process.env, ...resolution.env } } : {}),
    ...(resolution.shell ? { shell: true } : {}),
  };
}

function expandHome(value: string, homeDir: string): string {
  if (value === "~") return homeDir;
  if (value.startsWith("~/") || value.startsWith("~\\")) return join(homeDir, value.slice(2));
  return value;
}

const JS_ENTRY = /\.[cm]?js$/i;

function isExecutableFile(path: string, platform: NodeJS.Platform): boolean {
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return false;
    // Node runs a JS entry, so it needs no executable bit.
    if (platform === "win32" || JS_ENTRY.test(path)) return true;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function binaryNames(platform: NodeJS.Platform): string[] {
  return platform === "win32" ? ["smarttest.cmd", "smarttest.exe", "smarttest"] : ["smarttest"];
}

function workspaceCandidates(workspaceDir: string, platform: NodeJS.Platform): string[] {
  const candidates: string[] = [];
  let dir = resolve(workspaceDir);
  for (;;) {
    for (const name of binaryNames(platform))
      candidates.push(join(dir, "node_modules", ".bin", name));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return candidates;
}

function pathCandidatesFor(
  pathEnv: string,
  platform: NodeJS.Platform,
  names: readonly string[],
): string[] {
  const separators = platform === "win32" ? [";"] : [":"];
  const parts = pathEnv.split(separators[0] ?? delimiter).filter(Boolean);
  return parts.flatMap((part) => names.map((name) => join(part, name)));
}

function pathCandidates(pathEnv: string, platform: NodeJS.Platform): string[] {
  return pathCandidatesFor(pathEnv, platform, binaryNames(platform));
}

/** The `smarttest` bin entry of the package next to a batch shim, if it exists. */
function packageEntry(shim: string): string | undefined {
  const dir = dirname(shim);
  const packageDir =
    basename(dir) === ".bin"
      ? join(dir, "..", "smarttest")
      : join(dir, "node_modules", "smarttest");
  try {
    const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as {
      bin?: unknown;
    };
    const bin =
      typeof manifest.bin === "string"
        ? manifest.bin
        : typeof manifest.bin === "object" && manifest.bin !== null
          ? (manifest.bin as Record<string, unknown>).smarttest
          : undefined;
    if (typeof bin !== "string") return undefined;
    const entry = resolve(packageDir, bin);
    return statSync(entry).isFile() ? entry : undefined;
  } catch {
    return undefined;
  }
}

/** Runs a JS entry with Node next to it, then on PATH, then the host runtime. */
function nodeLaunch(
  entry: string,
  near: string,
  source: ExecutableResolution["source"],
  lookup: ExecutableLookup,
  platform: NodeJS.Platform = "win32",
): ExecutableResolution {
  const name = platform === "win32" ? "node.exe" : "node";
  // A Windows install may ship node.exe next to the shim; on POSIX only PATH counts.
  const node = [
    ...(platform === "win32" ? [join(near, name)] : []),
    ...pathCandidatesFor(lookup.pathEnv ?? process.env.PATH ?? "", platform, [name]),
  ].find((candidate) => isExecutableFile(candidate, platform));
  if (node) return { executable: node, source, leadingArgs: [entry] };
  return {
    executable: lookup.execPath ?? process.execPath,
    source,
    leadingArgs: [entry],
    env: { ELECTRON_RUN_AS_NODE: "1" },
  };
}

function windowsLaunch(
  found: string,
  source: ExecutableResolution["source"],
  lookup: ExecutableLookup,
): ExecutableResolution {
  if (JS_ENTRY.test(found)) return nodeLaunch(found, dirname(found), source, lookup);
  if (!/\.(cmd|bat)$/i.test(found)) return { executable: found, source };
  const entry = packageEntry(found);
  if (entry) return nodeLaunch(entry, dirname(found), source, lookup);
  return { executable: found, source, shell: true };
}

/**
 * Returns undefined when nothing usable is found; the caller turns that into a
 * configuration error that names the setting.
 */
export function resolveExecutable(lookup: ExecutableLookup): ExecutableResolution | undefined {
  const platform = lookup.platform ?? process.platform;
  const found = findExecutable(lookup, platform);
  if (!found) return found;
  if (platform === "win32") return windowsLaunch(found.executable, found.source, lookup);
  if (JS_ENTRY.test(found.executable))
    return nodeLaunch(found.executable, dirname(found.executable), found.source, lookup, platform);
  return found;
}

function findExecutable(
  lookup: ExecutableLookup,
  platform: NodeJS.Platform,
): ExecutableResolution | undefined {
  const configured = lookup.configuredPath.trim();
  if (configured) {
    const home = lookup.homeDir ?? homedir();
    const expanded = expandHome(configured, home);
    if (isAbsolute(expanded) || expanded.includes("/") || expanded.includes("\\")) {
      const absolute = isAbsolute(expanded) ? expanded : join(lookup.workspaceDir, expanded);
      if (isExecutableFile(absolute, platform)) return { executable: absolute, source: "setting" };
      return undefined;
    }
    const onPath = pathCandidates(lookup.pathEnv ?? process.env.PATH ?? "", platform).find(
      (candidate) => isExecutableFile(candidate, platform),
    );
    if (onPath) return { executable: onPath, source: "setting" };
    return undefined;
  }
  const workspace = workspaceCandidates(lookup.workspaceDir, platform).find((candidate) =>
    isExecutableFile(candidate, platform),
  );
  if (workspace) return { executable: workspace, source: "workspace" };
  const onPath = pathCandidates(lookup.pathEnv ?? process.env.PATH ?? "", platform).find(
    (candidate) => isExecutableFile(candidate, platform),
  );
  if (onPath) return { executable: onPath, source: "path" };
  return undefined;
}
