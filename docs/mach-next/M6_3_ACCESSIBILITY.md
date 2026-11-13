# M6.3 Execution Timeline: accessibility

Status: in progress on `feature/mach-next-m6-3-execution-timeline`. Design section 9 of
`M6_3_DESIGN.md` sets the aims; this document says what is built, how to reach it, what the audit checks,
and what it found on 2026-11-13. Every key below was read from the code, not from memory:
`src/shell/keyboard.ts` (`KEYMAP`, `TIMELINE_KEYS`), `src/timeline/render/keys.ts` (the tracks),
`src/timeline/overview/model.ts` (`keyStep`, the brush) and `src/timeline/a11y/model.ts` (`gridKey`, the table).

## 1. Keyboard map of the Timeline workspace

### Anywhere in the workspace (the global map)

Handled by one listener on `window`, in the bubble phase. It skips any event a focused widget has already
handled (`defaultPrevented`), any event with Ctrl or Cmd, and typing in inputs.

| Keys | Action |
|---|---|
| Space | Play or pause (not on a button, link, radio, slider, checkbox, menu item or tab) |
| `,` `.` | Previous / next event |
| `<` `>` (Shift+`,` Shift+`.`) | Back / forward 10 s of factory time |
| `[` `]` | Previous / next chapter, or landmark in real history |
| `{` `}` | Slower / faster |
| Home, End | Start of what is held / live edge (a slider, or a widget that handles them, keeps them) |
| L | Return to live and follow |
| 1, 2 | Factory floor: Atlas / Blueprint |
| 3 | Timeline, keeping the selection and the playhead |
| F, Shift+F | Reveal the selection's tracks and span / camera follow back on |
| Escape | Clear hover, then the selection |
| I | Show or hide the inspector |
| ? | The keyboard list |
| S | Choose the source |
| T, Shift+T | Do nothing in the Timeline (Theater Mode and the docked timeline are the floor's) |

### Timeline workspace keys (`TIMELINE_KEYS`, routed only while the workspace is up)

| Key | Action |
|---|---|
| G | Group by product or by execution |
| / | Filters |
| N, P | Next / previous mark of the kind last jumped to (failures at first) |
| Z | Zoom to the selection |
| A | Show all of the history held |

### The tracks (one tab stop: `role="application"`, described by its key list)

| Keys | Action |
|---|---|
| Up, Down | Previous / next row |
| Left, Right | Previous / next span on the row |
| Enter | Select the span, or open or close a group row |
| Alt+Right or `*`, Alt+Left | Expand / collapse |
| `+` `=`, `-` `_` | Narrow / widen the window about the cursor |
| `0` | Back to the workspace's default window (the recorded activity); without one, frame the span or row |
| Shift+Left, Shift+Right | Pan by a tenth of the window |
| PageUp, PageDown | A screen of rows |

The tracks do not handle Home and End: there they keep their global meaning (start of history, live edge).

The label column beside the tracks is for the pointer: each row is one target, its full width and height
(a press on the disclosure triangle opens or closes the row, anywhere else selects it), out of the Tab order
(`tabIndex={-1}`), named by its visible words. The tracks' keys do the same from the one tab stop. Rows
thinner than 24 px (rounds, waits, seats, agents, claims: 18 px; tools: 12 px) never overlap their
neighbours; their target-size case is WCAG 2.5.8's equivalent-control exception, and the audit reports them
as such (`data-target-equivalent="tracks"`). The column's width separator is a 24 px target centred on its right
edge, after the tracks in Tab order.

### The overview's brush (three sliders: "Move window", "Window start", "Window end")

| Keys | Action |
|---|---|
| Left/Down, Right/Up | Move or resize by 1% of the history (Shift: 10%) |
| PageUp, PageDown | "Move window": by one window; an edge: by 10% |
| Home, End | To the start / end of the history |

### The table (`role="treegrid"`, row focus, one tab stop)

| Keys | Action |
|---|---|
| Up, Down | Previous / next row |
| Right | On a closed track: open it. On an open track: move to its first child |
| Left | On an open track: close it. Otherwise: move to the parent |
| Home, End; Ctrl+Home, Ctrl+End | First / last row |
| PageUp, PageDown | A screen of rows |
| Enter | Select the span (`onSelect`); on a track, open or close it |

Every key the grid uses calls `preventDefault`, so the global map skips it: Home and End move within the
grid and leave the playhead alone (measured, section 5). Keys the grid does not use (Space, `,` `.` `[` `]`,
L, F, I, S, T, 1 2 3, ?, and the Timeline's G / N P Z A) fall through to their global meaning. No exemption
in `keyboard.ts` is needed for the treegrid; its Home/End exemption covers only `role="slider"`, and the
brush's sliders also prevent the default themselves.

## 2. The structured alternative

`TimelineTable` (`src/timeline/a11y`) shows the same tree and window as the canvas, as a real virtualised
tree-grid. Reach it with the toolbar's **Table** button (`aria-pressed`); the button and the canvas swap
places in the same region, and the window, grouping, filters and expansion are shared (expanding a track
with children in the table expands it in the canvas too; a leaf's span list is the table's own).

- Rows: tracks (`aria-level`, `aria-expanded` when expandable, `aria-setsize`, `aria-posinset`). A track
  row summarises its subtree in the window: span count, failures, interruptions, waits on a person, first
  start and last end ("Still open" when anything is). Opening a track lists its own spans in the window as
  child rows in time order, before its child tracks; at most 200, then a row "n more: narrow the window".
  A leaf opened with nothing in the window says so in a row of its own.
- Columns: Track (label, detail, the attention mark and its word), What (`describeSpan`), Started, Ended
  (UTC time codes in mono tabular figures; a bounded end reads "between … and …", a placed end "≈";
  "Not recorded" in italic where a value applies but no record holds it; "Still open" until the end is held),
  Duration and how it is known (`durationWords`), Outcome (only once `outcomeKnownAt` allows it), Authority
  (the `AuthorityBadge`: word and glyph).
- Virtualisation: rows are 32 px; only the rows in view plus 8 either side, and the focused row, are in the
  DOM. `aria-rowcount` is the full count (plus the header), each row carries its `aria-rowindex`. The header
  row is sticky.
- Narrower than 1,080 px (`STACK_BELOW`: 200% zoom, a narrow window, the inspector open on a laptop) each
  row stacks its columns: a track row reads its label, then its summary, then from / to; a span row reads
  what it was, then its state mark, from, to, duration, outcome and authority. Rows are then 68 px and the
  column headers are for screen readers only, so a row reads without scrolling sideways (WCAG 1.4.10).
- The store's selection is marked (`aria-selected`, a bar in the selection ink): the span row that is it
  (or the span the selection stands for, `selectionDetail`), else the track that is it or shows it. It is
  scrolled into view when it changes, wherever it was made.
- A caption above the grid (`windowSummary`) says the window in words; the grid is described by it.

Cost, measured in node on 60,000 spans (300 tracks of 200, `test/timeline-a11y.test.mjs`): building the
rows 0.1 ms; one screen of track summaries 1.6 ms; opening 20 tracks (4,000 span rows) 1.5 ms; a keystroke
0.2 µs (a key-to-index map, no scan); the window caption 6 ms (once per window). Nothing per keystroke is
proportional to the number of spans.

## 3. The screen-reader model

1. **One tab stop for the tracks**: the canvas is `role="application"` with its keys as its description,
   and a polite live region that says the row or span under the keyboard cursor: a span by `describeSpan`,
   a row by `rowSummary` (the same words as the table) and whether it is expanded.
2. **The live region's words** come from `src/timeline/a11y/describe.ts`, shared with the table:
   `rowSummary(node, window, liveAt)` ("LOCAL-031, cell, 129 spans in this window, one failed; from
   23:18:00 UTC to still open") and `windowSummary(tree, window, liveAt)` (bounds; spans by kind; failures
   and interruptions; waits on a person and how many still wait; what is still open). Words come from
   `KIND_WORDS`, `stateWord`, `schedulerLook` and the grammar's conditions; a span counts only once it has
   started by the live edge, and a failure only once the end that established it is held.
3. **The treegrid**: the full structure, always reachable from the toolbar.

## 4. Reduced motion

With `prefers-reduced-motion: reduce` (or the store's flag) the canvas cuts instead of easing a zoom or pan,
new spans do not fade in, and the workspace switch cuts. The table has no motion. The audit measures it
(section 5).

## 5. The audit

`node scripts/timeline-audit.mjs [--port 4206] [--out <dir>]` runs against the Vite dev server with the
simulation (`?simulation#timeline`), starting one on the port if none answers and stopping it afterwards.
It writes `timeline-audit.json`, the workspace's accessibility tree and screenshots to `--out` (default
`<tmpdir>/mach-timeline-audit`), never into the repository, and prints a table. A check that cannot run
says "not run: <why>" instead of failing.

| Check | What it does |
|---|---|
| axe | WCAG 2.2 A/AA tags on the workspace; dark and light; 1512×982, 1280×800 and 200% zoom (756×491 at DPR 2); both groupings; table off and on; a lens open when the Investigate menu offers one |
| keyboard | Tab from the top until focus comes back round: the region order, Tab stops in the tracks, a visible ring at every stop (outline or shadow, or pixels that change on focus), Tab and Shift+Tab leave the canvas, the grid is one stop |
| targets | Every interactive element in the workspace 24 px or more, or spaced, or (reported separately) a label row out of the Tab order whose function the tracks give, overlapping nothing (WCAG 2.5.8) |
| contrast | The drawn marks (3:1) and canvas text (4.5:1) against the ground and plate tokens, as rendered |
| reduced motion | No running animation or transition, and a still canvas, after a zoom, a brush drag and a workspace switch |
| shortcuts | No key bound twice in the same context (the global map and `TIMELINE_KEYS` read from the code); in the browser, Home/End in the grid move the row and not the playhead |

### Results, 2026-11-13, second run (after the round 3 fixes; other parts were still changing)

| Check | Result | Details |
|---|---|---|
| axe | pass | 0 violations in 26 states |
| keyboard | pass | 36 stops; order header > transport > toolbar > overview > tracks > inspector; 2 stops in the tracks (the canvas, then the label column's width separator); every stop with a visible ring; Tab comes back round; Tab and Shift+Tab leave the canvas; the grid is one stop |
| targets | pass | 0 undersized and crowded; 0 small but spaced; 20 thin label rows under the equivalent-control exception |
| contrast | pass | 0 pairs under their minimum |
| reduced motion | pass | zoom, brush drag, workspace switch: nothing running, canvas still |
| shortcuts | pass | no duplicate in the global map, no `TIMELINE_KEYS` key shadowed; grid Home/End keep the playhead; `.` still steps in the grid |

What the first run found and how it was fixed:

1. The brush's sliders had no visible focus. In this Tailwind 4 build `outline-hidden` sets
   `--tw-outline-style: none` too, so `focus-visible:outline-2` alone still drew nothing; the sliders now add
   `focus-visible:outline-solid`, and "Move window" draws its ring inside (it can span the whole plot).
2. Every label row's buttons were Tab stops (57): now one target per row, `tabIndex={-1}`.
3. Label-column targets under 24 px overlapped the next row: the row is now the target, full width and
   height, overlapping nothing; the separator is 24 px.
4. Toolbar names that omitted their visible words ("Fit activity", "Table"): fixed in the toolbar.
5. Lens figures (`g[data-fig]`) whose names omitted their drawn words: the name now starts with the drawn
   words when the description lacks them (`figureName`), and a visit chip's two words are spaced.

## 6. Known gaps

- The table does not follow hover.
- The table's leaf expansion is its own and is not kept across a workspace switch.
- A label row's disclosure is reached by the pointer and by the tracks' keys; a screen reader's virtual
  cursor activating the row button selects it (open or close a row from the tracks or the table).
- Contrast is computed from tokens, not from pixels: a mark drawn at reduced opacity (density runs) is not
  covered.
