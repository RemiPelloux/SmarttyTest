import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeSource } from "@smarttest/language-typescript";
import type { FileAnalysis } from "@smarttest/source-parser";
import { describe, expect, it } from "vitest";
import {
  decodeTraces,
  encodeTraces,
  loadTraces,
  saveTraces,
  type TestTrace,
  TRACE_STORE_VERSION,
  type TraceStore,
  TraceView,
  traceEnv,
} from "./traces.js";

const files = new Map<string, FileAnalysis>(
  Object.entries({
    "src/run.ts":
      "export const run = () => (process.env.USE_FRESH ? fresh() : legacy());\nconst fresh = () => 1;\nconst legacy = () => 2;\n",
    "src/plain.ts": "export const plain = () => 1;\n",
    "src/any.ts": "export const any = (k: string) => process.env[k];\n",
    "test/run.test.ts": 'import { run } from "../src/run";\nrun();\n',
  }).map(([p, c]) => [p, analyzeSource(p, c)]),
);

const view = (
  trace: Omit<TestTrace, "at" | "status" | "executed" | "known">,
  env: NodeJS.ProcessEnv,
) =>
  new TraceView(
    {
      version: TRACE_STORE_VERSION,
      env: "e",
      tests: {
        "test/run.test.ts": { at: "", status: "passed", executed: {}, known: {}, ...trace },
      },
    },
    "e",
    () => "h",
    files,
    env,
  );

describe("trace freshness and the environment", () => {
  it("records the variables the loaded files read, and unknown reads as any", () => {
    expect(traceEnv(["test/run.test.ts", "src/run.ts"], files, {})).toEqual({
      env: { USE_FRESH: "unset" },
    });
    expect(traceEnv(["src/plain.ts"], files, {})).toEqual({});
    expect(traceEnv(["src/any.ts"], files, {})).toEqual({ envAny: true });
    // A loaded file that was not analysed: what it reads is unknown.
    expect(traceEnv(["src/generated.js"], files, {})).toEqual({ envAny: true });
  });

  it("a trace taken with another value of a variable its code reads is not fresh", () => {
    const traced = { fileHashes: { "src/run.ts": "h" }, ...traceEnv(["src/run.ts"], files, {}) };
    expect(view(traced, {}).isFresh("test/run.test.ts")).toBe(true);
    expect(view(traced, { USE_FRESH: "1" }).isFresh("test/run.test.ts")).toBe(false);
    expect(view({ fileHashes: {}, envAny: true }, {}).isFresh("test/run.test.ts")).toBe(false);
  });
});

describe("trace store format", () => {
  /** `tests` test files each loading the same `files` files (the shape that made stores huge). */
  const big = (tests: number, files: number): TraceStore => {
    const store: TraceStore = { version: TRACE_STORE_VERSION, env: "node-26", tests: {} };
    for (let t = 0; t < tests; t++) {
      const fileHashes: Record<string, string> = {};
      const executed: Record<string, string[]> = {};
      const known: Record<string, string[]> = {};
      for (let f = 0; f < files; f++) {
        const path = `src/module-${f}/implementation-${f}.ts`;
        fileHashes[path] = `${"0".repeat(56)}${String(f).padStart(8, "0")}`;
        executed[path] = t % 2 ? ["", `fn${f}`] : [""];
        known[path] = ["", `fn${f}`, `other${f}`];
      }
      store.tests[`test/t${t}.test.ts`] = {
        at: "2026-11-01T00:00:00.000Z",
        status: "passed",
        fileHashes,
        ...(t === 0 ? { env: { MODE: "unset" } } : {}),
        ...(t === 1 ? { envAny: true } : {}),
        executed,
        known,
      };
    }
    return store;
  };

  it("round-trips exactly, written compact with each path, hash and name list once", async () => {
    const store = big(200, 100);
    const text = [...encodeTraces(store)].join("");
    expect(decodeTraces(text)).toEqual(store);
    const pretty = JSON.stringify(store, null, 2).length;
    expect(text.length).toBeLessThan(pretty / 10);
    // Pieces join to the same text, whatever their size.
    const pieces = [...encodeTraces(store, 4096)];
    expect(pieces.length).toBeGreaterThan(10);
    expect(pieces.join("")).toBe(text);
    const dir = await mkdtemp(join(tmpdir(), "st-traces-"));
    try {
      expect(await saveTraces(dir, store)).toBeUndefined();
      expect(await loadTraces(dir)).toEqual(store);
      // Signed like every state file: a changed byte makes the store unreadable, not trusted.
      const path = join(dir, "state", "traces.json");
      await writeFile(path, (await readFile(path, "utf8")).replace('"node-26"', '"node-27"'));
      expect(await loadTraces(dir)).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not read a store of an earlier format, or a damaged entry", () => {
    const old = JSON.stringify({ ...big(1, 1), version: 2 });
    expect(decodeTraces(old)).toBeUndefined();
    const text = [...encodeTraces(big(2, 2))].join("");
    const damaged = JSON.parse(text) as { tests: Record<string, { h: number[] }> };
    (damaged.tests["test/t0.test.ts"] as { h: number[] }).h = [0, 99];
    expect(Object.keys(decodeTraces(JSON.stringify(damaged))?.tests ?? {})).toEqual([
      "test/t1.test.ts",
    ]);
  });

  it("reports a store it cannot save instead of failing, and keeps no stale store", async () => {
    const dir = await mkdtemp(join(tmpdir(), "st-traces-fail-"));
    try {
      expect(await saveTraces(dir, big(2, 2))).toBeUndefined();
      // A store that cannot be encoded (or written) is reported, and the old one removed.
      const broken = big(1, 1);
      (broken.tests as Record<string, unknown>)["test/x.test.ts"] = {
        get at(): string {
          throw new RangeError("Invalid string length");
        },
      };
      const error = await saveTraces(dir, broken);
      expect(error?.message).toMatch(/Invalid string length/);
      expect(await loadTraces(dir)).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
