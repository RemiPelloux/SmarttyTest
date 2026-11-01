export interface CommandHelp {
  summary: string;
  usage: string;
  flags?: string[];
  /** Takes the change-source flags (`--base`, `--staged`, `--push`, …), listed after its own. */
  changes?: boolean;
}

/** Change-source flags shared by the commands that analyse a change (see `changes`). */
export const CHANGE_SOURCE_FLAGS = [
  "--base <ref>  compare with merge-base(<ref>, HEAD)",
  "--base-mode direct  compare with <ref> itself, without the merge-base",
  "--target <ref>  with --base: compare up to this revision instead of the working tree",
  "--staged  HEAD → the index (staged content)",
  "--push  committed changes since the upstream merge-base",
  "--uncommitted  HEAD → working tree, untracked files included",
  "--since-snapshot / --snapshot <id>  latest (or given) native snapshot → working tree",
];

/** Other names for a command. */
export const ALIASES: Record<string, string> = { open: "studio" };

/** Commands reserved for a later release; they exit with ST_NOT_AVAILABLE. */
export const LATER: Record<string, string> = {
  ai: "AI features are planned for a later release. SmartTest never requires them.",
  autopilot: "Autopilot is planned for a later release.",
};

export const COMMANDS: Record<string, CommandHelp> = {
  init: {
    summary: "Detect the project, propose an explained setup, preview and apply it",
    usage:
      "smarttest init [--dry-run] [--auto | --advanced | --yes --non-interactive] [--rollback]",
    flags: [
      "--dry-run  show every change, write nothing",
      "--auto  apply low-risk changes only",
      "--advanced  choose layout, adapters and mode",
      "-y, --yes  apply without prompting",
      "--layout mirror|colocated|domain|custom  override the recommended test layout",
      "--mode fast|balanced|safe  override the recommended safety mode",
      "--rollback  undo what init changed",
    ],
  },
  doctor: {
    summary: "Diagnose setup, runners, store and environment",
    usage: "smarttest doctor [--fix] [--json]",
    flags: ["--fix  safe repairs: ignore .smarttest/, remove unreadable state, apply `sync`"],
  },
  scan: {
    summary: "Show what SmartTest understands about the project (read-only)",
    usage: "smarttest scan [--json]",
  },
  impact: {
    summary: "Compute which tests a change affects, without running them",
    usage:
      "smarttest impact [--base <ref> [--target <ref>] | --staged | --push | --uncommitted | --since-snapshot] [--only <path>] [--mode fast|balanced|safe] [--json]",
    flags: [
      "--only <path>  only the changes in this file or directory (repeatable); the dependency analysis still covers the project",
      "--mode fast|balanced|safe  safety mode (default from config, else balanced)",
    ],
    changes: true,
  },
  run: {
    summary: "Run affected tests (default) or the full suite",
    usage:
      "smarttest run [--affected | --all] [--base <ref> | --staged | --push | …] [--only <path>] [--mode m] [--coverage] [--retries n] [--timeout ms] [--workers n] [--format html|json|junit|markdown] [--open] [-o dir]",
    flags: [
      "--affected  analyse changes and run affected tests (default)",
      "--all  full suite through the same pipeline",
      "--hook  commit-hook profile, with --staged or --push: fail-fast, affected-project checks, duration records; not with --shard, --only or --all",
      "--only <path>  only the changes in this file or directory (repeatable); tests other changes affect are not run",
      "--mode fast|balanced|safe  safety mode (default from config, else balanced)",
      "--coverage  collect coverage (scope: selected or full)",
      "--retries n  retry failures; a pass after retry is reported as flaky",
      "--timeout ms  per-runner timeout; unfinished files are reported as timed out",
      "--workers n  passed to the runner as its worker limit",
      "--no-cache  run tests even when a validated cached pass exists",
      "--shard i/n  run shard i of n (balanced by recorded durations)",
      "--bail  stop starting runner groups after one fails",
      "--format f  report format, repeatable: html, json, junit, markdown (default from config)",
      "--open  open the HTML report afterwards",
      "-o, --output <dir>  write the reports to this directory",
    ],
    changes: true,
  },
  explain: {
    summary: "Explain why a test was selected or skipped, or which tests protect a file",
    usage:
      "smarttest explain <test | file | file#Symbol> [--units A,B.method] [--fresh] [--mode m] [--json]",
    flags: [
      "--units A,B  for a source file: also list the tests protecting each named unit (one analysis)",
      "--fresh  analyse the current change instead of reusing the last run's decision (automatic when the change or mode moved)",
      "--mode fast|balanced|safe  safety mode of that analysis",
    ],
    changes: true,
  },
  "validate-selection": {
    summary: "Compare the selection against a full reference run",
    usage: "smarttest validate-selection [--base <ref>] [--mode m] [--json]",
    flags: ["--mode fast|balanced|safe  safety mode of the selection being validated"],
    changes: true,
  },
  benchmark: {
    summary:
      "Replay recent commits: full run vs project-gated run vs SmartTest, with missed failures checked",
    usage:
      "smarttest benchmark [--commits n | --since <ref>] [--sample n] [--resume] [--traces] [--mode m] [--json] [-o file.md]",
    flags: [
      "--commits n  how many recent commits to replay (default 10)",
      "--since <ref>  replay every first-parent commit after <ref>",
      "--sample n  replay at most n of them, evenly spaced",
      "--resume  reuse commits already measured in .smarttest/reports/benchmark.json",
      "--traces  trace the tests at each parent commit so selection uses observed execution",
      "--mode fast|balanced|safe  safety mode of the replayed selections",
      "--no-cache  never reuse cached passes while replaying",
      "-o, --output <file.md>  also write the Markdown report there",
    ],
  },
  shard: {
    summary: "Print the test files of one CI shard, balanced by recorded durations",
    usage: "smarttest shard --total n --index i [--base <ref>] [--all] [--json]",
    flags: [
      "--total n  number of shards",
      "--index i  which shard to print, from 1 to --total",
      "--all  split the full suite instead of the affected tests",
      "the same split is used by `smarttest run --shard i/n`",
    ],
    changes: true,
  },
  flaky: {
    summary: "Tests that pass and fail without code changes, from the recorded runs",
    usage: "smarttest flaky [--min-rate 0.05] [--json]",
    flags: ["--min-rate r  lowest flip rate to report (default 0.05)"],
  },
  studio: {
    summary: "Open the local interface for impact, tests and selection evidence",
    usage: "smarttest studio [--port n] [--open]   (alias: smarttest open)",
    flags: [
      "--port n  preferred loopback port (default: 4173; available port if occupied)",
      "--open  open the session URL in your browser",
    ],
  },
  watch: {
    summary: "Rerun the tests affected by each save",
    usage: "smarttest watch [--mode m]",
    flags: [
      "a save is compared with the previous save of that file (or HEAD the first time)",
      "--mode fast|balanced|safe  safety mode",
    ],
  },
  migrate: {
    summary: "Move a Jest project to Vitest, keeping SmartTest rules and history",
    usage: "smarttest migrate --to vitest [--dir <project>] [--dry-run] [--yes]",
    flags: [
      "rewrites jest.* to vi.*, writes a vitest config with Jest-style globals, updates scripts and adapters",
      "--to vitest  the runner to move to (only vitest)",
      "--dir <project>  only the Jest project in that directory",
      "--dry-run  show every change, write nothing",
      "-y, --yes  apply without prompting",
    ],
  },
  sync: {
    summary: "Update the configuration after the project changed (new runners, packages, Git)",
    usage: "smarttest sync [--check] [--dry-run] [--yes] [--json]",
    flags: [
      "--check  exit 3 when the configuration is out of date (for CI)",
      "--dry-run  show the patch, write nothing",
      "-y, --yes  write the patch without prompting",
    ],
  },
  ci: {
    summary:
      "Run affected tests in any CI: detects the provider, picks the base, deepens shallow clones",
    usage: "smarttest ci [--all] [--mode m] [--format f] [--dry-run] [--json]",
    flags: [
      "merge/pull request: compares with the merge-base of origin/<target branch>",
      "branch build: compares with the previous revision the CI reports, else the parent commit",
      "--base, --staged and --uncommitted are refused: ci picks the base itself (use `smarttest run` to choose one)",
      "--all  run the full suite",
      "--dry-run  print the provider and the base without running tests",
      "the execution flags of `smarttest run` also apply (--coverage, --retries, --timeout, --workers, --shard, --bail, --no-cache, --format, -o)",
    ],
  },
  hook: {
    summary:
      "Install SmartTest in pre-commit or pre-push (husky, lefthook, simple-git-hooks or .git/hooks)",
    usage:
      "smarttest hook install | uninstall | status [--pre-push] [--replace] [--manager m] [--dry-run] [--yes]",
    flags: [
      "--pre-push  install/status/uninstall the pre-push hook (default install: pre-commit)",
      "--replace  comment out existing related/full-suite test steps (uninstall restores them)",
      "--manager m  husky, lefthook, simple-git-hooks or git (default: detected)",
      "--dry-run  show the change, write nothing",
      "-y, --yes  write without prompting",
    ],
  },
  trace: {
    summary: "Record which code each test file runs (V8 coverage, one run per test file)",
    usage: "smarttest trace [files…] [--stale] [--workers n] [--status] [--json]",
    flags: [
      "--stale  only trace tests without a fresh trace",
      "--workers n  test files traced in parallel (default 4)",
      "--status  show how many traces are fresh",
    ],
  },
  shadow: {
    summary: "Run the full suite next to the selection and record drift",
    usage: "smarttest shadow [--base <ref>] [--mode m] [--report] [--json]",
    flags: [
      "exits 5 when the selection missed a failure the full suite found",
      "--report  summarise every recorded Shadow Mode run (exit 5 if any failure was missed)",
      "--mode fast|balanced|safe  safety mode of the selection being compared",
    ],
    changes: true,
  },
  graph: {
    summary: "Query or export the dependency graph",
    usage:
      "smarttest graph [why <dependency> <dependent> | cycles | orphans] [--from <file|file#Symbol>] [--direction dependents|dependencies] [--depth n] [--format json|dot] [-o file]",
    flags: [
      "why <dependency> <dependent>  shortest path by which <dependent> (a file) depends on <dependency> (a file or file#Symbol), e.g. `graph why src/math.ts src/math.test.ts`",
      "cycles  list import cycles",
      "orphans  list source files no test reaches",
      "--from <file|file#Symbol>  start from here (default: export the whole graph)",
      "--direction dependents|dependencies  which way to walk from --from (default dependents)",
      "--depth n  stop after n hops",
      "--format json|dot  export format",
      "-o, --output <file>  write the export to a file",
    ],
  },
  generate: {
    summary: "Generate or sync the test architecture (never overwrites)",
    usage:
      "smarttest generate [--mode scaffold] [--class C | --module m | --path p] [--type unit|integration|e2e] [--sync] [--dry-run]",
    flags: [
      "--mode scaffold  write `it.todo` scaffolds",
      "--class C / --module m / --path p  which source to generate tests for",
      "--type unit|integration|e2e  test category, used in mirror and domain layouts",
      "--sync  report missing tests, orphaned tests and renamed sources (proposes only)",
      "--dry-run  list the files without writing (contents with --verbose)",
    ],
  },
  rules: {
    summary: "Inspect testing rules",
    usage: "smarttest rules list | validate | explain <path[#Symbol]>",
  },
  snapshot: {
    summary: "Native snapshots (change tracking without a VCS)",
    usage:
      "smarttest snapshot create [--content] [--label l] | list | inspect [id] | diff [id] | prune [--keep n] [--force] [--dry-run]",
    flags: [
      "create --content  also store file contents",
      "create --label l  name the snapshot",
      "prune --keep n  how many snapshots to keep (default from config)",
      "prune --force  also prune verified baselines",
      "prune --dry-run  list what would be removed",
    ],
  },
  vcs: {
    summary: "Version-control state",
    usage: "smarttest vcs detect | status | connect <git|native>",
  },
  coverage: {
    summary: "Show the latest ingested coverage with its scope",
    usage: "smarttest coverage [--json]",
  },
  report: {
    summary: "Re-render reports from the last run",
    usage: "smarttest report [--format html|json|junit|markdown] [--open] [-o dir]",
    flags: [
      "--format f  repeatable: html, json, junit, markdown (default from config)",
      "--open  open the HTML report",
      "-o, --output <dir>  write the reports to this directory",
    ],
  },
  uninstall: {
    summary: "Remove SmartTest config, scripts and local state (tests are kept)",
    usage: "smarttest uninstall [--dry-run] [--yes]",
    flags: ["--dry-run  list what would be removed", "-y, --yes  remove without prompting"],
  },
};

