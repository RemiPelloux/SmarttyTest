export const COMMANDS: Record<string, { summary: string; usage: string; flags?: string[] }> = {
  init: {
    summary: "Detect the project, propose an explained setup, preview and apply it",
    usage:
      "smarttest init [--dry-run] [--auto | --advanced | --yes --non-interactive] [--rollback]",
    flags: [
      "--dry-run  show every change, write nothing",
      "--auto  apply low-risk changes only",
      "--advanced  choose layout, adapters and mode",
      "--yes  apply without prompting",
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
      "smarttest impact [--base <ref> | --staged | --uncommitted | --since-snapshot] [--mode fast|balanced|safe] [--json]",
  },
  run: {
    summary: "Run affected tests (default) or the full suite",
    usage:
      "smarttest run [--affected | --all] [--base <ref>] [--mode m] [--coverage] [--retries n] [--timeout ms] [--format html|json|junit|markdown]",
    flags: [
      "--affected  analyse changes and run affected tests (default)",
      "--all  full suite through the same pipeline",
      "--base <ref>  compare with merge-base(<ref>, HEAD)",
      "--base-mode direct  compare with <ref> directly",
      "--staged  test the Git index; dirty files are set aside in a temporary checkout",
      "--push  test committed changes since the upstream merge-base",
      "--hook  fail-fast hook profile with affected-project checks and duration records",
      "--uncommitted  local Git working-tree changes",
      "--since-snapshot  compare with the latest native snapshot",
      "--coverage  collect coverage (scope: selected or full)",
      "--retries n  retry failures; a pass after retry is reported as flaky",
      "--no-cache  run tests even when a validated cached pass exists",
      "--shard i/n  run shard i of n (balanced by recorded durations)",
      "--bail  stop starting runner groups after one fails",
    ],
  },
  explain: {
    summary: "Explain why a test was selected or skipped, or which tests protect a file",
    usage: "smarttest explain <test | file | file#Symbol> [--fresh] [--json]",
  },
  "validate-selection": {
    summary: "Compare the selection against a full reference run",
    usage: "smarttest validate-selection [--base <ref>] [--mode m] [--json]",
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
      "-o file.md  also write the Markdown report there",
    ],
  },
  shard: {
    summary: "Print the test files of one CI shard, balanced by recorded durations",
    usage: "smarttest shard --total n --index i [--base <ref>] [--all] [--json]",
    flags: ["the same split is used by `smarttest run --shard i/n`"],
  },
  flaky: {
    summary: "Tests that pass and fail without code changes, from the recorded runs",
    usage: "smarttest flaky [--min-rate 0.05] [--json]",
  },
  studio: {
    summary: "Open the local interface for impact, tests and selection evidence",
    usage: "smarttest studio [--port n] [--open]",
    flags: [
      "--port n  preferred loopback port (default: 4173; available port if occupied)",
      "--open  open the session URL in your browser",
    ],
  },
  watch: {
    summary: "Rerun the tests affected by each save",
    usage: "smarttest watch [--mode m]",
    flags: ["a save is compared with the previous save of that file (or HEAD the first time)"],
  },
  migrate: {
    summary: "Move a Jest project to Vitest, keeping SmartTest rules and history",
    usage: "smarttest migrate --to vitest [--dir <project>] [--dry-run] [--yes]",
    flags: [
      "rewrites jest.* to vi.*, writes a vitest config with Jest-style globals, updates scripts and adapters",
      "--dir <project>  only the Jest project in that directory",
    ],
  },
  sync: {
    summary: "Update the configuration after the project changed (new runners, packages, Git)",
    usage: "smarttest sync [--check] [--dry-run] [--yes] [--json]",
    flags: ["--check  exit 3 when the configuration is out of date (for CI)"],
  },
  ci: {
    summary:
      "Run affected tests in any CI: detects the provider, picks the base, deepens shallow clones",
    usage: "smarttest ci [--all] [--mode m] [--format f] [--dry-run] [--json]",
    flags: [
      "merge/pull request: compares with the merge-base of origin/<target branch>",
      "branch build: compares with the previous revision the CI reports, else the parent commit",
      "--dry-run  print the provider and the base without running tests",
    ],
  },
  hook: {
    summary:
      "Install SmartTest in pre-commit or pre-push (husky, lefthook, simple-git-hooks or .git/hooks)",
    usage:
      "smarttest hook install | uninstall | status [--replace] [--manager m] [--dry-run] [--yes]",
    flags: [
      "--pre-push  install/status/uninstall the pre-push hook (default install: pre-commit)",
      "--replace  comment out existing related/full-suite test steps (uninstall restores them)",
      "--manager m  husky, lefthook, simple-git-hooks or git (default: detected)",
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
      "--report  summarise every recorded Shadow Mode run (exit 1 if any failure was missed)",
    ],
  },
  graph: {
    summary: "Query or export the dependency graph",
    usage:
      "smarttest graph [why <from> <to> | cycles | orphans] [--from <file|file#Symbol>] [--direction dependents|dependencies] [--depth n] [--format json|dot] [-o file]",
  },
  generate: {
    summary: "Generate or sync the test architecture (never overwrites)",
    usage:
      "smarttest generate [--mode scaffold] [--class C | --module m | --path p] [--type unit|integration|e2e] [--sync] [--dry-run]",
  },
  rules: {
    summary: "Inspect testing rules",
    usage: "smarttest rules list | validate | explain <path[#Symbol]>",
  },
  snapshot: {
    summary: "Native snapshots (change tracking without a VCS)",
    usage:
      "smarttest snapshot create [--content] [--label l] | list | inspect [id] | diff [id] | prune [--keep n] [--force] [--dry-run]",
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
  },
  uninstall: {
    summary: "Remove SmartTest config, scripts and local state (tests are kept)",
    usage: "smarttest uninstall [--dry-run] [--yes]",
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
    "",
    "Global flags:",
    "  --config <path>      use a specific config file",
    "  --mode <m>           fast | balanced (default) | safe",
    "  --json               one JSON document on stdout",
    "  --quiet / --verbose  less / more output",
    "  --non-interactive    never prompt",
    "  --dry-run            show changes, write nothing",
    "  -h, --help           help for a command (smarttest help <command>)",
    "  -v, --version",
    "",
    "Exit codes: 0 success · 1 test failure · 2 usage · 3 configuration · 4 infrastructure · 5 policy · 70 internal",
    "Docs: https://github.com/RemiPelloux/SmarttyTest/tree/main/documentation",
  ].join("\n");
}

export function commandHelp(name: string): string | undefined {
  const c = COMMANDS[name];
  if (!c) return undefined;
  return [
    `smarttest ${name} — ${c.summary}`,
    "",
    `Usage: ${c.usage}`,
    ...(c.flags ? ["", "Flags:", ...c.flags.map((f) => `  ${f}`)] : []),
  ].join("\n");
}
