# M6.3 Execution Timeline: design and shared contract

Status: built on `feature/mach-next-m6-3-execution-timeline`, from baseline `5bb379e`; brought up to date
with what was built after five review rounds. This document is the contract every part of M6.3 is built
against. Where it and the code disagree, fix one of them in the same change.

## 1. What it is

The Execution Timeline is the second of the Control Tower's four experiences (Factory Floor, Execution
Timeline, Evidence Theater, Factory Analytics). It is a full-workspace instrument for one question: what did
the Factory do, when, and how do we know. It is drawn in the Living Factory's own language (the drawing-sheet
ground, the state marks, the tier shapes, the dimension-line grammar of the Blueprint) and is neither a Gantt
chart nor an event table.

It adds no second source of truth. Time, selection, hover, focus, source and playback stay in the one scene
store. Spans come from the observer's `/api/v1/spans` projection (extended, section 6); the simulation, which
has no observer, derives the same span shape from its scene.

## 2. Baseline: what exists and what M6.3 adds

| Capability | At `5bb379e` | M6.3 |
|---|---|---|
| Docked timeline under the Factory Floor (transport, ruler with landmarks, one canvas of tracks) | Yes: `src/shell/timeline/` | Kept as it is. Shares the transport, the palette reader and the time helpers. |
| Track model | One track per cell or slice plus a Factory track; no hierarchy, grouping or virtualisation | New hierarchical model with two groupings (section 4) |
| Spans from the observer | Not used; `/spans` has no time window and silently cuts at 5,000 | Windowed, flagged, cached (section 6) |
| Timing quality drawn | Only in hover text; the Blueprint's `DimLine` draws it | A full visual grammar (section 5) |
| Overview | An 8 px density strip in the ruler | A full-history overview with a brush (section 3A) |
| Deep links | `#atlas|blueprint?sel=<ref>` | `#timeline?...` added (section 7); the old forms unchanged |
| Views | `ViewMode = "atlas" | "blueprint"`, assumed to be two throughout `Stage.tsx` | A separate `workspace` field; `ViewMode` and `Stage.tsx` untouched |
| Jump lists (failures, gates, people) | Landmarks and chapters | `/api/v1/marks` plus the existing history index |
| Concurrency | Not served | `/api/v1/concurrency` |
| History beyond the newest 50,000 events | `/history` cannot reach it | Disk fallback in the observer |

Not duplicated: the event reducer (`src/sim/reduce-v3.ts`), the scene store (`src/scene/store.ts`), the
observer's index, the history-window loader (`src/live/windows.ts`) and the playback clock (`src/scene/clock.ts`).

## 3. The workspace

Primary navigation in the header becomes a two-level control: the workspace (**Factory Floor**, **Timeline**;
Evidence and Analytics are later milestones and are not drawn as disabled placeholders) and, on the Factory
Floor only, the existing Atlas/Blueprint switch. Keys `1` and `2` keep their meaning (and switch to the floor);
`3` opens the Timeline.

The Timeline workspace replaces the stage and the docked timeline. The header, the source badge, the
connection chip and the inspector column stay where they are. Regions, top to bottom:

```
+-----------------------------------------------------------------------------+-----------+
| header (unchanged): source, connection, project, workspace switch            |           |
+-----------------------------------------------------------------------------+ inspector |
| transport: play, step, time, live state, speed | grouping | filters | jumps  |  (C)      |
+-----------------------------------------------------------------------------+           |
| A  temporal overview: whole history, density, activity, landmarks, brush     |           |
+--------------+--------------------------------------------------------------+           |
| ruler gutter | time ruler for the brushed window (adaptive ticks)            |           |
+--------------+--------------------------------------------------------------+           |
| B  sticky    | hierarchical tracks, one canvas, virtualised rows             |           |
|    labels    | playhead, live edge, selection, cross-track highlight         |           |
+--------------+--------------------------------------------------------------+-----------+
```

### A. Temporal overview (height 96 px; 72 px when the window is under 760 px high)

Always the whole held history, never zoomed. Layers, bottom to top:

1. Density: events per bucket from `/api/v1/series`, as a 1 px-column area in `ink-subtle`, log-scaled, labelled
   "events recorded" (never load, never utilisation).
2. Activity bands, from `/api/v1/concurrency`: executions running (`factory-live`), cells in a station
   (`factory-ink-soft` outline; the part whose end was inferred as a lighter band above, from `inferred_max`),
   agents. Stepped lines, not smoothed. A recorded limit is drawn as a dashed reference line only on the band
   of the kinds it limits (`applies_to`); a limit that applies to none of them is not drawn.
