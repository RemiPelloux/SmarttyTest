/**
 * Browser coverage for Playwright Test (Chromium only).
 *
 * Playwright Test does not collect coverage by itself: only a page fixture can start and stop
 * Chromium's JS coverage. `withBrowserCoverage` wraps a project's `test` so its `page` fixture
 * records V8 coverage when SmartTest asks for it (it sets SMARTTEST_BROWSER_COVERAGE_DIR on a
 * `--coverage` run) and does nothing otherwise. SmartTest reads the dumps after the run
 * (`@smarttest/coverage-engine` `ingestBrowserV8`).
 *
 *     // e2e/fixtures.ts
 *     import { test as base } from "@playwright/test";
 *     import { withBrowserCoverage } from "@tkmremi/smarttest/playwright";
 *     export const test = withBrowserCoverage(base);
 *
 * Limits, stated rather than emulated: Chromium only (`page.coverage` does not exist in Firefox
 * or WebKit); only the `page` fixture's page is watched, not pages opened with
 * `context.newPage()`; scripts are tied to project files only when the browser ran the file
 * itself (no bundling, no transform), because source maps are not read.
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const BROWSER_COVERAGE_ENV = "SMARTTEST_BROWSER_COVERAGE_DIR";

interface CoveragePage {
  coverage?: {
    startJSCoverage(options?: {
      resetOnNavigation?: boolean;
      reportAnonymousScripts?: boolean;
    }): Promise<void>;
    stopJSCoverage(): Promise<unknown[]>;
  };
}

interface CoverageTestInfo {
  file?: string;
  testId?: string;
  title?: string;
  retry?: number;
  project?: { name?: string };
}

type PageFixture = (
  args: { page: CoveragePage; browserName?: string },
  use: (page: CoveragePage) => Promise<void>,
  testInfo: CoverageTestInfo,
) => Promise<void>;

/** The part of Playwright's `test` this needs: `extend` with fixtures. */
export interface ExtendableTest<T> {
  extend(fixtures: { page: PageFixture }): T;
}

/** The `page` fixture that records V8 coverage into `dir` when it is set. */
export function coveragePageFixture(dir: () => string | undefined): PageFixture {
  return async ({ page, browserName }, use, testInfo) => {
    const out = dir();
    const on = Boolean(out) && browserName === "chromium" && Boolean(page.coverage);
    if (on) await page.coverage?.startJSCoverage({ resetOnNavigation: false });
    try {
      await use(page);
    } finally {
      if (on && out) {
        const entries = (await page.coverage?.stopJSCoverage()) ?? [];
        const id = createHash("sha256")
          .update(`${testInfo.testId ?? testInfo.title ?? ""}:${testInfo.project?.name ?? ""}`)
          .digest("hex")
          .slice(0, 16);
        await mkdir(out, { recursive: true });
        await writeFile(
          join(out, `${id}-${testInfo.retry ?? 0}.json`),
          JSON.stringify({ testFile: testInfo.file, testId: testInfo.testId, entries }),
        );
      }
    }
  };
}

/** Wraps Playwright's `test` so its `page` records browser coverage on a SmartTest coverage run. */
export function withBrowserCoverage<T>(base: ExtendableTest<T>): T {
  return base.extend({ page: coveragePageFixture(() => process.env[BROWSER_COVERAGE_ENV]) });
}
