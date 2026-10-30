import { parseArgs } from "node:util";
import { SmartTestError, suggest } from "@smarttest/shared";

export const OPTIONS = {
  // global
  config: { type: "string" },
  json: { type: "boolean" },
  quiet: { type: "boolean", short: "q" },
  verbose: { type: "boolean" },
  "non-interactive": { type: "boolean" },
  "dry-run": { type: "boolean" },
  output: { type: "string", short: "o" },
  mode: { type: "string" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
  yes: { type: "boolean", short: "y" },
  // change sources
  affected: { type: "boolean" },
  all: { type: "boolean" },
  base: { type: "string" },
  "base-mode": { type: "string" },
  target: { type: "string" },
  staged: { type: "boolean" },
  push: { type: "boolean" },
  uncommitted: { type: "boolean" },
  "since-snapshot": { type: "boolean" },
  snapshot: { type: "string" },
  // run
  coverage: { type: "boolean" },
  retries: { type: "string" },
  timeout: { type: "string" },
  workers: { type: "string" },
  format: { type: "string", multiple: true },
  open: { type: "boolean" },
  "fail-on-missed": { type: "boolean" },
  "no-cache": { type: "boolean" },
  shard: { type: "string" },
  bail: { type: "boolean" },
  total: { type: "string" },
  index: { type: "string" },
  "min-rate": { type: "string" },
  // init
  auto: { type: "boolean" },
  advanced: { type: "boolean" },
  rollback: { type: "boolean" },
  layout: { type: "string" },
  // generate
  class: { type: "string" },
  module: { type: "string" },
  path: { type: "string" },
  type: { type: "string" },
  sync: { type: "boolean" },
  // graph
  from: { type: "string" },
  direction: { type: "string" },
  depth: { type: "string" },
  // explain
  fresh: { type: "boolean" },
  units: { type: "string" },
  commits: { type: "string" },
  since: { type: "string" },
  sample: { type: "string" },
  resume: { type: "boolean" },
  traces: { type: "boolean" },
  // trace / shadow
  stale: { type: "boolean" },
  status: { type: "boolean" },
  report: { type: "boolean" },
  check: { type: "boolean" },
  to: { type: "string" },
  dir: { type: "string" },
  fix: { type: "boolean" },
  // studio
  port: { type: "string" },
  // hook
  replace: { type: "boolean" },
  hook: { type: "boolean" },
  "pre-push": { type: "boolean" },
  manager: { type: "string" },
  // snapshot
  keep: { type: "string" },
  force: { type: "boolean" },
  content: { type: "boolean" },
  label: { type: "string" },
} as const;

export type Flags = {
  -readonly [K in keyof typeof OPTIONS]?: (typeof OPTIONS)[K]["type"] extends "boolean"
    ? boolean
    : (typeof OPTIONS)[K] extends { multiple: true }
      ? string[]
      : string;
};

export interface Parsed {
  command?: string | undefined;
  positionals: string[];
  flags: Flags;
}

export function parse(argv: readonly string[]): Parsed {
  try {
    const { values, positionals } = parseArgs({
      args: [...argv],
      options: OPTIONS,
      allowPositionals: true,
      strict: true,
    });
    // `--ai <cmd>` compatibility alias (spec §19.1) is reserved for Release 3.
    return { command: positionals[0], positionals: positionals.slice(1), flags: values as Flags };
  } catch (error) {
    const message = (error as Error).message;
    const unknown = /Unknown option '(--?[\w-]+)'/.exec(message)?.[1];
    const guess = unknown ? suggest(unknown.replace(/^-+/, ""), Object.keys(OPTIONS)) : undefined;
    throw new SmartTestError(message.replace(/\. To specify a positional.*$/s, ""), {
      code: "ST_USAGE",
      category: "usage",
      hint: guess ? `Did you mean --${guess}?` : "Run `smarttest --help`.",
    });
  }
}

export function intFlag(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new SmartTestError(`--${name} must be a non-negative integer`, {
      code: "ST_USAGE",
      category: "usage",
    });
  }
  return n;
}
