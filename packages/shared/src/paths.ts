import { isAbsolute, relative, resolve, sep } from "node:path";

export function toPosix(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}

/** Project-relative POSIX path. Returns undefined when the path escapes the root. */
export function relPosix(root: string, absolute: string): string | undefined {
  const rel = relative(root, absolute);
  if (rel === "") return "";
  if (rel.startsWith("..") || isAbsolute(rel)) return undefined;
  return toPosix(rel);
}

/** Resolve a project-relative POSIX path, rejecting traversal outside the root (spec §30.2). */
export function safeResolve(root: string, relativePath: string): string {
  const abs = resolve(root, relativePath);
  if (relPosix(root, abs) === undefined) {
    throw new Error(`Path escapes project root: ${relativePath}`);
  }
  return abs;
}
