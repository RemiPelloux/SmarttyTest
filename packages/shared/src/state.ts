/**
 * Authenticated local state. Caches that decide what runs (the symbol index and its delta, the
 * persisted graph, test discovery, cached passes, traces) are trusted only when this machine (or a
 * CI job holding the same secret) wrote them: each file has a sibling `<file>.mac` holding an
 * HMAC-SHA256 of its exact bytes under a key that repository content cannot read.
 *
 * A file whose MAC is missing or wrong is treated as absent, so it is rebuilt: a state file
 * planted by a pull request or restored from an untrusted CI cache can never reduce the selection.
 *
 * Key: `SMARTTEST_STATE_KEY` when set (at least 32 characters, e.g. a CI secret shared by the jobs
 * that save and restore the cache; forks do not receive it), otherwise a random 32-byte key kept
 * per user outside every project (`<user cache dir>/smarttest/state.key`, mode 0600).
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { writeFileAtomic } from "./fs.js";

/** Where the per-user key lives: the platform's user cache directory, never a project. */
export function stateKeyFile(env: NodeJS.ProcessEnv = process.env): string {
  const base =
    process.platform === "win32"
      ? (env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"))
      : process.platform === "darwin"
        ? join(homedir(), "Library", "Caches")
        : (env.XDG_CACHE_HOME ?? join(homedir(), ".cache"));
  return join(base, "smarttest", "state.key");
}

let userKey: Buffer | undefined;

function readKey(file: string): Buffer | undefined {
  try {
    const k = readFileSync(file);
    return k.length >= 32 ? k : undefined;
  } catch {
    return undefined;
  }
}

/** Minimum length of `SMARTTEST_STATE_KEY`; a shorter value is ignored (with a warning). */
export const MIN_STATE_KEY_LENGTH = 32;
let shortKeyWarned = false;

/** The key state files are authenticated with. */
export function stateKey(): Buffer {
  const fromEnv = process.env.SMARTTEST_STATE_KEY;
  if (fromEnv && fromEnv.length >= MIN_STATE_KEY_LENGTH) return Buffer.from(fromEnv, "utf8");
  if (fromEnv && !shortKeyWarned) {
    shortKeyWarned = true;
    process.stderr.write(
      `▲ SMARTTEST_STATE_KEY is ignored: it has ${fromEnv.length} characters, at least ${MIN_STATE_KEY_LENGTH} are required. State is authenticated with the per-user key instead, so jobs sharing a cache rebuild it.\n`,
    );
  }
  if (userKey) return userKey;
  const file = stateKeyFile();
  userKey = readKey(file);
  if (userKey) return userKey;
  const fresh = randomBytes(32);
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, fresh, { flag: "wx", mode: 0o600 });
    userKey = fresh;
  } catch {
    // Another process created it first, or the directory is read-only. Without a stored key,
    // state written now is trusted by this process only (later runs rebuild it: always safe).
    userKey = readKey(file) ?? fresh;
  }
  return userKey;
}

const macOf = (path: string, data: string | Uint8Array): Buffer =>
  createHmac("sha256", stateKey())
    .update(`smarttest-state-v1\u0000${basename(path)}\u0000`)
    .update(data)
    .digest();

const macPath = (path: string) => `${path}.mac`;

function verified(path: string, data: Buffer, mac: string | undefined): string | undefined {
  if (!mac) return undefined;
  const expected = macOf(path, data);
  const given = Buffer.from(mac.trim(), "hex");
  return given.length === expected.length && timingSafeEqual(given, expected)
    ? data.toString("utf8")
    : undefined;
}

/** Writes a state file and its MAC (atomically each; a torn pair reads as absent). */
export async function writeStateFile(path: string, data: string): Promise<void> {
  await writeFileAtomic(path, data);
  await writeFileAtomic(
    macPath(path),
    `${macOf(path, Buffer.from(data, "utf8")).toString("hex")}\n`,
  );
}

/** The content of a state file this key wrote, or undefined (missing, damaged or forged). */
export async function readStateFile(path: string): Promise<string | undefined> {
  const [data, mac] = await Promise.all([
    readFile(path).catch(() => undefined),
    readFile(macPath(path), "utf8").catch(() => undefined),
  ]);
  return data ? verified(path, data, mac) : undefined;
}

export function readStateFileSync(path: string): string | undefined {
  let data: Buffer;
  let mac: string;
  try {
    data = readFileSync(path);
    mac = readFileSync(macPath(path), "utf8");
  } catch {
    return undefined;
  }
  return verified(path, data, mac);
}

export async function readStateJson<T = unknown>(path: string): Promise<T | undefined> {
  const text = await readStateFile(path);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

/** Pretty JSON, like `writeJson`, with a MAC. */
export async function writeStateJson(path: string, value: unknown): Promise<void> {
  await writeStateFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function removeStateFile(path: string): Promise<void> {
  await rm(path, { force: true });
  await rm(macPath(path), { force: true });
}
