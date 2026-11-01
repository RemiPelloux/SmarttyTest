import { Worker } from "node:worker_threads";

/** Squares a number in a worker thread (src/workers/square.mjs). */
export function square(n: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./workers/square.mjs", import.meta.url), { workerData: n });
    worker.once("message", resolve);
    worker.once("error", reject);
  });
}
