/**
 * Debounced, latest-wins work scheduling. A refresh request:
 * - waits `delayMs`; a newer request within that window replaces it;
 * - aborts the previous run for the same key before starting the new one;
 * - ignores the result of a run that a newer request superseded.
 */
import { isCancelledError } from "./errors.js";

export interface LatestTaskOptions {
  readonly delayMs: number;
  readonly run: (signal: AbortSignal, generation: number) => Promise<void>;
  readonly onError: (error: unknown) => void;
  readonly onSettled?: () => void;
}

export class LatestTask {
  readonly #delayMs: number;
  readonly #run: LatestTaskOptions["run"];
  readonly #onError: LatestTaskOptions["onError"];
  readonly #onSettled: (() => void) | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #controller: AbortController | undefined;
  #generation = 0;
  #running: Promise<void> | undefined;
  #disposed = false;

  constructor(options: LatestTaskOptions) {
    this.#delayMs = Math.max(0, options.delayMs);
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
    }, this.#delayMs);
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
  readonly #delayMs: () => number;
  readonly #options: {
    readonly delayMs: () => number;
    readonly run: (key: string, signal: AbortSignal, generation: number) => Promise<void>;
    readonly onError: (key: string, error: unknown) => void;
  };
  readonly #disposed = { value: false };

  constructor(options: {
    readonly delayMs: () => number;
    readonly run: (key: string, signal: AbortSignal, generation: number) => Promise<void>;
    readonly onError: (key: string, error: unknown) => void;
  }) {
    this.#options = options;
    this.#delayMs = options.delayMs;
  }

  trigger(key: string): void {
    if (this.#disposed.value) return;
    let task = this.#tasks.get(key);
    if (!task) {
      task = new LatestTask({
        delayMs: this.#delayMs(),
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