export function rootHelp(version: string): string {
  const width = Math.max(...Object.keys(COMMANDS).map((c) => c.length)) + 2;
  return [
    `smarttest ${version} — Understand the change. Test what matters.`,
    "",
    "Usage: smarttest [command] [flags]",
    "       smarttest             interactive menu (in a terminal)",
    "",
    "Commands:",
    ...Object.entries(COMMANDS).map(([name, c]) => `  ${name.padEnd(width)}${c.summary}`),
    ...Object.entries(ALIASES).map(([alias, to]) => `  ${alias.padEnd(width)}alias of ${to}`),
    "",
    "Global flags:",
    "  --config <path>      use a specific config file",
    "  --mode <m>           fast | balanced (default) | safe",
    "  --json               one JSON document on stdout",
    "  -q, --quiet          less output (--verbose: more)",
    "  --non-interactive    never prompt",
    "  --dry-run            show changes, write nothing",
    "  -y, --yes            apply without prompting (init, hook, sync, migrate, uninstall)",
    "  -o, --output <path>  report directory (run, report, ci) or output file (graph, benchmark)",
    "  -h, --help           help for a command (smarttest help <command>)",
    "  -v, --version",
    "",
    "Exit codes: 0 success · 1 test failure · 2 usage · 3 configuration · 4 infrastructure · 5 policy · 70 internal",
    "Docs: https://remipelloux.github.io/SmarttyTest/",
  ].join("\n");
}

export function commandHelp(name: string): string | undefined {
  const later = LATER[name];
  if (later) return `smarttest ${name} — not available yet\n\n${later}`;
  const command = ALIASES[name] ?? name;
  const c = COMMANDS[command];
  if (!c) return undefined;
  return [
    `smarttest ${command} — ${c.summary}`,
    "",
    `Usage: ${c.usage}`,
    ...(c.flags ? ["", "Flags:", ...c.flags.map((f) => `  ${f}`)] : []),
    ...(c.changes ? ["", "Change sources:", ...CHANGE_SOURCE_FLAGS.map((f) => `  ${f}`)] : []),
  ].join("\n");
}
