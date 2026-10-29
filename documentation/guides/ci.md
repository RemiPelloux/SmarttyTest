# Running in CI

SmartTest is a CLI. It works in any CI system that can run Node.js 22.12 or newer. Nothing is specific to one provider.

## Requirements

- Enough Git history to find the merge-base with the target branch. With shallow clones, fetch the base branch, for example `git fetch --depth=200 origin main`.
- Dependencies installed (`npm ci`, `pnpm install --frozen-lockfile`, …) in every project SmartTest runs tests for.
- `--non-interactive`, which is implied when `CI` is set or stdout is not a terminal.

## Commands

`smarttest ci` does the CI-specific work for you: it detects the provider, decides what to compare against (merge-base with the target branch for merge requests, the previous revision for branch builds), deepens shallow clones until that history is there, and writes JUnit and Markdown reports.

```bash
npx smarttest ci
```

The same can be done by hand:

```bash
# merge request / pull request: tests affected by the branch
npx smarttest run --base origin/main --non-interactive --format junit --format html

# main branch or nightly: everything, same pipeline and reports
npx smarttest run --all --non-interactive --format junit --format html

# nightly: refresh traces, then compare the selection with a full run and keep the record
npx smarttest trace --stale --non-interactive
npx smarttest shadow --non-interactive
```

Reports are written to `.smarttest/reports/` (`junit.xml`, `report.html`, `report.json`, `summary.md`). Publish them with your CI's artifact mechanism.

## Exit codes

| Code | Meaning                                                                     | Usual CI handling      |
| ---- | --------------------------------------------------------------------------- | ---------------------- |
| 0    | all selected tests passed                                                   | pass                   |
| 1    | a test failed or timed out                                                  | fail                   |
| 2    | invalid command or flag                                                     | fail, fix the pipeline |
| 3    | configuration problem                                                       | fail                   |
| 4    | infrastructure problem (runner missing, Git base not found)                 | fail or retry          |
| 5    | policy failure (`validate-selection`, `shadow` or `benchmark` found a miss) | fail                   |

## Example: GitLab CI

```yaml
test:
  image: node:24
  script:
    - npm ci
    - npx smarttest ci
  artifacts:
    when: always
    reports:
      junit: .smarttest/reports/junit.xml
```

## Example: any shell-based CI (Jenkins, Buildkite, Drone…)

```bash
set -e
npm ci
npx smarttest ci
```

## Traces and Shadow Mode in CI

Traces live in `.smarttest/state/traces.json`. To use them on pull requests, cache that file (or the whole `.smarttest/state/` directory) between pipeline runs, keyed on the lockfile. A trace whose loaded files changed is ignored automatically, so a stale cache is harmless. `smarttest shadow` appends to `.smarttest/shadow/history.jsonl`; keep that file as an artifact or in a cache to follow drift with `smarttest shadow --report`.

To check SmartTest against the full suite on your own history before relying on it in CI, run `npx smarttest benchmark --commits 20` locally.
