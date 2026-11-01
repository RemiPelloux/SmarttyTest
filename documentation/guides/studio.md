# Studio guide

Studio is a local browser interface for the current project's real SmartTest analysis. Start it through `smarttest studio`, or import `startStudio` from `@smarttest/studio`. Open the exact printed URL, including its session token fragment. Tokens are kept in session storage and removed from the address bar after pairing.

The server defaults to `127.0.0.1:4173`. If that port is occupied it falls back to an OS-assigned ephemeral port. `port: 0` requests an ephemeral port immediately. Use the returned URL rather than assuming a port. Non-loopback bind addresses are refused.

## Screens and actions

- Overview shows changed files, affected units, selected files, uncertainty, fallback reasons and the last recorded run.
- Impact connects changed files and units to selected tests, explains selection reasons, and previews source. Its **Map** view (the switch under the title, or `/impact?view=map`) draws the part of the dependency graph the change reaches: one path per selection reason, from the changed unit (circle) through every unit on the way to the selected test file (square). See [Impact map](#impact-map).
- Tests filters discovered test files by selected, failed, cached, skipped or flaky state; search narrows rows and CSV export uses the current filter (every matching row, even past the 600 rows drawn on screen). Run affected, all tests, or an individual file. A file whose results all came from cache reads "cached, not run"; a run in which every selected test was cached says no test ran.
- Trust shows recorded shadow replays, benchmark totals, cache evidence, flaky history, hook history and coverage when available. Missing benchmark measurements produce an unavailable state, never zero missed failures.
- Source lists indexed files and displays current source, changed lines, units, fresh observed execution evidence and, after a coverage run, observed line and branch coverage. Deleted, unreadable or outside-root symlink targets are unavailable.

A live run drawer receives selection, runner groups, retry, results and final status over SSE. Results arrive as each runner group finishes (one runner process reports its files together); cached results arrive with the summary. If the stream drops, the drawer catches up from the run's record when it reconnects. Only one run can execute in a Studio session; cancellation requests cancellation from the runner, and a cancelled run is shown as cancelled even when the runner stopped cleanly. Integrity issues, cancellation and short execution lists block a passed verdict. A run in which every selected test came from cache has the verdict `cached-pass`, never passed (ADR-0009). A run in which no test passed, because nothing was selected or every test was skipped, has the verdict `no-tests`. Refresh re-reads the last run, so runs from the terminal or a commit hook show up, and coverage and traces are re-read after each Studio run.

## Impact map

The map's filters narrow the view to one change (a changed file, or one of its units), one selected test, one edge kind or one confidence. A path is kept when it starts at the chosen change, ends at the chosen test, uses at least one edge of the chosen kind (those edges are drawn in the accent colour) and has the chosen confidence (the weakest edge on the path, as the CLI reports it). The result count is spoken when a filter changes; Clear filters returns focus to the first filter.

Each hop is named after the graph edge behind it (`IMPORTS`, `CALLS`, `REFERENCES`, `TESTS`, `EXTENDS`…) with that edge's confidence. Two kinds are Studio's own and never hide a hop: `CONTAINS`, when the traversal stepped from a file or class into a unit of the same file, and `UNCLASSIFIED` (drawn dotted, labelled `?`), when the graph stores no single edge between the two nodes. Selection reasons without a graph path get one edge from their evidence (diamond) to the test: a rule, a mandatory trigger, a fallback, an unresolved import, a changed test file, or a fresh trace (drawn from the changed file it ran). Changed units no selected test's path starts from are listed under the drawing, marked when no test protects them.

Everything drawn is also in the table below the drawing, path by path in words, so the map never holds a fact a keyboard or screen-reader user cannot reach. The drawing shows at most 120 paths and the table 300; the server sends at most 600 selection reasons and says so when it cut. Exports always hold the whole filtered view:

- **JSON**: `kind: "smarttest-impact-map"`, the filters, the paths, nodes and edges of the view, and the unreached changed units.
- **SVG**: the drawing on screen, with the current theme's colours written into the file.
- **DOT**: the view for Graphviz (`dot -Tpng smarttest-impact-map.dot`); tests are boxes, evidence diamonds, `UNCLASSIFIED` hops dotted.

`GET /api/impact/map` returns the same model (`StudioImpactMap` in `contracts.ts`).

## Coverage and trace evidence

Coverage percentages come from the persisted runner report and retain `selected` or `full` scope. Selected coverage is not whole-project coverage. Percentages are already 0–100 values.

Fresh traces establish that a test executed a named unit. The Source viewer projects that unit onto its source span (the dot beside the line number); this is **observed unit execution, not measured line or branch coverage**. Missing traces mean never recorded; stale traces mean recorded evidence no longer matches.

### Observed line and branch coverage

A run with coverage (`smarttest run --coverage`, or **Run with coverage** in the Source viewer, which runs the affected tests with coverage on) writes, next to the summary, the line and branch detail of each file the runner measured: `.smarttest/runs/coverage-lines.json`, from the istanbul JSON Vitest and Jest write. A failing test still ran code, so Vitest is asked to report coverage on failure too (Jest does by default). The Source viewer then shows, in a gutter beside each line, how often it ran (`3×`), `0×` for a line that never ran, and `1/2` where only some arms of a branch ran. The same facts are spoken in words for every marked line, and the bar above the code counts the change's own lines: covered, not covered, and holding no statement (blank, comment or type-only lines), plus the branch arms on them that ran.

This is **observed coverage of one run**, labelled with its scope and time: a `selected` run measured only the selected tests and is never presented as project coverage, and a covered line ran at least once without proving a test checked its result. Lines are marked only on the exact file that was measured: each file in the detail carries the sha256 of the text it was measured against, and when the file has changed since, Studio marks nothing and says so (`stale`). A file the run never loaded is `absent`, not uncovered. Runs without coverage leave the last coverage detail in place; its run id and time stay on screen. Coverage marks can be switched off.

### Browser coverage (Playwright)

Playwright Test does not collect coverage by itself, so SmartTest provides a page fixture. Wrap the project's `test` once and import it in the specs:

```ts
// e2e/fixtures.ts
import { test as base } from "@playwright/test";
import { withBrowserCoverage } from "smarttest/playwright";
export const test = withBrowserCoverage(base);
export { expect } from "@playwright/test";
```

On a coverage run SmartTest sets `SMARTTEST_BROWSER_COVERAGE_DIR` for Playwright groups (emptied first); the fixture then starts Chromium's JS coverage on the test's `page` and writes it there when the test ends. After the run, the dumps become `.smarttest/runs/browser-coverage-lines.json`, which the Source viewer offers as **Browser** beside **Runner**. The two are separate measurements and are never merged.

What it does not do, by design or not yet:

- Chromium only: `page.coverage` does not exist in Firefox or WebKit, so the fixture does nothing there. The adapter declares coverage as `partial`.
- Only the fixture's `page` is watched, not pages opened with `context.newPage()`.
- A script is tied to a project file only when its URL resolves to a file inside the project (or Vite's `/@fs/` path) **and** the source the browser ran is byte for byte that file. Bundled, transpiled or minified scripts (Next.js chunks, Vite-transformed TypeScript) are listed as unmapped with the reason: **source maps are not read yet**, so their coverage is not projected onto source lines. Mapping through source maps (V8 offsets to generated positions to original lines) is the missing piece for typical front-end builds.
- V8 has no statement map: lines are read from block ranges (a line's count is that of the innermost range at its first character; blank and comment lines are skipped), and branches are V8 blocks, each counted as one arm.
- Browser coverage has no summary percentage in reports or on Trust.

## Keyboard and themes

`r` runs affected tests; `/` focuses Tests or Source search; `?` opens shortcuts; Escape closes a dialog or run drawer; in a filter field the first Escape clears the filter and the next one leaves the field. `g o`, `g i`, `g t` navigate within a one-second sequence. Shortcuts pause while typing or a dialog is open. Dialog Tab focus loops and Escape returns focus. The shortcuts dialog has a switch that turns the single-key shortcuts (`r`, `?`, `/`, `g`) off for speech input or accidental presses; Escape keeps working. Use the rail theme control; `?theme=light` and `?theme=dark` also choose a persisted theme.

## Accessibility

Studio targets WCAG 2.2 AA in Chromium, Firefox and WebKit, light and dark. Opening the run drawer moves focus to its title; Escape or Close returns focus to the control that opened it. Run progress and the final verdict, a filter's result count and a screen change are spoken through one persistent live region. Changed and traced source lines are announced in words as well as colour, and scrollable code, run and source regions take keyboard focus. Below 860 px the navigation moves to a bottom bar and focus scrolls clear of it; at 320 px wide nothing scrolls sideways.

`pnpm studio:a11y` starts Studio on a temporary git copy of `fixtures/projects/ts-lib-vitest` after one real coverage run of its change, drives every screen (the impact map and the coverage marks included) with Playwright in all three engines and both themes, and runs axe-core (WCAG 2.0 to 2.2 A and AA tags) plus keyboard, focus, live-region, reduced-motion, reflow and target-size checks. It writes `summary.md`, `results.json` and one accessibility tree per state to `--out` (default: the system temp directory) and exits 1 on a failed check. It needs the browsers that match the root `playwright-core` version, launches one browser at a time and is not part of `pnpm verify`. `--browsers`, `--themes` and `--assets=<web dir>` (compare another copy of `web/`) narrow or redirect a run. A real screen reader pass (NVDA with Firefox, VoiceOver with Safari) is still manual.

## Embedding and assets

```ts
import { startStudio } from "@smarttest/studio";
const studio = await startStudio({ root: process.cwd(), port: 4173 });
console.log(studio.url);
// On CLI termination:
await studio.close();
```

Options: `root` required; `configPath`, `port`, `host`, `storeDir`, `assetDir`, `watch` optional. Watch defaults to true. The handle exposes `url`, `port`, `token`, `root`, and idempotent `close()`.

Asset resolution tries explicit `assetDir`, `SMARTTEST_STUDIO_ASSETS`, package-relative web directories, checkout `packages/studio/web`, then installed `node_modules/@smarttest/studio/web`. The CLI bundle must copy `packages/studio/web` to `dist/web`; the release bundle includes these assets.

## Security and operational limits

API calls require `x-smarttest-token`; mutations additionally require a matching browser Origin and JSON. Host, port, Origin and Fetch Metadata checks protect the loopback session. Per-route method allowlists reject mutation through GET. CSP forbids inline scripts and styles; source text is constructed through DOM text nodes. Source reads resolve the root and requested file immediately before reading and reject targets outside the resolved root, including files replaced by symlinks since analysis. This is path containment, not an OS sandbox against a privileged process racing filesystem renames during the check and read.

Reports are served only through a name allowlist. Core normally writes `reports/report.*` and `runs/latest.json`; Studio reads latest.json as a last-run fallback. The `last-run.*` downloads map to the report files written by core; an ungenerated report returns 404. Browser controls use the default run mode and cache settings; coverage is on only for **Run with coverage**; API options support additional choices. Exports are built in the browser and downloaded as files; nothing is written into the project. The impact map is a drawing with filters, not a free-form graph editor (no dragging, zooming or whole-repository graph). There is no source editing, syntax tokenization, or historical-run browser. SSE history is bounded and server-run history is session-local.
