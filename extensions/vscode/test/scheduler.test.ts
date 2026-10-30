import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CancelledError } from "../src/core/errors.js";
import {
  ConcurrencyLimiter,
  KeyedScheduler,
  LatestTask,
  mapLimit,
  SharedTasks,
} from "../src/core/scheduler.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function hanging(signal: AbortSignal): Promise<void> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) reject(new CancelledError());
    signal.addEventListener("abort", () => reject(new CancelledError()), { once: true });
  });
}

describe("LatestTask", () => {
  it("debounces and runs only the newest generation", async () => {
    const events: number[] = [];
    const task = new LatestTask({
      delayMs: 50,
      run: async (signal, generation) => {
        events.push(generation);
        await hanging(signal);
      },
      onError: () => undefined,
    });
    task.trigger();
    await vi.advanceTimersByTimeAsync(20);
    task.trigger();
    await vi.advanceTimersByTimeAsync(49);
    expect(events).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(events).toEqual([2]);
    task.dispose();
  });

  it("aborts the previous run when a new trigger arrives", async () => {
    const started: number[] = [];
    const aborted: number[] = [];
    const task = new LatestTask({
      delayMs: 0,
      run: async (signal, generation) => {
        started.push(generation);
        signal.addEventListener("abort", () => aborted.push(generation), { once: true });
        await hanging(signal);
      },
      onError: () => undefined,
    });
    task.trigger();
    await vi.advanceTimersByTimeAsync(1);
    task.trigger();
    await vi.advanceTimersByTimeAsync(1);
    expect(started).toEqual([1, 2]);
    expect(aborted).toEqual([1]);
    task.dispose();
  });

  it("does not report a cancellation as an error", async () => {
    const onError = vi.fn();
    const task = new LatestTask({ delayMs: 0, run: hanging, onError });
    task.trigger();
    await vi.advanceTimersByTimeAsync(1);
    task.cancel();
    await vi.advanceTimersByTimeAsync(1);
    expect(onError).not.toHaveBeenCalled();
    task.dispose();
  });
});

describe("KeyedScheduler", () => {
  it("keeps folders independent", async () => {
    const started: string[] = [];
    const scheduler = new KeyedScheduler({
      delayMs: () => 10,
      run: async (key) => {
        started.push(key);
      },
      onError: () => undefined,
    });
    scheduler.trigger("a");
    scheduler.trigger("b");
    scheduler.trigger("a");
    await vi.advanceTimersByTimeAsync(11);
    expect(started.sort()).toEqual(["a", "b"]);
    scheduler.dispose();
  });

  it("reads the delay on every trigger, per key", async () => {
    let delay = 10;
    const keys: string[] = [];
    const started: string[] = [];
    const scheduler = new KeyedScheduler({
      delayMs: (key) => {
        keys.push(key);
        return delay;
      },
      run: async (key) => {
        started.push(key);
      },
      onError: () => undefined,
    });
    scheduler.trigger("a");
    await vi.advanceTimersByTimeAsync(11);
    expect(started).toEqual(["a"]);
    delay = 100;
    scheduler.trigger("a");
    await vi.advanceTimersByTimeAsync(50);
    expect(started).toEqual(["a"]);
    await vi.advanceTimersByTimeAsync(51);
    expect(started).toEqual(["a", "a"]);
    expect(keys).toEqual(["a", "a"]);
    scheduler.dispose();
  });
});

describe("ConcurrencyLimiter", () => {
  it("bounds work across independent callers", async () => {
    vi.useRealTimers();
    const limiter = new ConcurrencyLimiter(2);
    let active = 0;
    let max = 0;
    const work = async (): Promise<void> => {
      active += 1;
      max = Math.max(max, active);
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
      active -= 1;
    };
    // Two "analyses", each with its own mapLimit of 3, share the limiter.
    await Promise.all([
      mapLimit([1, 2, 3], 3, () => limiter.run(work)),
      mapLimit([1, 2, 3], 3, () => limiter.run(work)),
    ]);
    expect(max).toBe(2);
    expect(limiter.active).toBe(0);
  });

  it("drops a queued caller whose signal aborts", async () => {
    const limiter = new ConcurrencyLimiter(1);
    let release: () => void = () => undefined;
    const first = limiter.run(() => new Promise<void>((resolve) => (release = resolve)));
    const controller = new AbortController();
    const second = vi.fn(async () => undefined);
    const queued = limiter.run(second, controller.signal);
    controller.abort();
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    release();
    await first;
    expect(second).not.toHaveBeenCalled();
    expect(limiter.active).toBe(0);
  });
});

describe("SharedTasks", () => {
  it("shares one in-flight promise between callers with the same key", async () => {
    const tasks = new SharedTasks<number>();
    const start = vi.fn(async () => 42);
    const a = new AbortController();
    const b = new AbortController();
    const results = await Promise.all([
      tasks.run("k", a.signal, start),
      tasks.run("k", b.signal, start),
    ]);
    expect(results).toEqual([42, 42]);
    expect(start).toHaveBeenCalledTimes(1);
    expect(tasks.size).toBe(0);
  });

  it("aborts the shared work only when every waiter cancels", async () => {
    const tasks = new SharedTasks<void>();
    let sharedSignal: AbortSignal | undefined;
    const start = (signal: AbortSignal): Promise<void> => {
      sharedSignal = signal;
      return hanging(signal);
    };
    const a = new AbortController();
    const b = new AbortController();
    const first = tasks.run("k", a.signal, start);
    const second = tasks.run("k", b.signal, start);
    a.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    expect(sharedSignal?.aborted).toBe(false);
    b.abort();
    await expect(second).rejects.toMatchObject({ name: "AbortError" });
    expect(sharedSignal?.aborted).toBe(true);
    expect(tasks.size).toBe(0);
  });

  it("starts fresh work after the previous run was abandoned", async () => {
    const tasks = new SharedTasks<number>();
    const a = new AbortController();
    const abandoned = tasks.run("k", a.signal, hanging as (signal: AbortSignal) => Promise<never>);
    a.abort();
    await expect(abandoned).rejects.toMatchObject({ name: "AbortError" });
    await expect(tasks.run("k", new AbortController().signal, async () => 7)).resolves.toBe(7);
  });
});

describe("mapLimit", () => {
  it("bounds concurrency and preserves result order", async () => {
    let active = 0;
    let max = 0;
    const results = await mapLimit([1, 2, 3, 4, 5], 2, async (item) => {
      active += 1;
      max = Math.max(max, active);
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      active -= 1;
      return item * 2;
    });
    expect(results).toEqual([2, 4, 6, 8, 10]);
    expect(max).toBeLessThanOrEqual(2);
    expect(max).toBeGreaterThan(1);
  });

  it("stops before starting new work when the signal is aborted", async () => {
    const controller = new AbortController();
    const seen: number[] = [];
    await expect(
      mapLimit(
        [1, 2, 3, 4],
        1,
        async (item) => {
          seen.push(item);
          if (item === 1) controller.abort();
          return item;
        },
        controller.signal,
      ),
    ).rejects.toBeInstanceOf(DOMException);
    expect(seen).toEqual([1]);
  });
});
