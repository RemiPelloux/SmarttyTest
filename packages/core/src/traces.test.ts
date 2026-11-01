import { analyzeSource } from "@smarttest/language-typescript";
import type { FileAnalysis } from "@smarttest/source-parser";
import { describe, expect, it } from "vitest";
import { type TestTrace, TRACE_STORE_VERSION, TraceView, traceEnv } from "./traces.js";

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
