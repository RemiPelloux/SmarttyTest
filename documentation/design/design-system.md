# Design system

One visual language for the README, the docs, the HTML report (1.0) and SmartTest Studio (Release 4). Tokens are defined once and mirrored in [`scripts/brand/build-readme-assets.mjs`](../../scripts/brand/build-readme-assets.mjs). The HTML report (ST-086) reads the same values as CSS custom properties.

<p align="center"><img src="../assets/logo.svg" width="72" alt="SmartTest logo"></p>

## Brand idea

**"A check mark drawn as a dependency graph."** SmartTest's value is the link between a change and the tests that protect it. The logo, the hero and the impact map all show that link: the edge lights up, then the test turns green.

## Color tokens

### Surface (dark-first)

| Token        | Hex       | Use                        |
| ------------ | --------- | -------------------------- |
| `--st-bg-0`  | `#070B18` | Page background, terminal  |
| `--st-bg-1`  | `#0E1530` | Gradient end, raised areas |
| `--st-panel` | `#111A38` | Cards, nodes               |
| `--st-line`  | `#22305C` | Borders, idle edges        |
| `--st-text`  | `#E8ECF8` | Primary text               |
| `--st-muted` | `#8C97BD` | Secondary text             |
| `--st-dim`   | `#56618A` | Tertiary text, idle nodes  |

### Brand

| Token          | Hex                 | Use                                                |
| -------------- | ------------------- | -------------------------------------------------- |
| `--st-cyan`    | `#22D3EE`           | Primary accent, focus rings, prompts               |
| `--st-violet`  | `#8B5CF6`           | Secondary accent, "affected"                       |
| Brand gradient | cyan → violet, 135° | Logo, headline emphasis. **Never** used for status |

### Status (semantic, never decorative)

| Status              | Token         | Hex       | Shape cue (color is never the only signal)          |
| ------------------- | ------------- | --------- | --------------------------------------------------- |
| Modified / changed  | `--st-warn`   | `#FBBF24` | ● filled circle + "MODIFIED" label                  |
| Affected (non-test) | `--st-violet` | `#8B5CF6` | ● + "AFFECTED"                                      |
| Selected / passed   | `--st-pass`   | `#34D399` | ■ square + ✓                                        |
| Failed              | `--st-fail`   | `#FB7185` | ■ + ✕                                               |
| Flaky               | `--st-warn`   | `#FBBF24` | ■ + ↻                                               |
| Skipped (not run)   | `--st-skip`   | `#3A4567` | dashed outline + "not run"                          |
| Cached              | `--st-cyan`   | `#22D3EE` | ■ + ⧉ "cached" badge, never shown as plain "passed" |

In the graph, **circles are source symbols and squares are tests.**

### Light theme (report & Studio)

| Token        | Dark      | Light     |
| ------------ | --------- | --------- |
| `--st-bg-0`  | `#070B18` | `#FFFFFF` |
| `--st-panel` | `#111A38` | `#F5F7FC` |
| `--st-line`  | `#22305C` | `#D9DFEE` |
| `--st-text`  | `#E8ECF8` | `#0B1020` |
| `--st-muted` | `#8C97BD` | `#4A5578` |
| `--st-pass`  | `#34D399` | `#047857` |
| `--st-fail`  | `#FB7185` | `#BE123C` |
| `--st-warn`  | `#FBBF24` | `#B45309` |

All text and status pairs must meet **WCAG 2.2 AA** contrast (4.5:1 for text, 3:1 for UI glyphs) in both themes.

## Typography

| Role             | Stack                                                                                   | Size / weight                       |
| ---------------- | --------------------------------------------------------------------------------------- | ----------------------------------- |
| Display          | `ui-sans-serif, -apple-system, "Segoe UI", Inter, Roboto, Helvetica, Arial, sans-serif` | 54/800, tracking −1.5               |
| Heading          | same                                                                                    | 30/700, tracking −0.5               |
| Body             | same                                                                                    | 15–16/400                           |
| Code, paths, IDs | `ui-monospace, SFMono-Regular, "JetBrains Mono", Menlo, Consolas, monospace`            | 13–15/400                           |
| Labels           | mono                                                                                    | 10.5–12, tracking +1.2–2, UPPERCASE |

System stacks only. No web fonts in assets, so nothing loads over the network and nothing can be tracked.

## Spacing & shape

- 4 px base grid. Common steps: 4, 8, 12, 16, 24, 32, 48, 72.
- Radii: 4 (test squares), 12 (cards), 14–16 (panels), 24 (hero frame).
- Background grid: 32 px at 4.5 % white. Purely decorative.

## CLI style guide

| Element      | Style                                                                             |
| ------------ | --------------------------------------------------------------------------------- |
| Phase line   | `◇ Changes   git · main…HEAD · 3 files` (cyan diamond, muted label, padded to 10) |
| Section pill | inverse label: `SELECTED` (pass bg), `SKIPPED` (skip bg), `FAILED` (fail bg)      |
| Result line  | `✓` / `✕` / `↻` + path + right-aligned counts and duration                        |
| Summary      | one line: `✓ 12 passed · 0 failed · 474 skipped (not run) · 2.1 s`                |
| Next step    | `↳ why these tests? smarttest explain`                                            |
| Separators   | `·` (middle dot), never pipes                                                     |
| Errors       | `✕ ST_CONFIG_INVALID  message` + indented `hint:` + docs link                     |

The wording rule is that **"skipped" is always followed by "(not run)"** in human output.