3. Landmarks from `/api/v1/marks`: failures (`factory-fail` tick up), recoveries and interruptions
   (`factory-halt`), person waits (`factory-human`: a thin line on the landmark row with its start mark, never a
   full-height wash), gate refusals and overrides (diamond).
4. Gaps in history: hatched (`.mach-future`'s hatch) columns with a `ring-query` mark.
5. The brush: the detailed window. Drag inside to move, drag an edge to resize, drag on empty overview to draw
   a new window, double-click to show everything. Keyboard: the brush is a two-thumb slider group (window start,
   window end) plus "move window" with arrow keys; PageUp and PageDown move by one window.
6. The playhead and the live edge, as in the docked ruler.
7. Compressed idle time: stretches with nothing recorded (no events, no landmark) longer than a fifth of the
   extent can be drawn as a 28 px break in the axis with its length on it ("10 h 3 min"); on by default when one
   is longer than half the extent, toggled by "idle" in the legend. The idle tail after the last record is named
   once ("nothing recorded for …"); a break label too wide for its break sits before it, never under "now".
8. The legend fills the tracks' label column (the plot starts where the tracks' time axis starts): "events
   recorded" with its peak, then most at once by kind; under 760 px high, one line of words ("1 run · 1 cell ·
   3 agents"), never glyphs and bare numbers.

### B. Hierarchical tracks

One canvas for rows, one for the ruler, DOM for the sticky label column (224 px, resizable).
Rows are virtualised vertically: only rows intersecting the viewport (plus one screen of overscan) are laid
out, labelled and drawn.

Level of detail by pixels per span and per event:

- under 1.5 px wide: the span joins a density run for its row (a tint bar whose opacity encodes how many spans
  it stands for, with the count in the tooltip); never drawn as individual marks;
- 1.5 px to 28 px: geometry without a label;
- 28 px and wider: geometry with a label, and a duration when 96 px and wider;
- instants (gate evaluations, verdicts, tool calls, artifacts) are drawn individually only when their row has
  under one instant per 6 px in view; otherwise as a count pip.

Row heights: group 28, cell 32, station 26, execution 26, workflow 22, agent 18, tool 12, wait 18.

A row states its own condition, never a child's verdict: its mark and words come from its own spans (a cell
whose round was rejected is not "failed"), with the children's counts beneath ("2 rejections", "1 interrupted").
An open container (wave, slice, cell, round) is "open", "open, work running" or "open, waiting for a person".

### C. Inspector

The existing inspector column and its anatomies, selected through the store as now. M6.3 adds one section,
**In time**, shown for anything with a span: start, end, duration with its basis in words, the two events that
bound it (each a "Go to event" link), parent and children spans, what came immediately before and after on the
same track, and evidence references (artifact catalog ids) where the anatomy has them. No raw tool input, no
model reasoning: only what the general event API already serves.

### D. Time travel

The existing transport (`src/shell/timeline/Transport.tsx`) unchanged in behaviour, plus: zoom to selection,
zoom to brush, a filter bar (execution, cell, slice, station, kind of event) and a jump menu (previous and next
failure, retry, gate decision, human intervention, gap). Live execution keeps arriving while the playhead is in
the past, exactly as on the Factory Floor: `following` is the store's flag.

**As of the playhead (T6, changed in M6.6, I-04).** M6.3 drew the tracks, their hover words, the table and the lenses
as of the live edge and tinted the stretch after the playhead. Since M6.6, with the playhead held behind the live
edge they are held at the playhead, as the inspector is: the span set is cut there (`spansAsOf`, `marksAsOf`,
`seriesAsOf` in `data/derive.ts`, the simulation's own `cutAt`), so nothing begun later is drawn, a span still open
at the playhead reads as open with no outcome, and the moment is rounded down (`heldAtOf`). The toolbar's "Show what
happened after this moment" (`timeline.revealAfter`, off by default, not in the address, turned off by Return to
live) draws the rest up to the live edge, tinted and labelled "After the playhead". Following live is unchanged.
The overview keeps the whole history's axis for navigation, but held at the playhead it draws no density, activity
or landmark after it (`overviewAsOf`); that stretch is plain extent labelled "after this moment, not shown". A
link whose `at` lies after the history's end goes to its last event (before its start, to its first) and says so.

