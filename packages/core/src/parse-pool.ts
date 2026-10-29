/**
 * Parses many files in worker threads, for cold starts. Workers are started as early as possible
 * (they load the TypeScript compiler, which takes a few hundred milliseconds) so that their start-up
 * overlaps with listing and reading files. When the worker script is not available, for example
 * when running from TypeScript sources, parsing stays in the main thread.
 */
import { existsSync } from "node:fs";
import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type { FileAnalysis } from "@smarttest/source-parser";

const workerUrl = new URL("./parse-worker.js", import.meta.url);

export function parallelParsingAvailable(): boolean {
  try {
    return process.env.SMARTTEST_NO_WORKERS !== "1" && existsSync(fileURLToPath(workerUrl));
  } catch {
    return false;
  }
}

type Job = { path: string; content: string };
type Reply = { id: number; out: (FileAnalysis | null)[] };

export class ParsePool {
  private readonly workers: Worker[];
  private readonly ready: Promise<void>[];
  private closed = false;

  constructor(
    threads = Number(process.env.SMARTTEST_PARSE_THREADS) ||
      Math.max(2, Math.min(6, availableParallelism() - 2)),
  ) {
    this.workers = Array.from({ length: threads }, () => new Worker(workerUrl));
    // A warm-up message makes each worker load the analyzers now.
    this.ready = this.workers.map(
      (w) =>
        new Promise<void>((resolve) => {
          w.once("message", () => resolve());
          w.once("error", () => resolve());
          w.postMessage({ id: 0, jobs: [] });
        }),
    );
  }

  /** Analyses in job order; entries a worker could not produce are undefined. */
  async parse(jobs: Job[]): Promise<(FileAnalysis | undefined)[] | undefined> {
    if (this.closed) return undefined;
    const results: (FileAnalysis | undefined)[] = new Array(jobs.length);
    const order = jobs
      .map((_, i) => i)
      .sort((a, b) => (jobs[b]?.content.length ?? 0) - (jobs[a]?.content.length ?? 0));
    const BATCH = 60;
    const batches: number[][] = [];
    for (let i = 0; i < order.length; i += BATCH) batches.push(order.slice(i, i + BATCH));
    try {
      await Promise.all(
        this.workers.map(async (w, wi) => {
          await this.ready[wi];
          let id = 0;
          for (let batch = batches.shift(); batch; batch = batches.shift()) {
            const myId = ++id;
            const b = batch;
            const reply = await new Promise<Reply>((resolve, reject) => {
              const onMessage = (msg: Reply) => {
                if (msg.id !== myId) return;
                w.off("message", onMessage);
                w.off("error", reject);
                resolve(msg);
              };
              w.on("message", onMessage);
              w.once("error", reject);
              w.postMessage({ id: myId, jobs: b.map((i) => jobs[i]) });
            });
            for (const [k, idx] of b.entries()) results[idx] = reply.out[k] ?? undefined;
          }
        }),
      );
    } catch {
      return undefined;
    }
    return results;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.all(this.workers.map((w) => w.terminate()));
  }
}
