import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

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

/**
 * Atomic write: write to a sibling temp file, then rename over the target.
 * Readers never observe a partially written file (spec §30.2).
 */
export async function writeFileAtomic(path: string, data: string | Uint8Array): Promise<void> {
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
    await writeFile(tmp, data);
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

/**
 * Makes an installed `node_modules` directory available at `dest` (another checkout, a temp copy).
 *
 * POSIX: one directory symlink. Windows: pnpm links packages with *relative* symlinks
 * (`..\..\node_modules\.pnpm\...`), and Windows resolves those against the path they were reached
 * through, so behind a single junction from elsewhere every package is missing. There, `dest` is a
 * real directory whose entries (and `@scope` entries) are junctions to their resolved targets.
 */
export async function linkNodeModules(src: string, dest: string): Promise<void> {
  if (process.platform !== "win32") {
    await symlink(src, dest, "dir");
    return;
  }
  await mkdir(dest, { recursive: true });
  for (const e of await readdir(src, { withFileTypes: true })) {
    const from = join(src, e.name);
    const to = join(dest, e.name);
    if (e.name.startsWith("@") && e.isDirectory()) {
      await linkNodeModules(from, to);
      continue;
    }
    const real = await realpath(from).catch(() => undefined);
    if (!real) continue; // a dangling link stays missing, as it is in the source
    if ((await stat(real)).isDirectory()) await symlink(real, to, "junction");
    else await copyFile(real, to);
  }
}

/** Detects the indentation used by a JSON/text document (defaults to two spaces). */
export function detectIndent(text: string): string {
  const match = /^([ \t]+)\S/m.exec(text);
  return match?.[1] ?? "  ";
}
