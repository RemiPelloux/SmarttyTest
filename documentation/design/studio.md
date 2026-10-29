# SmartTest Studio: design brief

Studio (roadmap 0.9.0) is the screen developers keep open next to their editor while they work. It has to be as good to look at and to use as the documentation site, and better to work in than the CLI. This brief fixes the design direction before any code, so the build starts from decisions, not from a dashboard template.

Studio is built with the frontend design skill's app-screen run (`design-taste-frontend`, `references/app-screens.md`): data and jobs first, one question per screen, a dealt style, a chosen face, real data, then the inspector and screenshot critique until it passes. The steps and the gate are at the end of this page.

## Who uses it, and how

- A developer with SmartTest installed in a repository, on a laptop or a large screen, Studio in a browser tab beside the editor for hours at a time, glanced at after each save or before each push.
- A tech lead opening it to see whether the test selection can be trusted on their repository (missed failures, cache integrity, flaky tests).
- Dark by default (long sessions, next to a dark editor); a light theme from the same tokens.

## Data it shows, with real magnitudes

| Object    | Fields                                                                                                                       | Magnitudes (from LeadsIt and the benchmark repositories)                     |
| --------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Change    | files, changed units (`TokenManager.verify`), kind (implementation, signature…), source (staged, branch, commit range)       | 1–30 files, 1–60 units per change; lockfile changes select everything        |
| Test file | path, runner (Jest, Vitest, `node --test`, Playwright, Cypress), status, duration, reasons, path from the change, confidence | 7 to 2,085 test files; 0 to 300 selected per change, median 3 to 4           |
| Run       | selected, passed, failed, flaky, cached (not run), skipped (not run), duration, runner groups                                | full suites 5 s to 2.5 min; selected runs 0.5 to 10 s; cached runs about 1 s |
| Trace     | collected at, fresh or stale, files loaded                                                                                   | 100 test files traced in about 23 s                                          |
| History   | per test: last 30 results, flake rate                                                                                        | most tests `PPPP…`; a few flip                                               |
| Benchmark | commits replayed, full vs SmartTest time, missed failures, cache violations                                                  | 12 to 40 commits; misses must read 0                                         |

All figures on screen come from the CLI's own `--json` outputs (`impact`, `explain`, `run`, `benchmark`, `trace --status`, `flaky`), never from mock numbers. A total is computed from the rows it sums.

## Jobs

1. **Run the affected tests** for the current change (most frequent: one click from every screen, and a keyboard shortcut).
2. Ask **why** a test was selected or skipped, and see the path.
3. Open a file or symbol in the editor.
4. Re-run one test file, all tests, or without the cache.
5. Refresh stale traces; look at flaky tests and copy the suggested rule.

## Screens and the question each answers first

| Screen                                          | Its one question                                     | Lead block                                                                                     |
| ----------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Overview                                        | "What does my change reach, and is it safe to push?" | The impact strip (below) with the selected count, the run button and the last result           |
| Impact (detail of one test or one changed unit) | "Why does this test run (or not)?"                   | The path, node by node, with each edge's kind and confidence, and the code of the changed unit |
| Tests (list)                                    | "Which tests ran, failed, were cached or skipped?"   | Underline tabs (Selected, Failed, Cached, Skipped, Flaky) over one table                       |
| Runs and trust (analytics)                      | "Can I trust the selection on this repository?"      | Missed failures and cache violations over the replayed commits, time saved, flaky tests        |

## Direction dealt

Dealt with `draw.mjs --app --kind devtools --theme dark --keep palette,type`, style **data-terminal** (seed 1215636468): a screen read in long sessions, surfaces separated by tone, tabular figures that stack, signs instead of colour, and every selection marked by the same 1px accent line, exactly as wide as its label. Chosen over true-black-flat because Studio is used for hours beside an editor and is mostly lists, paths and numbers.

| Decision          | Value                                                                                                                                                                                                                                                                                         |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Palette           | The SmartTest tokens ([design system](design-system.md)): navy ground `#070b18`, surfaces one tone step up, cyan `#22d3ee` only as the 1px selection line and focus ring. Status colours (pass, fail, warn, skip, cached) only on test status, never on chrome. Colour under 3% of the screen |
| Face              | Every path, symbol, count and duration in the monospace face (the CLI's identity, digits that stack); text in the system sans. The SmartTest mark at the top of the rail                                                                                                                      |
| Shell             | An icon rail (about 55px) with tooltips and accessible names; a bottom bar on a phone                                                                                                                                                                                                         |
| Signature element | **The impact strip**: changed units on the left, the tests they reach on the right, one line per path through the graph, cached tests in their own mark, skipped tests faint. It is the product's own picture, the same idea as the live panel on the documentation site's first screen       |
| Motion            | The impact sequence from [motion](motion.md): when a save recomputes the impact, the changed node pulses, the paths draw toward the tests, rows enter staggered; reduced-motion users get the end state                                                                                       |

## Quality bar (part of the 0.9.0 gate)

- `lint.mjs` and `inspect.mjs --app` from the skill: 0 FAIL at 1440, 768 and 390 pixels; every WARN fixed or defended in the release notes.
- Screenshot critique with the skill's rubric, up to three rounds, recorded with the release.
- Every block the screen's question needs is visible at 1440×900 without scrolling; the run button is one click away everywhere.
- Real states: empty (no change), zero (a change that reaches no test), loading (analysis and runs stream in), error (runner missing, base ref not found) — each with its own words, never a blank panel.
- WCAG 2.2 AA contrast in both themes; full keyboard use in reading order; visible focus; `prefers-reduced-motion` respected.
- Cached results always read "cached, not run" and skipped tests "not run", exactly as in the CLI and reports.
- Local only: bound to loopback, session token, origin checks (risk R8).

## The VS Code extension

The extension follows VS Code's own theme and controls (CodeLens above functions: "protected by 3 tests", hover explanations, a status bar item for the current change). Its wording and statuses are the same as Studio's.
