# Studio review evidence and critique

## Current evidence

Screenshots in this directory are real Chromium captures of the shared SmartTest checkout, not invented data. Naming: `{overview,impact,tests,trust,source}-{dark,light}-{1440,768,390}.jpg` (30 captures). `browser-checks.json` records a real heading and no document horizontal overflow for all 30 combinations. These are viewport captures, not proof that every scrolled control was inspected.

`inspector-overview/` contains a fresh design-taste inspector run at all three widths, including full-page captures and report.json. It reports **0 failures, 3 warnings**: 96% of measured text under 13px, a 61px difference between adjacent panel bottoms, and a 42px empty band in Last run. These remain limitations, not a clean design signoff. Earlier fixture inspections reported zero failures on every screen, but those temporary artifacts disappeared and are not claimed as current deliverables.

Viewed screenshots: `overview-dark-1440.jpg` and `source-light-390.jpg`. Desktop hierarchy and fallback warning are readable; status uses restrained color and counts remain prominent. The large checkout produces a dense monospace impact strip with truncated paths and overly strong row outlines. The phone source screen fits the viewport, its fixed bottom navigation remains available, and controls wrap correctly. Its file list consumes most of the first viewport and the selected path wraps awkwardly above source; this needs further visual polish. Remaining captures are supplied for coordinator visual review, not claimed individually critiqued.

The captured checkout has an actual extension test-discovery fallback; Overview exposes it. No last run is present in that screenshot. This is intentional honest data, not a green demo state.

## Keyboard and interaction

Real browser CDP key events verified search focus (`/`), shortcut dialog (`?`), Tab staying inside the dialog, Escape dismissing it, and `g i`, `g t`, `g o` navigation. All seven checks passed. Earlier fixture browser runs verified affected-run completion over SSE, the Failed tab, theme toggle and run drawer widths at 1440/768/390 without horizontal overflow. That earlier harness is no longer available; these checks are recorded observations, not retained artifacts.

Native dialog role is `[role="dialog"]`, not a `<dialog>` element. The earlier query for `dialog[open]` was an invalid test locator, not evidence of a broken shortcut. Added navigation shortcuts and suppressed global shortcuts while dialogs are open.

## Automated security and correctness

Studio tests cover token, Host/port, Origin, method and content-type defenses; source/path boundaries; static assets and CSP; read-model consistency; verdict honesty; last-run fallback; benchmark totals and missing measurements; realpath containment for external and replaced-file symlinks; run id preservation; and SSE shutdown. SSE test now reads until hello across arbitrary TCP chunks and checks concurrent idempotent close with a bounded deadline, avoiding first-chunk assumptions under contention.

Observed execution of a source unit is not line coverage. The guide spells out that distinction. Benchmark totals are read from the real core schema; absent measurements stay unavailable.
