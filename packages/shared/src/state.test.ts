import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readStateFile,
  readStateFileSync,
  readStateJson,
  stateKey,
  stateKeyFile,
  writeStateFile,
  writeStateJson,
} from "./state.js";

const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function dir() {
  const d = await mkdtemp(join(tmpdir(), "st-state-"));
  dirs.push(d);
  return d;
}

/** Points the per-user key at a temporary cache directory (every platform's variable). */
async function keyHome(): Promise<string> {
  const home = await dir();
  vi.stubEnv("SMARTTEST_STATE_KEY", "");
  vi.stubEnv("XDG_CACHE_HOME", home);
  vi.stubEnv("LOCALAPPDATA", home);
  vi.stubEnv("HOME", home);
  return process.platform === "darwin" ? join(home, "Library", "Caches") : home;
}

/** A new process, as far as the in-memory key is concerned. */
async function freshState(): Promise<typeof import("./state.js")> {
  vi.resetModules();
  return import("./state.js");
}

describe("authenticated state (SR-16)", () => {
  it("reads back what this key wrote", async () => {
    const path = join(await dir(), "results.json");
    await writeStateJson(path, { version: 1, files: {} });
    expect(await readStateJson(path)).toEqual({ version: 1, files: {} });
    expect(readStateFileSync(path)).toContain('"version": 1');
  });

  it("treats a planted, edited or foreign file as absent", async () => {
    const d = await dir();
    // Planted: no MAC at all (a pull request or a cache from elsewhere).
    const planted = join(d, "index.json");
    await writeFile(planted, '{"schemaVersion":2,"files":{}}');
    expect(await readStateFile(planted)).toBeUndefined();
    expect(readStateFileSync(planted)).toBeUndefined();
    // Edited after it was written: the MAC no longer matches.
    const edited = join(d, "graph.json");
    await writeStateFile(edited, "header\nbody");
    await writeFile(edited, "header\nbody without edges");
    expect(await readStateFile(edited)).toBeUndefined();
    // A MAC copied from another file does not vouch for this one.
    const other = join(d, "traces.json");
    await writeStateFile(other, "header\nbody");
    await writeFile(join(d, "graph.json"), "header\nbody");
    await writeFile(join(d, "graph.json.mac"), await readFile(`${other}.mac`, "utf8"));
    expect(await readStateFile(join(d, "graph.json"))).toBeUndefined();
  });

  it("does not trust state written under another key (another machine, a fork's CI job)", async () => {
    const path = join(await dir(), "discovery.json");
    vi.stubEnv("SMARTTEST_STATE_KEY", "a".repeat(40));
    await writeStateJson(path, { k: ["test/a.test.ts"] });
    expect(await readStateJson(path)).toEqual({ k: ["test/a.test.ts"] });
    vi.stubEnv("SMARTTEST_STATE_KEY", "b".repeat(40));
    expect(await readStateJson(path)).toBeUndefined();
  });

  it("repairs a truncated key file once, atomically, and keeps the repaired key", async () => {
    const cache = await keyHome();
    const file = join(cache, "smarttest", "state.key");
    await mkdir(join(cache, "smarttest"), { recursive: true });
    await writeFile(file, "short");
    const first = await freshState();
    const key = first.stateKey();
    expect(first.stateKeySource()).toBe("repaired");
    expect(key).toHaveLength(32);
    expect(await readFile(file)).toEqual(key);
    // The next process reads the same key: signed caches survive again.
    const second = await freshState();
    expect(second.stateKey()).toEqual(key);
    expect(second.stateKeySource()).toBe("stored");
  });

  it("never lets two processes repair the key into different keys", async () => {
    const cache = await keyHome();
    const dirPath = join(cache, "smarttest");
    const file = join(dirPath, "state.key");
    await mkdir(dirPath, { recursive: true });
    await writeFile(file, "short");
    // Another process holds the lock and writes its key a moment later.
    await writeFile(`${file}.lock`, "1\n");
    const theirs = "k".repeat(32);
    const worker = new Worker(
      `const fs = require("node:fs");
       const { file, key } = require("node:worker_threads").workerData;
       setTimeout(() => {
         fs.writeFileSync(file + ".w.tmp", key);
         fs.renameSync(file + ".w.tmp", file);
         fs.rmSync(file + ".lock");
       }, 150);`,
      { eval: true, workerData: { file, key: theirs } },
    );
    const state = await freshState();
    expect(state.stateKey().toString()).toBe(theirs);
    await worker.terminate();
  });

  it("warns once when SMARTTEST_STATE_KEY is too short to be used", () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      vi.stubEnv("SMARTTEST_STATE_KEY", "too-short");
      stateKey();
      stateKey();
      const warnings = write.mock.calls.map((c) => String(c[0]));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("SMARTTEST_STATE_KEY");
      expect(warnings[0]).toContain("at least 32");
    } finally {
      write.mockRestore();
    }
  });

  it("keeps the per-user key outside every project", () => {
    expect(stateKeyFile({ XDG_CACHE_HOME: "/home/u/.cache" })).toMatch(
      process.platform === "linux" ? /^\/home\/u\/\.cache\/smarttest\/state\.key$/ : /state\.key$/,
    );
  });
});
