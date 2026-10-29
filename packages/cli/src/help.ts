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
    usage: "smarttest doctor [--json]",
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
      "--staged / --uncommitted  local Git changes",
      "--since-snapshot  compare with the latest native snapshot",
      "--coverage  collect coverage (scope: selected or full)",
      "--retries n  retry failures; a pass after retry is reported as flaky",
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
  graph: {
    summary: "Query or export the dependency graph",
    usage:
      "smarttest graph [--from <file|file#Symbol>] [--direction dependents|dependencies] [--depth n] [--format json|dot] [-o file]",
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
