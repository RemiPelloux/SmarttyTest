# Benchmarks for 1.2.0: OpenPro's JavaScript repositories

S31 left one item undone: OpenPro's four JavaScript repositories in the published benchmarks. They were replayed on 5 November 2026 with `smarttest benchmark`, using the CLI built from `main` at `904ec2f` (1.1.1 plus the branch-push fix), packed with `pnpm bundle:cli` and installed from the tarball. Method as in [1.0.0](benchmarks-1.0.md): fresh clones (`git clone --no-hardlinks`), `node_modules` copied from the working copies, each repository's committed SmartTest configuration, the hook's runners (`hook.runners`), Vitest with an 8 GB heap, one benchmark at a time behind the machine-wide lock. Raw results: [`benchmarks/releases/1.2.0/`](../../benchmarks/releases/1.2.0/).

## Result: 0 missed failures on all four

| Repository          | Test files | Commits | Full runs   | SmartTest  | Saved | Test files run | Full-suite fallbacks | Missed | Already failing |
| ------------------- | ---------- | ------- | ----------- | ---------- | ----- | -------------- | -------------------- | ------ | --------------- |
| openpro-front       | 2,323      | 8       | 20 min 29 s | 5 min 5 s  | 75%   | 2,353 / 18,553 | 0                    | 0      | 1               |
| openpro-admin       | 215–222    | 12      | 3 min 33 s  | 1 min 51 s | 48%   | 991 / 2,604    | 3                    | 0      | 0               |
| openpro-mcp-service | 16–20      | 12      | 72.8 s      | 60.9 s     | 16%   | 145 / 206      | 6                    | 0      | 11              |
| OpenProMonitor      | 7–19       | 12      | 14.3 s      | 9.4 s      | 34%   | 65 / 157       | 5                    | 0      | 0               |

"Full-suite fallbacks" are commits where a mandatory trigger (a lockfile, `package.json`, a runner config) ran everything. "Test files run" counts test-file runs summed over the replayed commits. One test file in openpro-front and one in openpro-admin failed once under load and passed on rerun (`loadFlaky`), not counted as missed.

## Per repository

- **openpro-front**: six ordinary commits select 124–130 of 2,323 test files and take about 20 s instead of 150 s. The two commits that touched the translation sources (`595ca29c`, `b13ecc26`, the « Candidatures par SMS » fix) select about 800 files, since every component that reads those keys is a candidate: 90 s instead of 150 s.
- **openpro-admin**: three dependency commits run everything; the others select 1–40 files.
- **openpro-mcp-service** and **OpenProMonitor**: small suites (6.6 s and under 2 s for everything), and half the window is dependency or configuration commits, so the saving is small. The 11 "already failing" results in openpro-mcp-service fail on the parent commit too.

Previous: [1.0.0 benchmarks](benchmarks-1.0.md).
