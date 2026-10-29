/**
 * Worker thread that parses source files (see parse-pool.ts). Receives batches of
 * { path, content } and answers with FileAnalysis objects, in order.
 */
import module from "node:module";
import { parentPort } from "node:worker_threads";
import { javascriptAnalyzer } from "@smarttest/language-javascript";
import { typescriptAnalyzer } from "@smarttest/language-typescript";
import type { FileAnalysis } from "@smarttest/source-parser";

(module as { enableCompileCache?: () => unknown }).enableCompileCache?.();
const analyzers = [typescriptAnalyzer, javascriptAnalyzer];

parentPort?.on("message", (msg: { id: number; jobs: { path: string; content: string }[] }) => {
  const out: (FileAnalysis | null)[] = msg.jobs.map((j) => {
    const a = analyzers.find((x) => x.supports(j.path));
    try {
      return a ? a.analyze(j.path, j.content) : null;
    } catch {
      return null;
    }
  });
  parentPort?.postMessage({ id: msg.id, out });
});
