import { isAbsolute, relative, resolve, sep } from "node:path";
import { SmartTestError } from "./errors.js";

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

/**
 * Refuses a revision or branch name that a VCS command would read as an option (`--output=…`,
 * `--config=…`) or that carries control characters. Revisions come from the configuration
 * (`vcs.base`), flags, CI variables and Studio requests (spec §30.2).
 */
export function assertSafeRevision(ref: string, what = "Revision"): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
  if (!ref || ref.startsWith("-") || /[\u0000-\u001f\u007f]/.test(ref) || ref.length > 256) {
    throw new SmartTestError(`${what} "${ref.slice(0, 80)}" is not a valid revision name`, {
      code: "ST_UNSAFE_REVISION",
      category: "usage",
      hint: "Use a branch, tag or commit name. A name cannot start with '-' or contain control characters.",
    });
  }
  return ref;
}
