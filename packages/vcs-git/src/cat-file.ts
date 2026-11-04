/**
 * Reads many blobs through one long-lived `git cat-file --batch` per repository directory, instead
 * of one `git show` process per file (400 changed files used to start 400 processes).
 *
 * Exactness: a blob comes back as the same text `git show <rev>:<path>` prints; an object that does
 * not exist is `undefined`, like a failing `git show`. Whatever the batch cannot answer the same
 * way (a name containing a newline, a tree, an ambiguous name, a process that failed or exited) is
 * read with `git show` instead, so a read is never silently empty.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { runProcess, scopedEnv } from "@smarttest/shared";

/** How long an idle batch process stays up before its input is closed (it then exits). */
const IDLE_MS = 2_000;
/** How long a closed batch process has to exit before it is killed. */
const CLOSE_MS = 5_000;

interface Request {
  name: string;
  resolve: (value: Reply) => void;
}

/** `blob` with its text; `missing` (no such object); `other`: ask `git show` instead. */
type Reply = { kind: "blob"; text: string } | { kind: "missing" } | { kind: "other" };

class BatchProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly queue: Request[] = [];
  private buffer: Buffer = Buffer.alloc(0);
  /** Body of the current reply: [bytes expected (content + LF), kind]. */
  private body: { size: number; blob: boolean } | undefined;
  private idle: NodeJS.Timeout | undefined;
  broken = false;
  /** Settles once the process is gone, its working directory and the repository's files released. */
  readonly exited: Promise<void>;

  constructor(cwd: string, config: readonly string[], env: NodeJS.ProcessEnv) {
    this.child = spawn("git", [...config, "cat-file", "--batch"], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.exited = new Promise((resolve) => {
      this.child.on("close", () => {
        this.fail();
        resolve();
      });
      this.child.on("error", () => {
        this.fail();
        // A process that never started emits no `close`.
        if (this.child.pid === undefined) resolve();
      });
    });
    this.child.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
    // Drained so a chatty stderr never blocks the process.
    this.child.stderr.on("data", () => undefined);
    this.child.stdin.on("error", () => this.fail());
    this.setRef(false);
  }

  /** Keeps Node alive only while a reply is awaited. */
  private setRef(on: boolean): void {
    const handles = [this.child, this.child.stdin, this.child.stdout, this.child.stderr] as {
      ref?: () => void;
      unref?: () => void;
    }[];
    for (const h of handles) (on ? h.ref : h.unref)?.call(h);
  }

  read(name: string): Promise<Reply> {
    if (this.broken) return Promise.resolve({ kind: "other" });
    if (this.idle) clearTimeout(this.idle);
    this.idle = undefined;
    return new Promise<Reply>((resolve) => {
      this.queue.push({ name, resolve });
      if (this.queue.length === 1) this.setRef(true);
      try {
        this.child.stdin.write(`${name}\n`);
      } catch {
        this.fail();
      }
    });
  }

  private settle(reply: Reply): void {
    this.queue.shift()?.resolve(reply);
    if (this.queue.length) return;
    this.setRef(false);
    this.idle = setTimeout(() => void this.close(), IDLE_MS);
    this.idle.unref();
  }

  private onData(chunk: Buffer): void {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    for (;;) {
      if (this.body) {
        if (this.buffer.length < this.body.size) return;
        const content = this.buffer.subarray(0, this.body.size - 1);
        const blob = this.body.blob;
        this.buffer = this.buffer.subarray(this.body.size);
        this.body = undefined;
        this.settle(blob ? { kind: "blob", text: content.toString("utf8") } : { kind: "other" });
        continue;
      }
      const eol = this.buffer.indexOf(10);
      if (eol < 0) return;
      const header = this.buffer.subarray(0, eol).toString("utf8");
      this.buffer = this.buffer.subarray(eol + 1);
      // `<oid> <type> <size>`, `<name> missing`, `<name> ambiguous`.
      const m = /^[0-9a-f]+ (\S+) (\d+)$/.exec(header);
      if (m) {
        this.body = { size: Number(m[2]) + 1, blob: m[1] === "blob" };
        continue;
      }
      if (header.endsWith(" missing")) this.settle({ kind: "missing" });
      else this.settle({ kind: "other" });
    }
  }

  /** The process failed or exited: everything still waiting is read with `git show`. */
  private fail(): void {
    if (this.broken) return;
    this.broken = true;
    if (this.idle) clearTimeout(this.idle);
    for (const r of this.queue.splice(0)) r.resolve({ kind: "other" });
    this.setRef(false);
  }

  /**
   * Ends the process: git answers the names already sent, then exits at the end of its input.
   * Settles once it has exited, since Windows cannot delete a directory a process still runs in.
   * A process that does not exit in time is killed (what was still waiting is read with git show).
   */
  close(): Promise<void> {
    this.broken = true;
    if (this.idle) clearTimeout(this.idle);
    this.idle = undefined;
    try {
      this.child.stdin.end();
    } catch {
      // Already closed.
    }
    const kill = setTimeout(() => this.child.kill(), CLOSE_MS);
    kill.unref();
    return this.exited.finally(() => clearTimeout(kill));
  }
}

/** The Git variables that decide which repository and index a process reads. */
function gitEnvKey(env: NodeJS.ProcessEnv): string {
  return JSON.stringify(
    Object.keys(env)
      .filter((k) => k.startsWith("GIT_"))
      .sort()
      .map((k) => [k, env[k]]),
  );
}

export class BlobReader {
  private readonly processes = new Map<string, BatchProcess>();
  /** Every process not yet exited, including idle ones already closing. */
  private readonly live = new Set<BatchProcess>();

  constructor(private readonly config: readonly string[]) {}

  /**
   * The text of `<rev>:<path>` in the repository at `cwd`, or undefined when it does not exist
   * there (as `git show` would fail).
   */
  async read(cwd: string, rev: string, path: string): Promise<string | undefined> {
    const name = `${rev}:${path}`;
    if (!name.includes("\n") && !name.includes("\r")) {
      const env = scopedEnv();
      const key = `${cwd}\u0000${gitEnvKey(env)}`;
      let proc = this.processes.get(key);
      if (!proc || proc.broken) {
        const started = new BatchProcess(cwd, this.config, env);
        this.live.add(started);
        void started.exited.then(() => this.live.delete(started));
        this.processes.set(key, started);
        proc = started;
      }
      const reply = await proc.read(name);
      if (reply.kind === "blob") return reply.text;
      if (reply.kind === "missing") return undefined;
    }
    const res = await runProcess("git", [...this.config, "show", name], { cwd });
    return res.code === 0 ? res.stdout : undefined;
  }

  /**
   * Ends every batch process this reader started and settles once they have all exited (an idle
   * one may still be exiting). The reader stays usable: a later read starts a new process.
   */
  async close(): Promise<void> {
    this.processes.clear();
    await Promise.all([...this.live].map((p) => p.close()));
  }
}
