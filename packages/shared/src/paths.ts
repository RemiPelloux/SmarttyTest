import { realpathSync } from "node:fs";
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

const canonicalCache = new Map<string, string>();
/** `path` with symlinks and Windows 8.3 short names resolved (cached; `path` itself if missing). */
export function canonicalPath(path: string): string {
  let real = canonicalCache.get(path);
  if (real === undefined) {
    try {
      real = realpathSync.native(path);
    } catch {
      real = path;
    }
    canonicalCache.set(path, real);
  }
  return real;
}

/**
 * Project-relative POSIX path of a path a test runner or coverage tool reported. Runners report
 * canonical paths (macOS: /private/var/..., Windows: no 8.3 short names such as RUNNER~1), which
 * do not relate lexically to a root spelled through a symlink or a short name; the canonical
 * root is tried next. For reporting only: path confinement checks stay lexical (`safeResolve`).
 */
export function relPosixReported(root: string, absolute: string): string | undefined {
  const rel = relPosix(root, absolute);
  if (rel !== undefined) return rel;
  const real = canonicalPath(root);
  return real === root ? undefined : relPosix(real, absolute);
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