## 4. Tracks: two projections of one span set

Both groupings are pure functions of the same spans. Neither nests rounds under executions or the reverse.

**Product-oriented** (default): Wave → Slice → Cell → Station visits (one row per station, visits in sequence;
rounds are bracketed above the cell's stations as a `round` ribbon), then under the cell: Waits (dependency,
eligible, capacity, person), Review (one row per seat per round), Verification. Executions that touched the
cell appear as a thin "executions" ribbon on the cell row, linked, not nested.

**Execution-oriented**: Execution ("LOCAL-001 · run 2/3": the ticket and the execution's order among its cell's
executions by start; the detail "from 05:37 · supervisor attempt 1", since the supervisor's `attempt` can
repeat) → Claim → Workflow → Agents (lanes; queue time drawn
as a wait before each agent) → Tools (main-loop and sub-agent calls where the stream shows them; a count-only
agent shows "n tool calls, not observable one by one" and no ticks). Station visits made during the execution
appear as a linked ribbon on the execution row.

Cross-links are drawn only for the selection: selecting a span highlights its counterpart ribbon segments in
the other hierarchy and draws a 1 px `factory-select` connector to them when both are in view.

Structure from the whole history: the tree is built from the structural spans of the whole history (waves,
waits, cells, rounds, claims, executions, workflows: one unwindowed read, refreshed when the data changes) and
the window's detailed spans, so a track's identity and place do not depend on which window was loaded.

Identity: a track's id is its entity ref (`cell:LOCAL-031`, `execution:<id>`, `station:LOCAL-031/build`,
`seat:LOCAL-031/review#2/security`), or `<group>/<kind>` for a synthetic row (`cell:LOCAL-031/waits`). Ids never
depend on order or on what else is loaded, so expansion, selection and scroll survive every rebuild.

## 5. Timing and evidence grammar

The span's `duration.basis` and each end's `basis`, `precision` and bounds decide the drawing. One rule per
basis, used identically in the tracks, the overview, tooltips, the inspector and the structured alternative.

| Basis | Meaning (observer contract) | Geometry | Words |
|---|---|---|---|
| measured | both ends recorded with ms or s precision | solid bar, 2 px square end caps | "took 4 min 12 s" |
| bounded | an end is known only within bounds | solid bar between the certain parts; the uncertain end is a bracket `[` `]` spanning `not_before` to `not_after`, bar hatched inside it | "between 4 min 10 s and 4 min 14 s" |
| inferred | an end was placed by a stated rule | bar outline dashed 3/2, no fill at the inferred end, open arrowhead cap, "≈" before any label | "about 4 min, placed by rule: <rule in words>" |
| open | started, not ended | bar runs to the live edge with a fading right end and no cap; never an outcome mark | "at work for 4 min" (work), "waiting for 4 min" (waits), "open 4 min" (containers) |
| unknown | applies, nothing records it | a `ring-query` mark at the known end and a dotted 1/2.4 line of fixed 24 px length away from it; never extended to imply a length | "start not known" / "end not known" |
| not recorded | MACH does not capture it | nothing drawn in the row; the label column says "not recorded" in italic `ink-subtle` | "Not recorded" |

Further rules:

- An interrupted span (the scene's `interrupted`, the span's end `reason: interrupted|superseded`) is drawn with
  a `factory-halt` cut mark at the recorded stop and a dotted bridge to where it was taken up again. It never
  says "took".
- The open/at-work rule: only an open execution, workflow, agent, tool, task or station visit (other than
  human approval) is "at work"; open waits are "waiting"; open waves, slices, cells, rounds, claims and seats
  are "open", never at work, and do not keep the default window at the live edge.
- A visit whose exit was recorded after its execution ended (`attrs.interruptedAt`) never shows a bare length:
  its bar says "open for 1 h 0 min, not continuous", as do the table and the inspector (the lens's rung, with
  no room, says "not continuous" and leaves the length to its hover card).
- An execution stopped from outside or of unknown outcome, and anything closed at its end by rule, never
  "took"; a visit ended without an exit record is "ended without an exit record, within …".
- No end recorded: on a history that is no longer live (a replay; a Factory whose records leave it disabled,
  `recorded_mode.state: disabled`, with no supervisor lease) an execution, workflow, agent or visit still open at
  the last recorded time is drawn to that time with the `ring-query` mark and said as "no end recorded; the
  history ends at 06:42:22", never as running. Client presentation only (`attrs.historyEndsAt`); nothing is
  closed and the observer is not asked to. A live, enabled Factory keeps "at work".
