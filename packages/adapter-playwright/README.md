# @smarttest/adapter-playwright

Playwright Test adapter: discovery, file selection, traces in the report.

Browser coverage (`coverage: "partial"`): on a `--coverage` run the adapter sets `SMARTTEST_BROWSER_COVERAGE_DIR` to an emptied `<coverage dir>/v8`, and `withBrowserCoverage(test)` (published as `smarttest/playwright`) records Chromium's V8 JS coverage of each test's `page` there. Core turns the dumps into line detail with `@smarttest/coverage-engine`'s `ingestBrowserV8`. Chromium only; source maps are not read, so only scripts served byte for byte from project files map to lines. See the [Studio guide](../../documentation/guides/studio.md#browser-coverage-playwright).

Depends on `@smarttest/shared`, `@smarttest/plugin-sdk`.

Part of [SmartTest](../../README.md). See the [architecture overview](../../documentation/architecture/overview.md).
