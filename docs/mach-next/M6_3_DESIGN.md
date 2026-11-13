# M6.3 Execution Timeline: design and shared contract

Status: in progress on `feature/mach-next-m6-3-execution-timeline`, from baseline `5bb379e`.
This document is the contract every part of M6.3 is built against. Where it and the code disagree,
fix one of them in the same change.

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
   (`factory-ink-soft` outline), with the recorded parallel limit as a dashed reference line when the Factory's
   limits record one. Stepped lines, not smoothed.
3. Landmarks from `/api/v1/marks`: failures (`factory-fail` tick up), recoveries and interruptions
   (`factory-halt`), person waits (`factory-human` bar spanning the wait), gate refusals and overrides (diamond).
4. Gaps in history: hatched (`.mach-future`'s hatch) columns with a `ring-query` mark.
5. The brush: the detailed window. Drag inside to move, drag an edge to resize, drag on empty overview to draw
   a new window, double-click to show everything. Keyboard: the brush is a two-thumb slider group (window start,
   window end) plus "move window" with arrow keys; PageUp and PageDown move by one window.
6. The playhead and the live edge, as in the docked ruler.

### B. Hierarchical tracks

One canvas for rows, one for the ruler, DOM for the sticky label column (176 px gutter, resizable to 320 px).
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

## 4. Tracks: two projections of one span set

Both groupings are pure functions of the same spans. Neither nests rounds under executions or the reverse.

**Product-oriented** (default): Wave → Slice → Cell → Station visits (one row per station, visits in sequence;
rounds are bracketed above the cell's stations as a `round` ribbon), then under the cell: Waits (dependency,
eligible, capacity, person), Review (one row per seat per round), Verification. Executions that touched the
cell appear as a thin "executions" ribbon on the cell row, linked, not nested.

**Execution-oriented**: Execution (attempt n for cell X) → Claim → Workflow → Agents (lanes; queue time drawn
as a wait before each agent) → Tools (main-loop and sub-agent calls where the stream shows them; a count-only
agent shows "n tool calls, not observable one by one" and no ticks). Station visits made during the execution
appear as a linked ribbon on the execution row.

Cross-links are drawn only for the selection: selecting a span highlights its counterpart ribbon segments in
the other hierarchy and draws a 1 px `factory-select` connector to them when both are in view.

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
| open | started, not ended | bar runs to the live edge with a fading right end and no cap; never an outcome mark | "running for 4 min" (work) or "waiting for 4 min" (waits) |
| unknown | applies, nothing records it | a `ring-query` mark at the known end and a dotted 1/2.4 line of fixed 24 px length away from it; never extended to imply a length | "start not known" / "end not known" |
| not recorded | MACH does not capture it | nothing drawn in the row; the label column says "not recorded" in italic `ink-subtle` | "Not recorded" |

Further rules:

- An interrupted span (the scene's `interrupted`, the span's end `reason: interrupted|superseded`) is drawn with
  a `factory-halt` cut mark at the recorded stop and a dotted bridge to where it was taken up again. It never
  says "took".
- Outcome colour (pass, fail, halt) is applied only to spans whose end is at or before the live edge of what is
  held, and an outcome established by a later event is drawn at that event, not at the span's end.
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
process or widens what is served.

1. `/api/v1/spans`: `from_ms`, `to_ms` (overlap; an open span overlaps everything after its start), `span=<id>`
   (exact), `sort=start`, and in the reply `truncated` and `total_uncapped`. The built list is cached per
   projection position. Each span gains `attrs`: only facts other routes already serve (agent `label`, `model`,
   `agent_type`, `tool_calls`, `last_tool`, `tokens`; visit `action`, `round`; execution `attempt`, `state`,
   `cost_usd`; seat `model`, `vote`; wait `reasons`, `depends_on`).
2. Waits kept as history: every `dependency.blocked`/`resolved` pair per slice (not only the latest) and every
   closed capacity wait, each a span (`slice-wait`, new kind `capacity-wait`).
3. Times on recoveries and on history gaps (projection format version 3; the projection rebuilds itself).
4. `/api/v1/concurrency?from_ms&to_ms&bucket_ms&kinds`: per bucket, the maximum and mean number of spans of
   each kind active, by basis, with the recorded limits (`max_parallel`) and when they applied.
5. `/api/v1/marks?from_ms&to_ms&after_ms|before_ms&kinds&limit`: instants and intervals worth jumping to:
   `failure`, `retry`, `gate` (refused, overridden, passed), `review` (verdicts, decisions), `human`
   (required, approved), `recovery`, `interruption`, `gap`. Each with its event id, entity ref and time.
6. `/api/v1/series`: per-ticket per-minute counts for everything indexed, so a filtered overview does not
   depend on the memory window.
7. `/api/v1/history`: falls back to the disk segments for ranges the memory window no longer holds.

## 7. Store, selection and deep links

- `SceneStoreState.workspace: "floor" | "timeline"` (default `"floor"`), `setWorkspace`. `view` keeps meaning
  Atlas or Blueprint and is remembered while the Timeline is up.
- Timeline interface state that must survive a workspace switch lives in the store, in one object:
  `timeline: { window: {from, to} | null, grouping: "product" | "execution", expanded: string[], filters }`.
  It is interface state: nothing in it changes what any other view shows.
- Selection, hover, focus, playhead, following, playing and speed are the existing fields. The Timeline never
  keeps its own.
- The hash: `#timeline?sel=<ref>&at=<event id | ms>&win=<fromMs>-<toMs>&group=product|execution`. `sel` uses
  the existing ref grammar. `at` seeks the playhead (an event id is preferred: it is stable across a rebuilt
  index; a millisecond time is accepted). `#atlas?sel=` and `#blueprint?sel=` are unchanged and gain the same
  optional `at`. Unknown parameters are ignored.
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
Reduced motion: no eased zoom, no growing spans; state changes cut. axe at zero violations; targets 24 px.

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
