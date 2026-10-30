/**
 * Finds the local `smarttest` executable. No download, no `npx`, no network:
 * a configured path, then `<folder>/node_modules/.bin` and its ancestors, then
 * PATH. The extension never installs anything on the user's behalf.
 */
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";

export interface ExecutableLookup {
  readonly configuredPath: string;
  readonly workspaceDir: string;
  readonly pathEnv?: string | undefined;
  readonly platform?: NodeJS.Platform;
  readonly homeDir?: string;
}

export interface ExecutableResolution {
  readonly executable: string;
  readonly source: "setting" | "workspace" | "path";
}

function expandHome(value: string, homeDir: string): string {
  if (value === "~") return homeDir;
  if (value.startsWith("~/") || value.startsWith("~\\")) return join(homeDir, value.slice(2));
  return value;
}

function isExecutableFile(path: string, platform: NodeJS.Platform): boolean {
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return false;
    if (platform === "win32") return true;
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

function pathCandidates(pathEnv: string, platform: NodeJS.Platform): string[] {
  const separators = platform === "win32" ? [";"] : [":"];
  const parts = pathEnv.split(separators[0] ?? delimiter).filter(Boolean);
  const names = binaryNames(platform);
  return parts.flatMap((part) => names.map((name) => join(part, name)));
}

/**
 * Returns undefined when nothing usable is found; the caller turns that into a
 * configuration error that names the setting.
 */
export function resolveExecutable(lookup: ExecutableLookup): ExecutableResolution | undefined {
  const platform = lookup.platform ?? process.platform;
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
