/**
 * SR-16: caches that decide what runs are used only when this machine wrote them.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadResultCache, saveResultCache } from "./speed.js";
import { loadTraces, saveTraces } from "./traces.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("planted result cache and traces (SR-16)", () => {
  it("ignores a result cache that claims passes without this machine's MAC", async () => {
    const store = await mkdtemp(join(tmpdir(), "st-trust-"));
    dirs.push(store);
    const claim = {
      version: 1,
      files: { "test/a.test.ts": [{ key: "k", at: "t", durationMs: 1, tests: [] }] },
    };
    await mkdir(join(store, "cache"), { recursive: true });
    await writeFile(join(store, "cache", "results.json"), JSON.stringify(claim));
    expect((await loadResultCache(store)).files).toEqual({});
    await saveResultCache(store, claim as Parameters<typeof saveResultCache>[1]);
    expect((await loadResultCache(store)).files).toEqual(claim.files);
  });

  it("ignores planted traces, which could rule tests out outside SAFE mode", async () => {
    const store = await mkdtemp(join(tmpdir(), "st-trust-"));
    dirs.push(store);
    await mkdir(join(store, "state"), { recursive: true });
    const traces = { version: 1, env: "e", tests: {} };
    await writeFile(join(store, "state", "traces.json"), JSON.stringify(traces));
    expect(await loadTraces(store)).toBeUndefined();
  });

  it("keeps traces it wrote itself", async () => {
    const store = await mkdtemp(join(tmpdir(), "st-trust-"));
    dirs.push(store);
    const valid = await loadTraces(store);
    expect(valid).toBeUndefined();
    const { TRACE_STORE_VERSION } = await import("./traces.js");
    const own = { version: TRACE_STORE_VERSION, env: "e", tests: {} };
    await saveTraces(store, own as Parameters<typeof saveTraces>[1]);
    expect(await loadTraces(store)).toEqual(own);
  });
});
