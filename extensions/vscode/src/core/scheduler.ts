/**
 * Debounced, latest-wins work scheduling. A refresh request:
 * - waits `delayMs`; a newer request within that window replaces it;
 * - aborts the previous run for the same key before starting the new one;
 * - ignores the result of a run that a newer request superseded.
 */
import { isCancelledError } from "./errors.js";

export interface LatestTaskOptions {
  /** Read on every trigger, so a changed setting applies to the next refresh. */
  readonly delayMs: number | (() => number);
  readonly run: (signal: AbortSignal, generation: number) => Promise<void>;
  readonly onError: (error: unknown) => void;
  readonly onSettled?: () => void;
}

export class LatestTask {
  readonly #delayMs: LatestTaskOptions["delayMs"];
  readonly #run: LatestTaskOptions["run"];
  readonly #onError: LatestTaskOptions["onError"];
  readonly #onSettled: (() => void) | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #controller: AbortController | undefined;
  #generation = 0;
  #running: Promise<void> | undefined;
  #disposed = false;

  constructor(options: LatestTaskOptions) {
    this.#delayMs = options.delayMs;
    this.#run = options.run;
    this.#onError = options.onError;
    this.#onSettled = options.onSettled;
  }

  trigger(): void {
    if (this.#disposed) return;
    this.#generation += 1;
    const generation = this.#generation;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#controller?.abort();
    this.#controller = undefined;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      if (this.#disposed || generation !== this.#generation) return;
      const controller = new AbortController();
      this.#controller = controller;
      const running = this.#run(controller.signal, generation)
        .catch((error: unknown) => {
          if (isCancelledError(error) || controller.signal.aborted) return;
          if (generation !== this.#generation) return;
          this.#onError(error);
        })
        .finally(() => {
          if (generation === this.#generation) {
            this.#controller = undefined;
            this.#running = undefined;
          }
          this.#onSettled?.();
        });
      this.#running = running;
    }, this.#delay());
  }

  #delay(): number {
    const value = typeof this.#delayMs === "function" ? this.#delayMs() : this.#delayMs;
    return Number.isFinite(value) ? Math.max(0, value) : 0;
  }

  /** Aborts a running task and drops a pending one. */
  cancel(): void {
    this.#generation += 1;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#controller?.abort();
    this.#controller = undefined;
  }

  /** Resolves when the current run (if any) settles; used by tests and deactivation. */
  async idle(): Promise<void> {
    while (this.#running) await this.#running;
  }

  dispose(): void {
    this.#disposed = true;
    this.cancel();
  }
}

/** One LatestTask per key, so saving file A does not cancel file B's refresh. */
export class KeyedScheduler {
  readonly #tasks = new Map<string, LatestTask>();
  readonly #options: {
    readonly delayMs: (key: string) => number;
    readonly run: (key: string, signal: AbortSignal, generation: number) => Promise<void>;
    readonly onError: (key: string, error: unknown) => void;
  };
  readonly #disposed = { value: false };

  constructor(options: {
    readonly delayMs: (key: string) => number;
    readonly run: (key: string, signal: AbortSignal, generation: number) => Promise<void>;
    readonly onError: (key: string, error: unknown) => void;
  }) {
    this.#options = options;
  }

