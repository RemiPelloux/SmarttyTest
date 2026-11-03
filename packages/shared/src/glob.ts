import { type Dirent, existsSync, readdirSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { runProcess } from "./proc.js";

const cache = new Map<string, RegExp>();

/**
 * Converts a glob to a RegExp. Supports `**`, `*`, `?`, `{a,b}` and `[abc]`.
 * Patterns are matched against POSIX, project-relative paths.
 */
export function globToRegExp(pattern: string): RegExp {
  const cached = cache.get(pattern);
  if (cached) return cached;
  let re = "";
  let i = 0;
  let inGroup = 0;
  while (i < pattern.length) {
    const c = pattern[i] as string;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        const prevSlash = i === 0 || pattern[i - 1] === "/";
        const nextSlash = pattern[i + 2] === "/";
        if (prevSlash && nextSlash) {
          re += "(?:.*/)?";
          i += 3;
          continue;
        }
        re += ".*";
        i += 2;
        continue;
      }
      re += "[^/]*";
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === "{") {
      inGroup++;
      re += "(?:";
    } else if (c === "}" && inGroup > 0) {
      inGroup--;
      re += ")";
    } else if (c === "," && inGroup > 0) {
      re += "|";
    } else if (c === "[") {
      const end = pattern.indexOf("]", i);
      if (end === -1) re += "\\[";
      else {
        re += `[${pattern.slice(i + 1, end).replace(/^!/, "^")}]`;
        i = end;
      }
    } else if ("\\^$.|+()".includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
    i++;
  }
  const regex = new RegExp(`^${re}$`);
  cache.set(pattern, regex);
  return regex;
}

export function matchGlob(path: string, patterns: string | readonly string[]): boolean {
  const list = typeof patterns === "string" ? [patterns] : patterns;
  return list.some(
    (p) => globToRegExp(p).test(path) || (p.endsWith("/**") && path === p.slice(0, -3)),
  );
}

/** Directories that are never walked: dependencies, VCS metadata, SmartTest state, build output. */
export const DEFAULT_IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  ".smarttest",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  ".vite",
  ".output",
  ".yarn",
]);

/**
 * Build-output folder names that are also ordinary folder names (`src/tests/build/`): they are
 * build output only at a package root, next to a `package.json`.
 */
export const PACKAGE_OUTPUT_DIRS = new Set(["dist", "build", "out", "coverage"]);

/**
 * Whether a file is under an ignored folder. With the default folders, `dist`, `build`, `out`
 * and `coverage` count only at a package root (`hasManifest(dir)`), so a test kept in
 * `src/tests/build/` is still analysed (OpenPro). A custom set applies everywhere.
 */
function underIgnored(
  file: string,
  ignored: ReadonlySet<string>,
  hasManifest: (dir: string) => boolean,
): boolean {
  const segs = file.split("/").slice(0, -1);
  return segs.some((seg, i) => {
    if (!ignored.has(seg)) return false;
    if (ignored !== DEFAULT_IGNORED_DIRS || !PACKAGE_OUTPUT_DIRS.has(seg)) return true;
    return hasManifest(segs.slice(0, i).join("/"));
  });
}

export interface WalkOptions {
  include?: readonly string[];
  exclude?: readonly string[];
  ignoredDirs?: ReadonlySet<string>;
}

/**
 * The paths that are regular files (or links to one). One directory listing per directory instead
 * of one stat per file; a path the listing does not show as a plain file or a directory (links,
 * another case on case-insensitive disks, deleted files) is decided by `stat`, as before.
 */
function existingFiles(root: string, paths: readonly string[]): string[] {
  const listings = new Map<string, Map<string, Dirent> | undefined>();
  const listing = (dir: string) => {
    if (!listings.has(dir)) {
      let entries: Map<string, Dirent> | undefined;
      try {
        entries = new Map(
          readdirSync(join(root, dir), { withFileTypes: true }).map((e) => [e.name, e]),
        );
      } catch {
        entries = undefined;
      }
      listings.set(dir, entries);
    }
    return listings.get(dir);
  };
  return paths.filter((f) => {
    if (!f) return false;
    const slash = f.lastIndexOf("/");
    const entry = listing(slash < 0 ? "" : f.slice(0, slash))?.get(f.slice(slash + 1));
    if (entry?.isFile()) return true;
    if (entry?.isDirectory()) return false;
    try {
      return statSync(join(root, f)).isFile();
    } catch {
      return false;
    }
  });
}

/**
 * Files Git considers part of the project: tracked + untracked, minus everything ignored by any
 * .gitignore. Submodules (gitlinks) and deleted files are dropped. Undefined outside a Git repo.
 * Not cached: files are created and deleted between calls (generate, deletes), and listing is fast.
 */
export async function gitProjectFiles(root: string): Promise<string[] | undefined> {
  let files: string[] | undefined;
  try {
    const res = await runProcess(
      "git",
      [
        "-c",
        "core.quotePath=false",
        "ls-files",
        "-z",
        "--cached",
        "--others",
        "--exclude-standard",
      ],
      { cwd: root },
    );
    if (res.code === 0) files = existingFiles(root, [...new Set(res.stdout.split("\0"))]);
  } catch {
    files = undefined;
  }
  return files;
}

/**
 * Lists project files as POSIX project-relative paths, sorted. In a Git repository this respects
 * every .gitignore (and skips submodules); elsewhere it walks the directory tree.
 */
export async function walkFiles(
  root: string,
  options: WalkOptions & {
    useGit?: boolean;
    /** A `gitProjectFiles(root)` result to use instead of listing again (one listing per run). */
    gitFiles?: readonly string[];
  } = {},
): Promise<string[]> {
  const ignored = options.ignoredDirs ?? DEFAULT_IGNORED_DIRS;
  if (options.useGit !== false) {
    const fromGit = options.gitFiles ?? (await gitProjectFiles(root));
    if (fromGit) {
      const manifests = new Set(
        fromGit
          .filter((f) => f === "package.json" || f.endsWith("/package.json"))
          .map((f) => f.slice(0, -"package.json".length).replace(/\/$/, "")),
      );
      // The project root is a package root even when its manifest is ignored or missing.
      const hasManifest = (dir: string) => dir === "" || manifests.has(dir);
      return fromGit
        .filter((f) => !underIgnored(f, ignored, hasManifest))
        .filter((f) => !options.include || matchGlob(f, options.include))
        .filter((f) => !options.exclude || !matchGlob(f, options.exclude))
        .sort();
    }
  }
  const out: string[] = [];
  async function visit(dir: string, rel: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (
          ignored.has(entry.name) &&
          (ignored !== DEFAULT_IGNORED_DIRS ||
            !PACKAGE_OUTPUT_DIRS.has(entry.name) ||
            rel === "" ||
            existsSync(join(dir, "package.json")))
        )
          continue;
        if (options.exclude && matchGlob(childRel, options.exclude)) continue;
        await visit(join(dir, entry.name), childRel);
      } else if (entry.isFile()) {
        if (options.include && !matchGlob(childRel, options.include)) continue;
        if (options.exclude && matchGlob(childRel, options.exclude)) continue;
        out.push(childRel);
      }
    }
  }
  await visit(root, "");
  return out.sort();
}
