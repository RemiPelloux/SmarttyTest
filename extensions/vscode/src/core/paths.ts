import { isAbsolute, relative, sep } from "node:path";

/** SmartTest's JSON contracts use project-relative POSIX paths. */
export function toPosix(path: string): string {
  return path.replace(/\\/g, "/");
}

export function stripLeadingDotSlash(path: string): string {
  return path.replace(/^\.\//, "");
}

/**
 * Converts an absolute file path to the project-relative POSIX path used by
 * `smarttest --json`. Returns undefined when the file is outside the project:
 * the extension then does not claim anything about it.
 */
export function toProjectPath(projectDir: string, filePath: string): string | undefined {
  const rel = relative(projectDir, filePath);
  if (!rel) return ".";
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) return undefined;
  const normal = toPosix(rel);
  return normal.replace(/^\.\//, "");
}

export function isInside(projectDir: string, filePath: string): boolean {
  return toProjectPath(projectDir, filePath) !== undefined;
}

/** Resolves a project-relative POSIX path to an absolute path without normalising `..` away silently. */
export function fromProjectPath(projectDir: string, projectPath: string): string | undefined {
  const candidate = toPosix(projectPath)
    .split("/")
    .filter((part) => part.length > 0);
  if (candidate.includes("..")) return undefined;
  return `${projectDir.replace(/[\\/]+$/, "")}/${candidate.join("/")}`;
}

/**
 * Paths on Windows are case-insensitive. Project paths in JSON are still
 * compared case-insensitively there so a document is not silently ignored.
 */
export function sameProjectPath(
  a: string,
  b: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const left = stripLeadingDotSlash(toPosix(a));
  const right = stripLeadingDotSlash(toPosix(b));
  return platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/** The folder key is stable for the lifetime of a workspace folder. */
export function folderKey(fsPath: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? fsPath.toLowerCase() : fsPath;
}

export function displayPath(projectDir: string, absolutePath: string): string {
  return toProjectPath(projectDir, absolutePath) ?? absolutePath;
}
