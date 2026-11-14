# M6.5 Factory Analytics: accessibility

Status: on `feature/mach-next-m6-5-factory-analytics`, 2026-11-14. This says what the Analytics
workspace supports for keyboard and screen-reader use, what the automated audit checks and found, and the
gaps that remain. It is WCAG 2.2 AA-oriented validation, done with automated checks (axe-core 4 through
Playwright, and the workspace's own audit script) plus scripted keyboard walks in Chromium. It is not a
conformance claim: no assistive-technology user has tested it, and no manual screen-reader session (VoiceOver,
NVDA, JAWS) was recorded.

Code: `web/apps/control-tower/src/analytics/ui/kit.tsx` (chart frame, marks, readouts, drawer focus helper,
announcements), `ui/charts/index.tsx` and `ui/charts/Flow.tsx` (the charts), `ui/charts/a11y.ts` (spoken
words and contrast arithmetic), `ui/areas/RefList.tsx` (the Rows drawer), `ui/analytics.css` (colours,
focus rings). Tests: `test/analytics-a11y.test.mjs`. Audit: `scripts/analytics-audit.mjs`
(`M6_5_TESTING.md` says how to run it).

## 1. Keyboard map

### The workspace

| Where | Keys | Action |
|---|---|---|
| Anywhere | Tab, Shift+Tab | Filters (period radios, Risk, App type), then the area list, then the sheet, in reading order |
| Period | Arrow keys are not used: each preset is its own button with `role="radio"` and `aria-checked` | |
| Area list | Tab to an area, Enter or Space | Open it; the current area has `aria-current="page"` |
| A readout | Tab to the ⓘ button, Enter | Opens the catalog definition (a Radix popover); Escape closes it and focus returns to the button |
| A figure word in a sentence | Tab, Enter | The same definition; the button's name is the visible figure followed by what it is |
| Rows (under a readout) | Enter | Opens the Rows drawer, focus moves into it |

The Shell's global keys (`src/shell/keyboard.ts`, documented in `M6_3_ACCESSIBILITY.md`) still apply; a
chart that handles a key (arrows, Home, End, Escape, Enter, Space) marks it handled, so the global map
skips it.

### A chart

Every chart is one Tab stop. Within it:

| Keys | Action |
|---|---|
| Tab | Into the chart: focus lands on its active mark (the first, or the last one visited) |
| Right / Down, Left / Up | Next / previous mark (bars, columns, segments, stations, dots in reading order) |
| Home, End | First / last mark |
| PageDown, PageUp | Seven marks on / back (long series) |
| Enter or Space | Activate the mark when it does something: select a station, a model or an ending; open a ticket in the Timeline; open Flow or Reliability from Pulse |
| Escape | Leave the chart: focus goes to its Table button (the next Tab goes on through the page) |
| Shift+Left / Shift+Right (trend columns) | Choose a run of periods; Enter sets the window to them, Escape cancels; the two handles then take the arrows |

The Table button beside each chart title swaps the drawing for a data table and back (`aria-pressed`).

Where a chart has no mark that takes focus (the T1 columns on Pulse sit above the T2 columns they share a
card with), the chart's values are in the focusable sibling's names and in the table.

### The Rows drawer

| Keys | Action |
|---|---|
| Tab, Shift+Tab | Cycle through the drawer's controls only; focus does not leave while it is open |
| Escape (focus in the drawer) | Close; focus returns to the control that opened it |
| Close the rows | The same |

Escape pressed in a chart or a popover is theirs: it never also closes the drawer.

## 2. Screen readers

- **Charts** are `figure` elements named by their title, described by a written summary
  (`aria-describedby`, read after the name), each with a table alternative one button away.
- **Marks** are `role="button"` when they do something, else `role="img"`, with roving `tabindex`. A mark's
  name carries its exact values and begins with its visible label (e.g. "Build 27 minutes median, 114
  visits: …"). The mark's drawn words sit outside the control, hidden from assistive technology, so nothing
  is read twice and nothing visible is missing from the name (WCAG 2.5.3). Selection is `aria-pressed`.
- **Numbers read as words**: names and summaries pass through `spoken()` (`ui/charts/a11y.ts`):
  "1 h 48 min" is read "1 hour 48 minutes", "67%" "67 percent", "8.55 M" "8.55 million",
  "< $0.01" "less than $0.01", a lone "–" "no value". Shares that need a count say both
  ("67 percent, 53 of 79", `spokenShare`). Visible text is unchanged.
- **Announcements**: choosing a station (Flow), an ending (Reliability) or two cohorts (Compare) is announced
  once, politely, through `Announce` (`kit.tsx`): the words are taken when the selection changes and held,
  so a data refresh under the same selection says nothing. Loading, a stale result and an error each have one
  status or alert line. The focused mark is read through its own name, not a live region.
- **Tables**: every table has a caption, `scope="col"` headers and a `scope="row"` header in its first cell
  (a day, a station, a ticket). A table view that scrolls is a focusable, named region.
- **Ranking tables** (Economics by model, Quality by gate, Reliability): the row's first cell is a real
  button (one Tab stop for the table, Up/Down/Home/End between rows, `aria-pressed` for the selected row);
  rows themselves carry no ARIA state.
- **Chips** (a filter in force): the name is the visible text then the action ("Model opus, remove this
  filter").

## 3. Pointer targets (WCAG 2.5.8)

Marks are not enlarged: a dot strip of a hundred tickets cannot give each dot 24 × 24 px without the hit
areas overlapping, which would only hide the problem. Instead each crowded mark has an **equivalent control**
on the same page that meets the size and offers the same action:

| Chart | Small marks | Equivalent |
|---|---|---|
| Compare, dots per cohort (C3, K4) | 10 × 10 px dots | The Table view: each ticket is a button (24 px tall) that opens it in the Timeline, the mark's action |
| Quality, cost by rounds | 11 × 11 px dots | The same, in its Table view |
| Pulse, station time strip | 8–13 px segments | The Table view: each station is a button opening Flow on that station; also the panel's "Open flow" link |
| Pulse, execution endings | 8–13 px segments | The Table view: each ending is a button opening Reliability filtered to it |

The Table button is reachable by Tab and is 28 px tall. The audit verifies the equivalent by opening each
such chart's table and counting its controls, not by trusting a declaration.

## 4. Colour

- **Contrast of graphical objects (1.4.11)**: every chart mark and outline reaches 3:1 against its ground in
  both themes. The token-kind ramp (Economics, "Tokens by kind") is checked numerically by the unit test
  against the canvas and surface of each theme, read from the design tokens and the stylesheet: light steps
  3.61–9.54:1, dark 3.38–11.93:1 on the canvas. Neighbouring segments are also separated by a 2 px gap of the
  ground and named in the key. A dark system preference without a chosen theme gets the dark ramp too.
  Flow's station boxes have a 3.5:1 or stronger outline (`--an-outline`).
- **Text**: the Rows drawer slides in without fading, so its text has full contrast from the first frame
  (the fade was why axe measured 3.5–4.4:1 there).
- **Colour is never the only cue**: Pulse's merged and integrated columns are separate, labelled rows, the
  slices outlined, and each mark's name starts with its series; Quality's dots are filled (passed first
  time) or open rings (needed more rounds), and say so in their names; target verdicts are words ("meets",
  "misses", "too few to judge"); endings are named (failed, interrupted, outcome unknown, no end recorded,
  the last also hatched).

## 5. Motion

Under `prefers-reduced-motion: reduce` nothing in the workspace animates or transitions (the audit checks an
area switch, a window change, a hover and the drawer opening).

## 6. Audit results

Proof mode (`node scripts/analytics-audit.mjs --mode proof`): the proof page over the simulated fixture,
dark and light, every area, the default, sparse, no-lifecycle and model-filtered histories, every chart as a
table, and the Rows drawer open.

| Check | e2e's first run (13 Nov) | Before this pass (14 Nov, current tree) | After |
|---|---|---|---|
| axe, WCAG 2.2 A/AA tags, 67 states, dark and light | fail: 56 violations (aria-pressed on rows, label in name, drawer text 3.99:1, unfocusable scroll region) | fail: 22 (label in name on Flow and Reliability marks and filter chips; drawer link text 3.5–4.4:1 mid-fade) | **pass: 0** |
| Keyboard: Tab order, visible focus, one stop per chart, arrows inside, drawer keeps and returns focus | fail (Pulse's first chart 2 stops; drawer returned focus to the page body) | pass | **pass** (47, 44, 59 stops on Pulse, Flow, Quality; 0 without a ring; 0 Tab presses left the drawer) |
| Targets 24 px, spaced, or an equivalent (2.5.8) | fail: 160 crowded | fail: 160 crowded | **pass**: 0 crowded without an equivalent; 160 with one; 75 small but spaced |
| Contrast, chart marks 3:1 and chart text 4.5:1, both themes (176 pairs) | fail: 6 | fail: 2 (Flow station boxes 1.5–1.7:1) | **pass: 0** |
| Colour independence (29 charts) | fail: 2 | fail: 2 (Pulse T1/T2 columns, Quality cost dots) | **pass: 0** |
| Reduced motion | pass | pass | **pass** |
| Every chart: name, summary, table (95 drawn, 5 unavailable) | pass | pass | **pass** |

Between the first run and this pass the areas agent had already fixed the row buttons, the scroll region,
Pulse's second Tab stop and the drawer's focus return. Also checked by a scripted walk (not part of the
audit): in the drawer, 80 Tabs and 10 Shift+Tabs never left it; Escape and Close each returned focus to
Rows; a definition popover opened on Enter and returned focus to its button on Escape; in a chart Right,
End and Home moved between marks and Escape moved focus to the chart's Table button.

Captures (git-ignored), `web/apps/control-tower/screenshots/analytics/a11y/`: `before-*` and `after-*` of
Pulse, Flow, Economics, Quality, Compare and the Rows drawer at 1512 and 1100 px (Pulse and Economics also
light). Compared pixel by pixel, only Flow's station outlines changed (`compare-flow-nodes-dark-1512.png`);
`after-focus-*`, `after-escape-*`, `after-table-*` show focus, Escape and the table equivalents.

## 7. Known gaps

- Not tested with a screen reader or by a disabled user. axe and the audit find structural faults; they do
  not show that the reading order of a chart's names is pleasant, or that the summaries say enough.
- Shell and live modes of the audit were not rerun for this pass (the Shell mounts the same areas; live
  depends on the wiring in progress).
- Only Chromium was driven. Safari does not focus a button on click, so after a mouse click on Rows the
  drawer's focus return falls back to the sheet.
- Marks that are `role="img"` with a roving `tabindex` are focusable images; this is the common pattern for
  keyboard-explorable charts but some screen readers announce them as "image" only.
- The small marks rely on the table equivalent (section 3); a pointer user who will not switch to the table
  still meets 8–11 px dots.
- Space on a focused non-activatable mark (`role="img"`) is not handled by the mark, so in the Shell the
  global play/pause key may receive it.
- Zoom and reflow at 400% (1.4.10) and text spacing (1.4.12) were not audited.
