# GitHub Actions

> Implemented in **v0.1.0**. The behaviour on this page is covered by unit and integration tests.

```yaml
# .github/workflows/tests.yml
name: tests
on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0 # SmartTest needs the merge-base with the target branch
      - uses: actions/setup-node@v7
        with:
          node-version: 24
          cache: npm
      - run: npm ci

      - name: Affected tests (PR)
        if: github.event_name == 'pull_request'
        run: npx smarttest run --affected --base origin/${{ github.base_ref }} --mode balanced --non-interactive

      - name: Full suite (main)
        if: github.event_name == 'push'
        run: npx smarttest run --all --non-interactive

      - name: Reports
        if: always()
        uses: actions/upload-artifact@v7
        with:
          name: smarttest-report
          path: .smarttest/reports/
```

- Works for fork PRs because it needs no secrets.
- A Markdown summary is written to `$GITHUB_STEP_SUMMARY` automatically.
- Exit codes: [CLI reference → exit codes](../reference/cli.md#exit-codes).
