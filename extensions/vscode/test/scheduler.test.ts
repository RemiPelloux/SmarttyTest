import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CancelledError } from "../src/core/errors.js";
import { KeyedScheduler, LatestTask, mapLimit } from "../src/core/scheduler.js";

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
