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

## Annotations on the pull request

On GitHub Actions, GitLab CI and Bitbucket Pipelines, `smarttest ci`, `run` and `impact` show the selection where the change is reviewed. SmartTest detects the CI from `GITHUB_ACTIONS`, `GITLAB_CI` or `BITBUCKET_BUILD_NUMBER`; nothing to configure. Annotations are output formats: SmartTest makes no call to the CI's API.

| CI        | What appears                                                                                                                                                                                                                                                       |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GitHub    | A notice on each selected test file with its reason (the closest reasons first), one notice for the files not run with their reasons and the time saved, an error per failing file, a warning for each fallback. The step summary lists every file and its reason. |
| GitLab    | A Code Quality report, `.smarttest/reports/gl-code-quality.json` (selected files as `info`, failing files as `major`), shown in the merge request widget, and a collapsible "SmartTest selection" section in the job log.                                          |
| Bitbucket | A Code Insights report, `.smarttest/reports/bitbucket-insights.json`: `report` (counts, time saved) and `annotations`. Post it from the pipeline (below).                                                                                                          |

GitHub shows at most 10 annotations of each level per step and drops the rest silently, so SmartTest keeps each level within 10: the last notice says how many more files were selected, and the step summary has them all. GitLab and Bitbucket reports keep 100 entries.

Skipped tests are never shown as passed: they are "not run (skipped by selection)", with the reason. Time saved is an estimate from the durations SmartTest recorded on earlier runs (`.smarttest/state/durations.json`); on a fresh runner there are none and the summary says the time saved is not measured yet. Cache `.smarttest/state/` between pipelines to measure it.

Turn annotations off with `--no-annotations`, or for the project with `reports: { annotations: false }`. `--annotations github|gitlab|bitbucket` forces a provider. With `--json`, stdout stays one JSON document and the annotation lines go to stderr, which GitHub reads too.

GitHub Actions, selection only (nothing runs; useful next to an existing test job):

```yaml
- uses: actions/checkout@v5
  with:
    fetch-depth: 0
- run: npm ci
- run: npx smarttest impact --base "origin/${{ github.base_ref }}"
```

GitLab CI, with the Code Quality report:

```yaml
test:
  script:
    - npm ci
    - npx smarttest ci
  artifacts:
    when: always
    reports:
      junit: .smarttest/reports/junit.xml
      codequality: .smarttest/reports/gl-code-quality.json
```

Bitbucket Pipelines, posting the Code Insights report through the pipeline's authenticated proxy:

```yaml
- step:
    script:
      - npm ci
      - npx smarttest ci || STATUS=$?
      - >-
        curl --proxy http://localhost:29418 -s -X PUT
        "http://api.bitbucket.org/2.0/repositories/$BITBUCKET_REPO_FULL_NAME/commit/$BITBUCKET_COMMIT/reports/smarttest"
        -H "Content-Type: application/json" -d "$(node -p 'JSON.stringify(require(\"./.smarttest/reports/bitbucket-insights.json\").report)')"
      - >-
        curl --proxy http://localhost:29418 -s -X POST
        "http://api.bitbucket.org/2.0/repositories/$BITBUCKET_REPO_FULL_NAME/commit/$BITBUCKET_COMMIT/reports/smarttest/annotations"
        -H "Content-Type: application/json" -d "$(node -p 'JSON.stringify(require(\"./.smarttest/reports/bitbucket-insights.json\").annotations)')"
      - exit ${STATUS:-0}
```

SmartTest's own pull requests run `smarttest impact` this way (the `selection` job of [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml)).

## Live end-to-end specs

A Playwright project whose `baseURL` is a deployed environment (`https://` on a host that is not `localhost`, `127.x`, `::1` or a `webServer` the config starts), or that depends on a setup project that is, runs against shared infrastructure. Its specs are **live**: `run`, `ci`, the commit hooks, `validate-selection`, `benchmark` and `audit --mutate` select them but run them only with `--live`. Until then each is reported as "live, not run", with its projects and the URL it targets, never as passed.

```bash
# CI, where the deployed environment is reachable: run the live specs too
npx smarttest ci --live
```

SmartTest reads the projects through Playwright (`playwright test --list`), so the values are the ones your config computes from the environment. With `E2E_BASE_URL=http://127.0.0.1:5173` and a matching `webServer`, the same specs are local and run everywhere. A spec in both a live and a local project is not live. On openpro-front, whose 25 projects default to `https://dev.openpro.ai`, all 78 Playwright files (specs and setup files) are live.

## Exit codes

| Code | Meaning                                                                          | Usual CI handling      |
| ---- | -------------------------------------------------------------------------------- | ---------------------- |
| 0    | all selected tests passed                                                        | pass                   |
| 1    | a test failed or timed out                                                       | fail                   |
| 2    | invalid command or flag                                                          | fail, fix the pipeline |
| 3    | configuration problem                                                            | fail                   |
| 4    | infrastructure problem (runner missing, Git base not found)                      | fail or retry          |
| 5    | policy failure (`validate-selection`, `shadow` or `benchmark` found a miss)      | fail                   |
| 70   | internal error: a SmartTest bug, such as a report that fails its integrity check | fail, report the bug   |

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
      codequality: .smarttest/reports/gl-code-quality.json
```

## Example: any shell-based CI (Jenkins, Buildkite, Drone…)

```bash
set -e
npm ci
npx smarttest ci
```

## Traces and Shadow Mode in CI

Traces live in `.smarttest/state/traces.json`. To use them on pull requests, cache that file (or the whole `.smarttest/state/` directory) between pipeline runs, keyed on the lockfile. A trace whose loaded files changed is ignored automatically, so a stale cache is harmless.

State that decides what runs is authenticated with a key outside the project: the index, the graph, test discovery, cached passes and traces. By default every runner has its own key, so a restored cache is rebuilt. To reuse it, set the same `SMARTTEST_STATE_KEY` secret (32 characters or more) in the jobs that save and restore the cache. Fork pull requests do not receive secrets, so state they write or restore is never trusted ([security review](../architecture/security-review.md), SR-16). `smarttest shadow` appends to `.smarttest/shadow/history.jsonl`; keep that file as an artifact or in a cache to follow drift with `smarttest shadow --report`.

To check SmartTest against the full suite on your own history before relying on it in CI, run `npx smarttest benchmark --commits 20` locally.
