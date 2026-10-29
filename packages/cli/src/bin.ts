#!/usr/bin/env node
import { main } from "./main.js";

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`✕ ST_INTERNAL  ${(error as Error).stack ?? String(error)}\n`);
    process.exitCode = 70;
  },
);
