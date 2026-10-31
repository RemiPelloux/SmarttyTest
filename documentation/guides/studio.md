# Studio guide

Studio is a local browser interface for the current project's real SmartTest analysis. Start it through `smarttest studio`, or import `startStudio` from `@smarttest/studio`. Open the exact printed URL, including its session token fragment. Tokens are kept in session storage and removed from the address bar after pairing.

The server defaults to `127.0.0.1:4173`. If that port is occupied it falls back to an OS-assigned ephemeral port. `port: 0` requests an ephemeral port immediately. Use the returned URL rather than assuming a port. Non-loopback bind addresses are refused.

## Screens and actions

- Overview shows changed files, affected units, selected files, uncertainty, fallback reasons and the last recorded run.
- Impact connects changed files and units to selected tests, explains selection reasons, and previews source.
- Tests filters discovered test files by selected, failed, cached, skipped or flaky state; search narrows rows and CSV export uses the current filter (every matching row, even past the 600 rows drawn on screen). Run affected, all tests, or an individual file. A file whose results all came from cache reads "cached, not run"; a run in which every selected test was cached says no test ran.
- Trust shows recorded shadow replays, benchmark totals, cache evidence, flaky history, hook history and coverage when available. Missing benchmark measurements produce an unavailable state, never zero missed failures.
- Source lists indexed files and displays current source, changed lines, units and fresh observed execution evidence. Deleted, unreadable or outside-root symlink targets are unavailable.

A live run drawer receives selection, runner groups, retry, results and final status over SSE. Results arrive as each runner group finishes (one runner process reports its files together); cached results arrive with the summary. If the stream drops, the drawer catches up from the run's record when it reconnects. Only one run can execute in a Studio session; cancellation requests cancellation from the runner, and a cancelled run is shown as cancelled even when the runner stopped cleanly. Integrity issues, cancellation and short execution lists block a passed verdict. A run in which every selected test came from cache has the verdict `cached-pass`, never passed (ADR-0009). A run in which no test passed, because nothing was selected or every test was skipped, has the verdict `no-tests`. Refresh re-reads the last run, so runs from the terminal or a commit hook show up, and coverage and traces are re-read after each Studio run.

## Coverage and trace evidence

Coverage percentages come from the persisted runner report and retain `selected` or `full` scope. Selected coverage is not whole-project coverage. Percentages are already 0–100 values.

Fresh traces establish that a test executed a named unit. The Source viewer projects that unit onto its source span for highlighting; this is **observed unit execution, not measured line or branch coverage**. Do not claim line-level coverage from those marks. Missing traces mean never recorded; stale traces mean recorded evidence no longer matches. No coverage collection controls or line coverage heatmap are provided by the browser.

## Keyboard and themes

`r` runs affected tests; `/` focuses Tests or Source search; `?` opens shortcuts; Escape closes a dialog or run drawer; in a filter field the first Escape clears the filter and the next one leaves the field. `g o`, `g i`, `g t` navigate within a one-second sequence. Shortcuts pause while typing or a dialog is open. Dialog Tab focus loops and Escape returns focus. The shortcuts dialog has a switch that turns the single-key shortcuts (`r`, `?`, `/`, `g`) off for speech input or accidental presses; Escape keeps working. Use the rail theme control; `?theme=light` and `?theme=dark` also choose a persisted theme.

## Accessibility

Studio targets WCAG 2.2 AA in Chromium, Firefox and WebKit, light and dark. Opening the run drawer moves focus to its title; Escape or Close returns focus to the control that opened it. Run progress and the final verdict, a filter's result count and a screen change are spoken through one persistent live region. Changed and traced source lines are announced in words as well as colour, and scrollable code, run and source regions take keyboard focus. Below 860 px the navigation moves to a bottom bar and focus scrolls clear of it; at 320 px wide nothing scrolls sideways.

`pnpm studio:a11y` starts Studio on a temporary git copy of `fixtures/projects/ts-lib-vitest`, drives every screen with Playwright in all three engines and both themes, and runs axe-core (WCAG 2.0 to 2.2 A and AA tags) plus keyboard, focus, live-region, reduced-motion, reflow and target-size checks. It writes `summary.md`, `results.json` and one accessibility tree per state to `--out` (default: the system temp directory) and exits 1 on a failed check. It needs the browsers that match the root `playwright-core` version, launches one browser at a time and is not part of `pnpm verify`. `--browsers`, `--themes` and `--assets=<web dir>` (compare another copy of `web/`) narrow or redirect a run. A real screen reader pass (NVDA with Firefox, VoiceOver with Safari) is still manual.

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

Reports are served only through a name allowlist. Core normally writes `reports/report.*` and `runs/latest.json`; Studio reads latest.json as a last-run fallback. The `last-run.*` downloads map to the report files written by core; an ungenerated report returns 404. Browser controls currently use default run mode/cache/coverage settings; API options support additional choices. There is no interactive graph canvas, source editing, syntax tokenization, or historical-run browser. SSE history is bounded and server-run history is session-local.