  trigger(key: string): void {
    if (this.#disposed.value) return;
    let task = this.#tasks.get(key);
    if (!task) {
      task = new LatestTask({
        delayMs: () => this.#options.delayMs(key),
        run: (signal, generation) => this.#options.run(key, signal, generation),
        onError: (error) => this.#options.onError(key, error),
      });
      this.#tasks.set(key, task);
    }
    task.trigger();
  }

  cancel(key: string): void {
    this.#tasks.get(key)?.cancel();
  }

  cancelAll(): void {
    for (const task of this.#tasks.values()) task.cancel();
  }

  async idle(): Promise<void> {
    await Promise.all([...this.#tasks.values()].map((task) => task.idle()));
  }

  dispose(): void {
    this.#disposed.value = true;
    for (const task of this.#tasks.values()) task.dispose();
    this.#tasks.clear();
  }
}

/** Runs `worker` over `items` with at most `limit` in flight, preserving order. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  if (items.length === 0) return [];
  const effective = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: effective }, async () => {
    while (next < items.length) {
      signal?.throwIfAborted();
      const index = next;
      next += 1;
      const item = items[index] as T;
      results[index] = await worker(item, index);
    }
  });
  await Promise.all(runners);
  return results;
}

function abortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}

/**
 * A shared concurrency bound: every caller that holds the same limiter competes
 * for the same `limit` slots, so two analyses of one folder cannot together
 * exceed `smarttest.maxConcurrentExplain`.
 */
export class ConcurrencyLimiter {
  #limit: number;
  #active = 0;
  readonly #queue: (() => void)[] = [];

  constructor(limit: number) {
    this.#limit = ConcurrencyLimiter.#normalise(limit);
  }

  static #normalise(limit: number): number {
    return Math.max(1, Math.floor(limit) || 1);
  }

  get active(): number {
    return this.#active;
  }

  setLimit(limit: number): void {
    this.#limit = ConcurrencyLimiter.#normalise(limit);
    this.#drain();
  }

  async run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.#acquire(signal);
    try {
      return await work();
    } finally {
      this.#active -= 1;
      this.#drain();
    }
  }

  #acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(abortError());
    if (this.#active < this.#limit) {
      this.#active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const grant = (): void => {
        signal?.removeEventListener("abort", onAbort);
        this.#active += 1;
        resolve();
      };
      const onAbort = (): void => {
        const index = this.#queue.indexOf(grant);
        if (index >= 0) this.#queue.splice(index, 1);
        reject(abortError());
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#queue.push(grant);
    });
  }

  #drain(): void {
    while (this.#active < this.#limit) {
      const next = this.#queue.shift();
      if (!next) return;
      next();
    }
  }
}

interface SharedEntry<T> {
  readonly promise: Promise<T>;
  readonly controller: AbortController;
  waiters: number;
}

/**
 * Deduplicates in-flight work by key: concurrent callers share one promise.
 * Each caller's signal only stops that caller waiting; the shared work is
 * aborted when every waiter has cancelled.
 */
export class SharedTasks<T> {
  readonly #entries = new Map<string, SharedEntry<T>>();

  get size(): number {
    return this.#entries.size;
  }

  run(key: string, signal: AbortSignal, start: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (signal.aborted) return Promise.reject(abortError());
    let entry = this.#entries.get(key);
    if (!entry) {
      const controller = new AbortController();
      const promise = start(controller.signal);
      const created: SharedEntry<T> = { promise, controller, waiters: 0 };
      entry = created;
      this.#entries.set(key, created);
      const forget = (): void => {
        if (this.#entries.get(key) === created) this.#entries.delete(key);
      };
      promise.then(forget, forget);
    }
    const shared = entry;
    shared.waiters += 1;
    return new Promise<T>((resolve, reject) => {
      let done = false;
      const leave = (): void => {
        if (done) return;
        done = true;
        signal.removeEventListener("abort", onAbort);
        shared.waiters -= 1;
      };
      const onAbort = (): void => {
        leave();
        if (shared.waiters === 0) {
          if (this.#entries.get(key) === shared) this.#entries.delete(key);
          shared.controller.abort();
        }
        reject(abortError());
      };
      signal.addEventListener("abort", onAbort, { once: true });
      shared.promise.then(
        (value) => {
          if (done) return;
          leave();
          resolve(value);
        },
        (error: unknown) => {
          if (done) return;
          leave();
          reject(error);
        },
      );
    });
  }

  /** Aborts and forgets every in-flight entry (used on invalidation). */
  clear(): void {
    for (const entry of this.#entries.values()) entry.controller.abort();
    this.#entries.clear();
  }
}