- Outcome colour (pass, fail, halt) is applied only to spans whose end is at or before the moment the tracks are
  held at (the live edge, or the playhead when it is behind; section 3D), and an outcome established by a later event is drawn at that event, not at the span's end.
- Authority shows as the left cap: filled (authoritative), ring with dot (observed), open triangle
  (reconstructed), dashed ring (simulated). The same glyphs as `AuthorityBadge`.
- Span families differ by shape, not only colour: station visits are 8 px bars; executions 4 px rails with
  tick ends; workflows a bracketed rail; agents a tier-shaped head followed by a 3 px line; waits are dashed
  bands with a stop bar; gates and verdicts are diamonds; human gates are terracotta down-triangles with a band
  for the wait; tools are 1×6 ticks.
- Count-only agents carry their tool-call count as a number after the head. No ticks are ever invented.
- Colour is never the only carrier: every state has its mark, every basis its geometry.

## 6. Observer extensions (GET only, loopback only, redaction unchanged)

All derived from the projection and the index; none writes outside `.factory/local/observer/`, starts a
process or widens what is served. Timeline replies are built from a snapshot of the projection taken outside
its lock; while the writer holds the lock a built timeline is served if it is of the log's epoch and younger
than `TimelineMaxAge`, else the request waits. Every timeline reply carries `cursor`, `live_ms` and
`projection` (`current` or `rebuilding`, while the projection rebuilds in the background).

1. `/api/v1/spans?ticket|execution|wave|entity|span&kinds&from_ms&to_ms&sort=start&limit&offset`: overlap with
   the window (an open span overlaps everything after its start), `span=<id>` exact. Sorted by start, cut at
   5,000 after filtering; the reply says `truncated` and `total_uncapped`, plus `total`, `more`, `offset` and
   `basis_vocabulary`. `attrs` carry only facts other routes serve (agent `label`, `model`, `agent_type`,
   `tool_calls`, `last_tool`, `tokens`; visit `action`, `round`, `interrupted_at`; execution `attempt`, `state`
   (always sent), `cost_usd`; seat `model`, `vote`; wait `reasons`, `depends_on`).
2. Waits kept as history: every `dependency.blocked`/`resolved` pair per slice and every closed capacity wait,
   each a span (`slice-wait`, `capacity-wait`).
3. Times on recoveries and on history gaps (projection format version 3; the projection rebuilds itself).
4. `/api/v1/concurrency?from_ms&to_ms&bucket_ms&kinds` (`bucket_ms` whole seconds): per bucket and kind the
   `max`, the time-weighted `mean` and `inferred_max` (how many of `max` end by rule); `limits` with what each
   limits (`applies_to`, span kinds) and when it applied; `complete` (false when history in the range was lost).
5. `/api/v1/marks?from_ms&to_ms | after_ms | before_ms &kinds&limit&offset`: a window ascending, `after_ms`
   ascending, `before_ms` descending (nearest first); `total`, `truncated`, `order`, `more`, `next_offset`.
   Kinds: `failure`, `retry` (a revise visit), `attempt` (an execution claimed again: its own kind, never a
   retry), `gate`, `review`, `human`, `recovery`, `interruption`, `gap`, `wave`, `merge`.
6. `/api/v1/series?from_ms&to_ms&bucket_ms&ticket&execution`: events per bucket by kind and authority; whole
   minutes from everything indexed, finer from the memory window (`source`), with `complete`.
7. `/api/v1/history`: falls back to the disk segments; the reply says `complete` and `capped`.
8. `/api/v1/runs` and `/runs/{id}` serve the same execution state as the spans' `attrs.state` (one function,
   `ExecStateIn`; shared contracts 2.3), including the bound from later records ("unknown", never "running").

The client reads these through `src/timeline/data/observer.ts`: tiles of the window cached by projection
position, a tile behind the stream's cursor re-read once due, a tile whose pages answered from different
positions read again.

## 7. Store, selection and deep links

- `SceneStoreState.workspace: "floor" | "timeline"` (default `"floor"`), `setWorkspace`. `view` keeps meaning
  Atlas or Blueprint and is remembered while the Timeline is up.
- Timeline interface state that must survive a workspace switch lives in the store, in one object:
  `timeline: { window: {from, to} | null, grouping: "product" | "execution", expanded: string[], filters }`.
  It is interface state: nothing in it changes what any other view shows.
