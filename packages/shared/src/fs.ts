import { randomBytes } from "node:crypto";
import { constants, lstatSync } from "node:fs";
import { access, chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { SmartTestError } from "./errors.js";

export async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

export async function readJson<T = unknown>(path: string): Promise<T | undefined> {
  const text = await readText(path);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

/**
 * Windows refuses to replace a file while another process has it open (EPERM, EACCES, EBUSY);
 * the lock is brief, so the rename is retried for up to about two seconds.
 */
async function renameReplacing(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await rename(from, to);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 12 || !(code === "EPERM" || code === "EACCES" || code === "EBUSY"))
        throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(20 * 2 ** attempt, 250)));
    }
  }
}

// ── Write confinement ───────────────────────────────────────────────────────────────────────

/** Directories SmartTest owns (its store, its report directory), mapped to their project root. */
const confined = new Map<string, string>();

const unsafePath = (path: string, why: string) =>
  new SmartTestError(`Refusing to write ${path}: ${why}`, {
    code: "ST_UNSAFE_PATH",
    category: "configuration",
    hint: "SmartTest writes its state and reports only through real directories inside the project. Remove the symbolic link (it may come from the repository content), or point storeDir/reports.outputDir at a directory inside the project.",
  });

/**
 * Throws unless `target` is inside `root` and no existing component below `root` (including
 * `target` itself) is a symbolic link or junction. Components that do not exist yet are fine:
 * they are created as real directories. `root` itself may be a link (`/home` → `/var/home`).
 *
 * This stops repository content from redirecting SmartTest's writes with a committed link such
 * as `.smarttest/state -> ~/.ssh` (spec §30.2). It does not defend against a local process that
 * swaps directories while SmartTest writes.
 */
export function assertNoSymlinkBelow(root: string, target: string): void {
  const base = resolve(root);
  const rel = relative(base, resolve(target));
  if (rel.startsWith("..") || isAbsolute(rel)) throw unsafePath(target, `it is outside ${root}`);
  let current = base;
  for (const part of rel.split(sep).filter(Boolean)) {
    current = join(current, part);
    let link: boolean;
    try {
      link = lstatSync(current).isSymbolicLink();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (link) throw unsafePath(target, `${current} is a symbolic link`);
  }
}

/**
 * Marks `dir` as SmartTest-owned: every later write under it (through `writeFileAtomic`,
 * `writeJson` or `assertConfinedWrite`) is refused when a link below `root` would redirect it.
 * A directory outside `root` (an explicit command-line path) is not registered.
 */
export function confineWrites(root: string, dir: string): void {
  const r = resolve(root);
  const d = resolve(dir);
  const rel = relative(r, d);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return;
  confined.set(d, r);
}

/** Throws when `path` is under a confined directory and a link would redirect the write. */
export function assertConfinedWrite(path: string): void {
  const abs = resolve(path);
  for (const [dir, root] of confined)
    if (abs === dir || abs.startsWith(`${dir}${sep}`)) assertNoSymlinkBelow(root, abs);
}

/**
 * Atomic write: write to a sibling temp file, then rename over the target.
 * Readers never observe a partially written file (spec §30.2).
 */
export async function writeFileAtomic(path: string, data: string | Uint8Array): Promise<void> {
  assertConfinedWrite(path);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    const mode = await stat(path).then(
      (info) => info.mode & 0o777,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      },
    );
    // "wx": never follow a link planted at the temporary name.
    await writeFile(tmp, data, { flag: "wx" });
    // A rename replaces the inode: retain executable and private-file permissions.
    if (mode !== undefined) await chmod(tmp, mode);
    await renameReplacing(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Detects the indentation used by a JSON/text document (defaults to two spaces). */
export function detectIndent(text: string): string {
  const match = /^([ \t]+)\S/m.exec(text);
  return match?.[1] ?? "  ";
}
