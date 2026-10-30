# Studio review evidence and critique

## Current evidence (2026-10-30)

All captures are real Chromium renders (system Chromium through Playwright 1.56.1) of a throwaway project: the `edges-vitest` fixture copied to a temp directory, `git init`, five staged changes including a rename (`src/stats.ts` to `src/statistics.ts`), plus 640 generated bulk test files so the 600-row caps on Tests and Source are exercised. No number on screen was edited or invented. The run in the evidence mixes one executed file with two cached ones.

- `{overview,impact,tests,trust,source}-{dark,light}-{1440,768,390}.jpg`: 30 viewport captures, taken after a run exists.
- `run-drawer-dark-1440.jpg`: the drawer after a live affected run streamed over SSE (1 passed, 2 cached, not run).
- `browser-checks.json`: per screen/theme/width, the h1, document overflow (none) and console errors (none, so no CSP violations), plus the 45 interaction checks below, all passing.
- `inspector-overview/`: the design-taste inspector (`inspect.mjs --app`) on Overview at 1440/768/390: **0 FAIL, 0 WARN** (it was 0 FAIL, 3 WARN). The session token in its URL is redacted.

Run on the other screens (outputs not kept): Tests and Trust 0/0. Impact 0 FAIL, 1 WARN `ragged-row`: the changed-files column and the detail end at different heights, which depends on how many files and reasons there are. Source 0 FAIL, 1 WARN `unused-canvas`: a 5-line file leaves the code area mostly empty. Both are defended as master-detail and content-length effects, not layout bugs. The Impeccable detector flags the two indeterminate 1px progress lines as "marquee". They are loading indicators, they hide no content and they stop under reduced motion.

## Bugs found in the browser and fixed

1. **CSP blocked every inline `style` attribute** (`style-src 'self'`): 1,800+ console errors on Tests. The broken layouts it caused: the toolbar and search field, a 4-column squeeze of the Evidence facts (truncated labels), the rail mark drawn as a white UA button, the shortcut list, the run drawer spacing. All inline styles are now classes.
2. **Back/Forward did nothing**: `popstate` was registered on `document` and never fired. It is now on `window`.
3. **Every render dropped focus and scroll**: arrow keys on the Tests tabs focused a detached node; picking a Source file reset the list to the top; streamed results reset the drawer. Focus is restored by id/`data-search`/`data-fk`, and `data-scroll` regions keep the position recorded on scroll.
4. **Escape in a search field** cleared the field natively but left the filter applied, and a later render brought the text back. The first Escape now clears the filter, the second leaves the field.
5. **A background reload jumped Source back** to the file in `?path=`. Picking a file now updates the URL.
6. **Unit lines off by one**: symbol ranges are zero-based, so unit rules and "Units in this file" sat one line early. Fixed in `snapshot.ts`, with a server test.
7. **Honesty**:
   - Trust showed "0 missed failures across 0 shadow runs" and "0% time saved" when nothing had been replayed. It now reads unmeasured.
   - Hook median/slowest showed "<1 ms" with zero runs.
   - The drawer printed the raw token `cached-pass`, and called a zero-test file "cached".
   - An all-cached run read "passed". Overview now shows "cached, not run" and the drawer says no test ran.
   - "selected" used the pass colour.
   - Impact said "covered" for "has a protecting test".
   - Plural bugs: "resultss", "not runs", "1 marked lines".
8. **Row animations replayed on every render**, including while typing. They now replay only when new data arrives, and reduced motion also removes the stagger delay.

## UX changes

- **Type**: base sizes raised (mono meta 12 to 13px, panel titles 14px, code 13px); inputs are 16px on phones. The inspector no longer flags small text.
- **Impact strip**:
  - The UA button borders that drew heavy row outlines are gone.
  - The unit name leads; paths are split into a muted directory and a readable basename.
  - The test node never truncates first; "*" reads "whole file".
- **Overview**: Last run and Evidence share a bottom edge (no empty band).
- **Impact**:
  - Shows "renamed from …".
  - "Not run, by reason" moved beside the file list, so the screen fits in 1440×900.
  - On phones the selected file's detail comes first.
- **Tests**: "600 of 657 shown"; "no result" instead of a second "not run"; paths wrap at slashes; rows are no longer extra tab stops (the file button is the keyboard path); Selection is hidden on phones.
- **Source**:
  - Phone list capped at about four rows.
  - The header shows the basename over the directory and wraps cleanly.
  - Empty and error states for filters and unreadable files.
  - The legend is corrected (a rule, not a dot, marks a unit start).
- **A11y**:
  - 2px focus ring.
  - Input borders at 3:1 or more.
  - Dark `--st-dim` raised to 4.8:1 on raised surfaces; light warn/skip at 4.5:1 or more.
  - 36–40px touch targets on coarse pointers.

## Interaction checks (all passed, `browser-checks.json`)

- **Tests**:
  - Filter typing keeps focus and caret, and the "shown" count and tab counts update.
  - 600-row cap and its note.
  - Arrow-key tabs.
  - Row click, and Enter on the file button, open Source.
- **Source**:
  - The renamed file highlights only line 2; the modified file only line 3.
  - The file list keeps its scroll and focus after a pick.
- **Shortcuts**:
  - `/` focuses search.
  - `?` opens the dialog; Tab stays inside it and Escape closes it.
  - `g i`, `g t`, `g o` navigate.
- **Theme**: toggle both ways.
- **Runs**:
  - `r` starts a live affected run that streams to completion over SSE, with 5 screen re-renders for the whole run.
  - Escape closes the drawer.
  - The row Run button runs one file.

## What remains open

- Resolved after this review: the server verdict contract now returns `cached-pass` for a run in which every selected test came from cache (ADR-0009; `verdict.test.ts`). The captures above predate that change; the wording on screen is the same.
- Not checked: screen-reader output (only names and roles in the DOM), Firefox/WebKit, and real data at OpenPro scale. The fixture has no traces, flaky history, benchmark or coverage, so those filled states were not rendered.
- The Source viewer has no syntax colouring and long lines scroll sideways. Tabs on phones scroll horizontally with an edge fade.
- The full WCAG 2.2 AA audit and the screenshot-critique rounds from the design brief are not complete; this pass covered contrast tokens, focus and keyboard paths.
