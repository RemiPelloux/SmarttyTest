import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { capShadowLog } from "./smarttest.js";
import {
  type HistoryStore,
  loadHistory,
  loadResultCache,
  pruneHistory,
  type ResultCache,
  recordRun,
  saveHistory,
  saveResultCache,
} from "./speed.js";

describe("bounded state", () => {
  it("drops cached results of test files that are gone, writes them compact and still signed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "st-retention-"));
    try {
      const entry = { key: "k", at: "t", durationMs: 1, tests: [] };
      const cache: ResultCache = {
        version: 1,
        files: { "a.test.ts": [entry], "renamed.test.ts": [entry], "deleted.test.ts": [entry] },
      };
      await saveResultCache(dir, cache, ["a.test.ts", "b.test.ts"]);
      const text = await readFile(join(dir, "cache", "results.json"), "utf8");
      expect(text.trimEnd()).not.toContain("\n");
      expect(Object.keys((await loadResultCache(dir)).files)).toEqual(["a.test.ts"]);
      // A tampered file is still refused (the MAC covers the compact bytes).
      await writeFile(join(dir, "cache", "results.json"), text.replace('"k"', '"x"'));
      expect((await loadResultCache(dir)).files).toEqual({});
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps the history to current tests and caps it, least recently run first", async () => {
    const store: HistoryStore = { version: 1, tests: {} };
    recordRun(store, [{ testId: "old.test.ts::x", status: "passed", durationMs: 1, attempts: 1 }]);
    for (let i = 0; i < 5; i++)
      recordRun(
        store,
        [{ testId: `a.test.ts::t${i}`, status: "failed", durationMs: 1, attempts: 1 }],
        `2026-01-0${i + 1}T00:00:00.000Z`,
      );
    pruneHistory(store, ["a.test.ts"], 3);
    expect(Object.keys(store.tests).sort()).toEqual([
      "a.test.ts::t2",
      "a.test.ts::t3",
      "a.test.ts::t4",
    ]);
    const dir = await mkdtemp(join(tmpdir(), "st-history-"));
    try {
      await saveHistory(dir, store);
      expect((await readFile(join(dir, "state", "history.json"), "utf8")).trimEnd()).not.toContain(
        "\n",
      );
      expect(await loadHistory(dir)).toEqual(store);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("trims the Shadow Mode log to its most recent records", async () => {
    const dir = await mkdtemp(join(tmpdir(), "st-shadow-"));
    try {
      await mkdir(join(dir, "shadow"));
      const log = join(dir, "shadow", "history.jsonl");
      const line = (i: number) => JSON.stringify({ at: `r${i}`, pad: "x".repeat(80) });
      await writeFile(log, `${Array.from({ length: 100 }, (_, i) => line(i)).join("\n")}\n`);
      await capShadowLog(log, 1_000_000, 10);
      expect((await readFile(log, "utf8")).split("\n").filter(Boolean)).toHaveLength(100);
      await capShadowLog(log, 2_000, 50);
      const kept = (await readFile(log, "utf8")).split("\n").filter(Boolean);
      expect(kept.length).toBeLessThan(50);
      expect(kept.length).toBeGreaterThan(0);
      expect(kept.at(-1)).toBe(line(99));
      expect(Buffer.byteLength(kept.join("\n"))).toBeLessThanOrEqual(1_000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
