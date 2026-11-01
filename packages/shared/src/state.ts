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
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
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

/**
 * What happened to the per-user key in this process, for `doctor`:
 * - `stored`: read from the key file, or created there;
 * - `repaired`: the key file was truncated or damaged; it was replaced (state signed with the
 *   lost key is rebuilt once);
 * - `ephemeral`: no key could be stored (read-only directory, damaged file that cannot be
 *   replaced): signed caches last for this process only, so every run rebuilds them.
 */
export type StateKeySource = "env" | "stored" | "repaired" | "ephemeral";
let keySource: StateKeySource | undefined;

/** A stored key is exactly what `loadStateKey` writes: 32 bytes or more. */
function readKey(file: string): { key?: Buffer; exists: boolean } {
  try {
    const k = readFileSync(file);
    return k.length >= 32 ? { key: k, exists: true } : { exists: true };
  } catch (error) {
    return { exists: (error as NodeJS.ErrnoException).code !== "ENOENT" };
  }
}

const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Reads the key file, or creates or repairs it. Writers take `<file>.lock` (exclusive create) and
 * replace the file atomically (temporary file + rename), so a reader never sees a half-written
 * key and two processes cannot end up with different keys: whoever does not hold the lock waits
 * and reads the key the holder wrote. A lock left by a crashed process is broken after 10 s.
 */
export function loadStateKey(file: string): { key: Buffer; source: StateKeySource } {
  const first = readKey(file);
  if (first.key) return { key: first.key, source: "stored" };
  const lock = `${file}.lock`;
  const deadline = Date.now() + 5_000;
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  } catch {
    return { key: randomBytes(32), source: "ephemeral" };
  }
  for (;;) {
    let held = false;
    try {
      writeFileSync(lock, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
      held = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST")
        return { key: randomBytes(32), source: "ephemeral" };
    }
    if (held) {
      try {
        // Another process may have written it between our read and the lock.
        const now = readKey(file);
        if (now.key) return { key: now.key, source: "stored" };
        const fresh = randomBytes(32);
        const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
        writeFileSync(tmp, fresh, { flag: "wx", mode: 0o600 });
        try {
          renameSync(tmp, file);
        } catch {
          rmSync(tmp, { force: true });
          return { key: fresh, source: "ephemeral" };
        }
        return { key: fresh, source: now.exists ? "repaired" : "stored" };
      } catch {
        return { key: randomBytes(32), source: "ephemeral" };
      } finally {
        rmSync(lock, { force: true });
      }
    }
    const now = readKey(file);
    if (now.key) return { key: now.key, source: "stored" };
    try {
      if (Date.now() - statSync(lock).mtimeMs > 10_000) rmSync(lock, { force: true });
    } catch {
      // The lock is gone: try again.
    }
    if (Date.now() > deadline) return { key: randomBytes(32), source: "ephemeral" };
    pause(20);
  }
}

/** How this process got its state key (undefined before the first use). */
export function stateKeySource(): StateKeySource | undefined {
  return keySource;
}
/** Minimum length of `SMARTTEST_STATE_KEY`; a shorter value is ignored (with a warning). */
export const MIN_STATE_KEY_LENGTH = 32;
let shortKeyWarned = false;

/** The key state files are authenticated with. */
export function stateKey(): Buffer {
  const fromEnv = process.env.SMARTTEST_STATE_KEY;
  if (fromEnv && fromEnv.length >= MIN_STATE_KEY_LENGTH) {
    keySource ??= "env";
    return Buffer.from(fromEnv, "utf8");
  }
  if (fromEnv && !shortKeyWarned) {
    shortKeyWarned = true;
    process.stderr.write(
      `▲ SMARTTEST_STATE_KEY is ignored: it has ${fromEnv.length} characters, at least ${MIN_STATE_KEY_LENGTH} are required. State is authenticated with the per-user key instead, so jobs sharing a cache rebuild it.\n`,
    );
  }
  if (userKey) return userKey;
  const loaded = loadStateKey(stateKeyFile());
  userKey = loaded.key;
  keySource = loaded.source;
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
