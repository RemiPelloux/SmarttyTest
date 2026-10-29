#!/usr/bin/env node
import module from "node:module";

// Cache compiled code on disk (Node 22.1+): loading the TypeScript compiler drops from ~180 ms to
// a few milliseconds after the first run. Opt out with NODE_DISABLE_COMPILE_CACHE=1.
(module as { enableCompileCache?: () => unknown }).enableCompileCache?.();

const { main } = await import("./main.js");
main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`✕ ST_INTERNAL  ${(error as Error).stack ?? String(error)}\n`);
    process.exitCode = 70;
  },
);