- Selection, hover, focus, playhead, following, playing and speed are the existing fields. The Timeline never
  keeps its own.
- The hash: `#timeline?sel=<ref>&at=<event id | ms>&win=<fromMs>-<toMs>&group=product|execution&lens=<id>`. `sel` uses
  the existing ref grammar. `at` seeks the playhead (an event id is preferred: it is stable across a rebuilt
  index; a millisecond time is accepted). `#atlas?sel=` and `#blueprint?sel=` are unchanged and gain the same
  optional `at`. Unknown parameters are ignored.
- Selection does not seek: clicking a span or mark selects it and the inspector shows it as of the playhead;
  Enter again or a double-click on it goes to it (the playhead seeks, the
  live control says it is reviewing). A later single click on the same span only keeps the selection.
- Cross-view: "Show in Timeline" from any inspector anatomy and from the Atlas and Blueprint (key `3` with a
  selection) switches workspace, keeps the selection and playhead, and frames the selection's span. "Show on
  the floor" does the reverse through the existing `focusOn`.
- Future Evidence Theater links: a span or mark exposes `evidence: ArtifactRef[]` (catalog ids) and the ids of
  the events that produced or verified them. M6.3 renders them as references only.

## 8. Performance budget (to be measured, section 12 of the brief)

On a 200,000-event, 12-cell history: first paint of the Timeline under 1.5 s after the scene is ready; pan
and zoom frames under 16 ms at the median and 33 ms at the 95th percentile; scrub response under 100 ms at the
median; expand or collapse under 50 ms; no more than +60 MB browser heap over the Factory Floor alone; a
workspace switch under 300 ms. Means: windowed span queries, a per-window span cache keyed by projection
position, row virtualisation, level of detail, one canvas, no React element per span, incremental track
rebuilds keyed by span id.

## 9. Accessibility

One tab stop for the tracks (`role="application"` with a described grid behind it), arrow keys between spans
and tracks, Enter to select, Alt+arrows to expand and collapse, the existing playback keys unchanged. A
structured alternative: the visible window as a real, virtualised tree-table (track, what, started, ended,
duration and how it is known, outcome), reachable by a "Table" toggle and by screen readers at all times.
Reduced motion: no eased zoom, no growing spans; state changes cut. axe at zero violations; targets 24 px. The
keyboard map and the audit are in `M6_3_ACCESSIBILITY.md` (`scripts/timeline-audit.mjs`).

## 10. Source layout and ownership

```
web/apps/control-tower/src/timeline/
  contract.ts        the shared types (this document in TypeScript)
  data/              span, mark and concurrency providers: observer and simulation
  tracks/            the hierarchical model, both groupings, filters
  render/            canvas: ruler, rows, geometry, grammar, hit-testing, virtualisation
  overview/          the temporal overview and brush
  controls/          grouping, filters, jumps, zoom
  inspector/         the "In time" section
  investigate/       retries, concurrency, waits, review and human, recovery
  a11y/              keyboard model and the structured alternative
  Workspace.tsx      composition
apps/observer/internal/project/   spans, waits, concurrency, marks
apps/observer/internal/store/     series per ticket, history disk fallback
```

## 11. Investigation lenses

A band between the overview and the tracks, opened from "Investigate" (`lens=` in the hash). Each is named as
the question it answers and sets the grouping and window to fit what it shows: **Why did it retry?** (the
build → verify ladder of a cell: review rounds bracketed above, the executions it ran in below as "run 1 of 3"
with the supervisor's attempt only in the hover card), **What ran at once?**, **What was it waiting on?**,
**Who decided what?** (seats and decisions; a person's approval of the code kept apart from merge authority),
**What was interrupted?** ("taken up again" only when a later record shows it). Every figure names its
sources and reveals them in the tracks.

## 12. Safety nets in the client

For an observer before M6.3 (a reply without `truncated`): a visit open past its execution's end is closed at
that end by rule (`closeEndedVisits`; never a visit to human approval, a person wait or a gate wait). For every
answer: claims, workflows, agent queues, agents and tools still open under an ended execution end there
(`closeEndedChildren`, reason `interrupted`, or `unknown` under an unknown outcome); an outcome is shown only
with a recorded end; no tool spans under a count-only agent. An M6.3 observer already applies these rules and
deliberately leaves the rest open.

## 13. Deliberately not built

Real-time (1×) playback of a past history (speeds are named against real time instead); a critical path;
Evidence Theater (spans carry references only); Factory Analytics.
