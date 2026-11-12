# MACH Next — M6.0 visual specification: the Living Factory

The art direction, composition, grammar, motion and interaction rules for the Factory Atlas and the Execution Blueprint. Owner: visual design. Builders (Atlas, Blueprint, Shell) follow it literally; where this file and your instinct disagree, this file wins, and a change goes through the visual-design owner.

- Code: `web/packages/ui/src/factory/**`, exported from `@mach/ui` (a `@mach/ui/factory` subpath is proposed to the lead; until then import from `@mach/ui`).
- Tokens: `web/packages/ui/src/tokens/tokens.ts` (`factory-*` roles and `factoryTokens`), generated into `tokens.css`, contrast-checked by `pnpm --filter @mach/ui typecheck`.
- Reference sheet: the showcase, `pnpm dev:showcase`, then `http://127.0.0.1:4174/?product=control-tower#factory`. Screenshots: `web/apps/showcase/screenshots/factory/` (`node apps/showcase/scripts/capture-factory.mjs` after a showcase build).

Units: **pu** (plan units) on the ground plane; 1 pu = 1 CSS px at camera zoom 1. **px** are screen pixels after projection, before the camera. Durations in ms. Token names are CSS variables (`--mach-factory-live`) or, in TypeScript, `fc("live")`.

---

## a. Concept

**The drawn plant.** MACH is drawn the way an engineer draws a plant: an axonometric drawing on a warm sheet, with drafted line weights, section hatching on cut faces, lettering on the floor, registration marks and dimension lines. Then the drawing comes alive: the lamp in a working cell comes on, carriages ride the conveyor track, a gate's arm lifts, a sheet rises out of the floor as an artifact is written, a dashed arc swings back from verification to build and a pip fills on its crest. The Blueprint is the same drawing folded flat: the engineering sheet of the same run, with a title block, zones, process bubbles and dimensioned durations.

This fits MACH's existing identity (warm neutrals, serif display, one terracotta accent, calm motion) rather than replacing it, and it is the opposite of a sci-fi console.

### Principles

1. **Everything is a place or a thing in a place.** Stations are machines standing on a floor; agents are figures standing at machines; artifacts are sheets standing on shelves; gates are frames across the track. No floating cards.
2. **Two projections, one alphabet.** The same symbol for a station kind appears on a machine's top face in the Atlas and inside a process bubble in the Blueprint; the same head shape marks a model tier in both; the same state mark, ink and tint mean the same state in both.
3. **Drafting discipline.** Three line weights only on structure (0.75, 1, 1.5 px), plus 2 to 2.6 px for things that act (gate arms, live routes, posts). Section hatching (45 degrees, 5 px pitch) only on faces in shade or cut. Text is either lettering on the floor (serif for regions, mono for IDs, projected into the plane) or upright labels (sans), never both for one thing.
4. **Light means work, nothing else glows.** Light comes from the upper left, fixed. The only light that changes is a cell's work lamp (on while a station in it works). The only colour that means "now" is the live ink (blue, `factory-live`). Terracotta is selection (the place), and the human gate's ink is the terracotta family because a person's act is MACH's primary act.
5. **Motion has a cause.** Every movement is the visible consequence of one event and is a pure function of `playhead - event.at`. Nothing idles, breathes, shimmers or pulses.
6. **Shape before colour.** Every state has a mark whose shape alone distinguishes it; every position of a gate is an arm angle; every tier is a head shape. Colour reinforces.

### What it is not

- Not a dashboard: no KPI tiles, no charts in the scene, no card grid.
- Not a node-link diagram of rectangles; the Blueprint uses process bubbles, diamonds, lanes and dimension lines, the Atlas uses solids.
- No particles, bloom, neon, scan lines, holograms, glass, gradients as decoration, random flicker, idle pulsing, camera shake, or game HUD chrome.
- No isometric "cute" illustration: no characters with faces, no props that do not correspond to a MACH entity.

---

## b. Factory Atlas

### b.1 Projection

2:1 dimetric, angle 26.565 degrees (`factoryTokens.projection`). Plan x runs down-right (the direction of flow), plan y runs down-left (across the floor, cell after cell), z runs up.

```
screen.x = (x − y) × 0.894427
screen.y = (x + y) × 0.447214 − z × 0.82
```

A plan unit along x or y keeps its length on screen; elevation is drawn at 0.82.

How it is achieved:

- **Flat things** (ground grid, plate tops' inner drawing, floor lettering, branch curves, dials): drawn in plan coordinates inside `<g transform={planeTransform(z)}>`, which is `matrix(0.894427 0.447214 −0.894427 0.447214 0 −0.82z)`. Strokes inside a plane group render at 0.8x; multiply plan stroke widths by `planeStroke` (1.25).
- **Upright things** (faces of solids, posts, heads, arms, labels): computed in JavaScript with `project(point)` and drawn in screen space. `prismFaces(box)` returns the top, lit (+y) and shade (+x) faces.
- **Upright sheets** (artifacts, plaques): `uprightTransform(at, height)` shears a local card coordinate system onto the plane x = const.
- **Inverse**: `unproject(screenPoint, z)` gives the plan point at elevation z (hit testing, zoom-to-cursor, drop positions).
- **No CSS 3D.** The projection is in SVG coordinates; CSS transforms are used only for the camera (section f), so text stays crisp and hit testing stays exact.

### b.2 The plant layout

Regions in belt order along +x, each a plate 8 pu high (`RegionPlate`), separated by 56 pu aisles of bare ground. All coordinates in pu; `D` is the depth of the construction floor.

| Region (`RegionKind`) | Plan x | Plan y | Size (w × d) | Contents |
|---|---|---|---|---|
| `intake` Intake and scheduling | 0 | 0 | 240 × D | The intake machine at (60, D/2); the scheduler (Haiku) at its desk at (60, D/2 + 40); holding pads (40 × 40) for slices `waiting-on-dependency` and `eligible` in a column at x = 150, 56 apart; the audit machine at (200, D/2 − 60) and the audit gate across the exit at (240, D/2), axis y |
| `floor` Construction floor | 296 | 0 | W × D | The cells |
| `review` Review chamber | floor.x + W + 56 | D/2 − 130 | 240 × 260 | Entry at its left edge, middle; three seats inlaid as floor discs (r 13) at (+112, −52), (+126, 0), (+112, +52) from the entry; the consensus gate at (+200, 0), axis y |
| `human` Human approval | review.x + 296 | D/2 − 80 | 120 × 160 | The human gate (gatehouse height 46) at its centre, axis y |
| `integration` Integration | human.x + 176 | 0 | 220 × D | The merge machine at (+70, D/2); the revalidation gate before it; the trunk: the main line, a track along y at x = +160 for the full depth, drawn at z = −6 (a cut in the plate, hatched both sides) |
| `archive` Archive and observe | integration.x + 276 | 0 | 200 × 200 | Cleanup machine at (+60, +70), observe machine at (+140, +130); finished cells' records as a stack of artifact sheets |

**Cells on the floor.** Cell size 216 × 148 (`factoryTokens.size.cell`). Rows run along y (at most 4), columns along x.

```
rows = min(n, 4)            cols = ceil(n / rows)
cell i: col = floor(i / rows), row = i mod rows
origin = (floor.x + 24 + col × (216 + 56),  24 + row × (148 + 32))
W = 48 + cols × 216 + (cols − 1) × 56
D = 48 + rows × 148 + (rows − 1) × 32
```

3 cells: 1 column of 3, W = 264, D = 556. 12 cells: 3 columns of 4, W = 808, D = 736. The 56 pu gaps between columns are **aisles**: each cell's door opens onto the aisle at its right; aisle tracks run along +y to the **front transfer**, a track along x at y = D − 12 that carries work to the review chamber's entry. With one column the door opens straight onto the transfer, which then turns to the chamber entry. A **bridge** (`Prism`, 20 pu wide, height = plate top, hatched lit face) carries every track across each 56 pu gap between regions; no route ever touches bare ground.

### b.3 A cell as a place

`CellPlate` + `cellAnatomy(origin)`; all offsets from the cell origin.

```
  back wall (along x, full height 14) ───────────────────────────────
 |  shelf: artifact slots at x = 18 + 19i, y = 18                    |
 |                                                                   |
 |  ═══[ intent bench ]═════[  build  ]═════[ verify ]═══════ door ──┼─ verification gate (+14 outside)
 |      x 40                 x 110          x 178        rail y 58   |
 |        ▲ agent spot y 92   ▲               ▲                      |
 |  ......ticker (tool calls) y = 118 .............................. |
 |  TCK-112     SLICE-007        (floor lettering, y = 139)          |
  front curb cut at 4 high, poché ───────────────────────────────────
```

- **Section model.** Floor slab 4 high (`factory-floor`). The two back walls (along x at y = 0, along y at x = 0) stand 14 high, 4 thick. The two front walls are cut at 4 high and their cut faces carry poché (`hatch`), so the inside is always visible and nothing inside is ever occluded by more than its feet.
- **Machines** on the rail: the intent bench (`groom`/`plan`, one machine showing the current one's symbol), `build`, `verify`. Machine footprint 36 × 36; height by kind (`stations[kind].height`, 10 to 30).
- **Agents** stand at the agent spot in front of the machine they work (seat offsets of 16 pu when two share a machine).
- **Artifacts** stand on the back shelf in the order written; the eight most recent are shown, older ones collapse into a stack mark with a count at slot 0.
- **Tool calls** accumulate as ticks along the ticker from left to right in time order. At most 24 ticks; beyond that the oldest 12 merge into a density bar (a 1.5 px line with tick marks every 2 pu).
- **Signal mast** at (10, 10), rising 20 above the wall top, carrying the stage mark (`cellStages[stage]`), with the stage word at near zoom.
- **Lamp**: while any station in the cell is working, an elliptical pool of `factory-lamp` lights the floor (rx = 0.5 w, ry = 0.56 d, centred). Off otherwise. It never animates on its own; it fades in or out over `stateChange` (260 ms) at the start and end events.
- **Completion**: on `cellComplete`, the floor takes the `pass-soft` wash (opacity 0.85 × progress) and the mast shows the double ring.
- **Floor lettering**: ticket ID in mono 11 (16 at far), slice ID in mono 9 at near only, both in `ink-muted` / `ink-subtle`, drawn in the plane.

### b.4 Layering and depth

Draw order, back to front (painter's algorithm inside each layer):

1. Ground: `factory-ground`, then `GroundGrid` (minor 24 `factory-grid`, major 96 `factory-grid-major`, registration crosses at major intersections, quadratic fade toward the extent's edges, `fade` 0.85).
2. Overhead cables that pass *behind* plates: none. All dependency cables are drawn in layer 6.
3. Region plates and bridges, sorted by `depthOf` of their front corner.
4. Routes on plate tops (track rails, sleepers, chevrons) and handoff dots.
5. Per cell, inside `CellPlate`: floor, lamp, wash, lettering, rail, ticker, back walls, mast, then children (machines, artifacts, ticks, agents, packets) sorted by `depthOf(at)` ascending, then the front section cut (it occludes feet, which is the depth cue).
6. Things above the floor that belong to the air: retry loops, dependency cables, escalation risers, gates (gates after the cell they stand at), lamps on lintels.
7. Overlays (never depth-sorted, never occluded): selection brackets, callouts, labels at near zoom, the simulation label.

Depth cues, in this order of strength: occlusion (layers above), elevation (heights fixed per kind), **contact shadows** (`shadowPolygon`: the footprint swept by height × (0.5, −0.18) in plan, `factory-shadow`, flat, no blur), **face shading** (top `plate-top`, lit face `plate-lit`, shade face `plate-shade` + poché), and **atmospheric fade** (grid only; plates are never faded by distance, only by dimming).

### b.5 Lighting

One fixed light from the upper left (plan −x, +y, above). It decides face tones and shadow direction, and never moves. The only variable light is the cell lamp (b.3). In dark theme, plates are lighter than the ground (elevation shows as lightness, as in the design system); in light theme, plates are lighter than the ground too (white on warm paper), with shaded faces darker. No specular highlights, no glow except the optional WebGL lamp bloom (section g), which is decoration and capped.

### b.6 Density, 3 to 12 cells

| Cells | Columns | Default zoom to fit | Changes |
|---|---|---|---|
| 1–4 | 1 | about 1.0 | Full detail at mid |
| 5–8 | 2 | about 0.75 | Shelf shows 6 artifacts; ticker merges after 16 |
| 9–12 | 3 | about 0.55 (far) | Opens at far zoom: machines keep symbols, agents drop role emblems, ticks become density bars, artifacts become a count on the shelf |

The layout is fixed by the formula; cells never reflow while playing (a cell keeps its place for the whole scenario, so spatial memory holds).

### b.7 Semantic zoom

| Level | Camera zoom | Shown | Hidden |
|---|---|---|---|
| **Far** | < 0.6 | Region plates with lettering at 26; cell plates, ticket IDs at 16; mast marks at r 8; machines with symbols at 22; agents as posts and heads; routes with live ink; gates; packets; retry pips; escalation risers | Minor grid, chevrons, sleepers, role emblems, artifacts (count only), ticks (density bar), all upright labels |
| **Mid** | 0.6–1.4 | Everything drawn at its base size: machines, agents with emblems, artifacts, ticks, chevrons every 48, registration crosses | Upright labels, sleepers, slice IDs |
| **Near** | > 1.4 | Plus: upright labels for machines, agents, gates, packets (ticket IDs), artifact file names, stage words on masts, "Round n of 3", sleepers every 12, slice IDs | Nothing |

`lodForZoom(zoom, previous)` applies hysteresis of ±0.05 so the level does not flicker at a threshold. Level changes cross-fade labels over 120 ms (interface motion).

---

## c. Execution Blueprint

### c.1 The sheet

`BlueprintSheet`: an engineering drawing sheet. Outer hairline at 6 px, inner border 1.25 px at 18 px margin, filled `factory-ground`. Zone letters A, B, C… along the top and numbers 1, 2, 3… down the left (8 × 4 zones by default, more as the sheet grows), so any point can be cited ("the failure in zone D2"). **Title block** in the lower right, 260 px wide: title in the serif 15, subtitle (wave, run) sans 10, facts (Cell, Slice, Playhead, Seed) with mono values, and the **Simulation stamp** (warning soft, warning line, bold 10) which is never hidden.

### c.2 Hierarchy and lanes

`BlueprintLane`, nesting: **wave** (depth 0) ⊃ **slice / cell** (1) ⊃ **station rows** (rounds; within the cell lane) ⊃ **agents** (2) ⊃ **tool calls and artifacts** (3).

| Depth | Rule | Title | Indent | Height (expanded / collapsed) |
|---|---|---|---|---|
| 0 wave | 1.75 px `ink-soft` | serif 16, ID mono 9.5 | 0 | content / 36 |
| 1 cell | 1 px `plate-edge`, band `floor` at 0.6 | sans 12.5 semibold, ticket ID mono | 14 | 146 per round row set / 30 |
| 2 agents | 0.6 px | sans 11 | 28 | 50 / 24 |
| 3 tool calls | 0.6 px | sans 11 | 42 | 62 / 24 |

The left gutter is 168 px: title, ID and state mark. A hierarchy brace (3 px, `plate-edge`) runs down the left of each nested lane. A selected lane gets a 3 px `factory-select` bar at its left edge.

**Columns are stations in belt order**, at fixed x for the whole run (spacing 70 to 90 px; the Atlas order, flattened): groom, plan, audit gate, build, verify, verification gate, review fan-out, consensus gate, human gate, merge. Fixed columns mean the drawing never re-lays out as time passes: time is shown by state and by dimension lines, not by position.

**Rounds are rows.** Round 1 runs on the cell lane's main line (y = lane top + 56). A retry adds a row 50 px below for round 2 (and 3), with nodes only in the columns that re-run (build, verify); the row is labelled "Round 2" left of its first node. The line returns to the main row after the verification gate.

**Expand and collapse.** Waves and cells collapse (disclosure chevron, summary text "3 stations, 7 agents", height 30). Agents and tool lanes collapse into the cell. Expansion animates lane height over `layout` (400 ms, standard), contents fade in after 120 ms; under reduced motion it is instant. Cells that are `merged` collapse by default when more than 6 cells are on the sheet.

### c.3 Nodes

| Thing | Blueprint form |
|---|---|
| Station | Process bubble r 15 with the station symbol (17), a hairline bar through the middle (the line-station mark), state mark r 4.6 at its upper right, progress arc at r 18.5 while working, "×n" in the fail ink at upper left when it is round n ≥ 2, name below (sans 10.5 semibold) |
| Gate | Diamond r 14 with the gate symbol (13); the bar under it: a solid bar when shut, two stubs when open; lamps above |
| Agent | The tier head (same shapes as the Atlas) at 1:1, progress arc r 8.5, seat letter above for reviewers, label "Builder · Sonnet" at 10 |
| Tool call | Stem 9 px with family cap, on the tool lane's baseline at the x of its time within the station's column span |
| Artifact | Card 14 × 18 with folded corner and kind mark, at the handoff it carries (between the two nodes) |
| Wave, slice | Lanes (c.2) |
| Human | Human gate diamond; a person's act is a callout naming who and when |

### c.4 Edges

- **Route**: 1.25 px (2 px live), rounded corners r 8, arrowhead 6.5 px, ink by state.
- **Retry loop**: dashed 5/3 in the fail ink from the failed verify to the round-n build, with the round pips (r 2.6, three slots) at its middle and "Round n of 3".
- **Fan-out / join**: cubic splays from the gate's right point to the three seats, and from the seats to the consensus diamond; each branch in its state ink; vote marks at the seats.
- **Dependency**: S-curve dashed 4/3 in the wait ink, from the prerequisite's merge node to the dependent's lane, padlock at its middle; on unlock, solid in the pass ink.
- **Escalation**: dotted 2/3 riser in the fail ink, straight up from the blocked node to a person tag.

### c.5 Precision at density

- Durations as **dimension lines** (`DimensionLine`): extension lines, slash ticks, mono 9.5 tabular value above, placed on the tool lane's bottom edge, one per station group.
- **Callouts** (`Callout`) for failures, the selected thing and the event under the playhead: dot, 45-degree leader, 14 px shoulder, two lines.
- Text never overlaps a node: labels are below nodes; callouts go up and right unless the right edge is within 220 px, then up and left.
- Above 8 expanded cells, agent and tool lanes collapse by default; the selected cell stays expanded.

### c.6 One product, two modes

Shared: every symbol, head shape, state mark, ink, tint, type face and role; selection is the terracotta bracket (Atlas) or bar (Blueprint); the playhead is one.

**The mode switch** ("the drawing folds flat"), 700 ms (`modeSwitch`), standard easing, interface motion (`motion/react`):

1. 0–300 ms: Atlas solids lose height (z × (1 − p)), shadows and side faces fade; labels fade out.
2. 0–700 ms: each entity's screen position interpolates from `project(atlasPoint)` to its Blueprint position (a FLIP on entity centres; the Blueprint layout is precomputed).
3. 300–700 ms: Atlas glyphs cross-fade to their Blueprint forms in place; lanes, sheet border and title block fade in.

The selected entity stays selected and is kept in view on both sides. Reverse for Blueprint to Atlas. Reduced motion: a 160 ms cross-fade, no travel.

---

## d. Semantic grammar

Colours are token roles (`--mach-factory-*` unless written `--mach-*`). Sizes in pu for the Atlas, px for the Blueprint. Labels follow the zoom rules of b.7.

### d.1 States

| State (`FactoryState`) | Word | Mark (shape) | Ink | Tint | Outline | Used for |
|---|---|---|---|---|---|---|
| `idle` | Idle | dashed ring | `ink-soft` (strokes), `plate-edge` (outline) | `plate-top` | dashed 3/2.5 rim | Not running, nothing wrong |
| `active` | Working | ring with a filled sector = progress | `live` | `live-soft` | solid ×1.25 | Work in progress |
| `succeeded` | Passed | disc with tick | `pass` | `pass-soft` | solid | Finished and passed |
| `failed` | Failed | disc with cross | `fail` | `fail-soft` | solid ×1.5 | Finished and failed |
| `waiting` | Waiting | ring with hourglass | `wait` | `wait-soft` | dashed 5/2.5 ×1.25 | Held by a dependency or capacity |
| `human` | Waiting for a person | ring with dot | `human` | `human-soft` | solid ×1.5 | Held for a person |
| `blocked` | Blocked | octagon with bar | `fail` | `fail-soft` | solid ×2 | Escalated, three rounds used |

Modifiers: **selected** = `SelectionBrackets` (Atlas: four 10 px corner brackets, 1.75 px `factory-select`, 4–6 px outside the screen bounds) or lane bar (Blueprint). **Dimmed** = opacity 0.28 (`dimmedOpacity`) on the whole thing, labels kept at 0.55. **Hovered** = the thing's outline +0.5 px and its upright label shown at any zoom.

Cell stages map to states in `cellStages` (`waiting-on-dependency` waiting, `eligible` idle, `dispatched` active, `interview` active, `spec-ready` idle, `planned` idle, `building` active, `built` idle, `verified` succeeded, `awaiting-human` human, `approved` succeeded, `pr-open` active, `merged` succeeded with double ring, `blocked` blocked).

### d.2 Nodes

| Type | Atlas form and size | Blueprint form | Fill / stroke tokens | Icon | Label rule | States |
|---|---|---|---|---|---|---|
| **Region** (`RegionPlate`) | Plate 8 high, rim inset 8, corner registration marks 12, poché both sides | Wave lane (c.2) | top `plate-top`, faces `plate-lit`/`plate-shade`, edge `plate-edge`, rim `plate-edge` | none | Floor lettering, serif 19 (26 far), `--mach-ink-muted`; caption sans 10.5 | active (live rule along the front edge), dimmed |
| **Cell** (`CellPlate`) | 216 × 148 section model (b.3) | Cell lane | floor `floor`, walls `plate-*`, cut poché | stage mark on mast | Ticket ID on floor (mono 11); stage word at near | every cell stage; lit; completion; dimmed; selected |
| **Station** (`StationMachine`) | 36 × 36 block, height by kind (intake 16, groom/plan 12, audit 14, build 22, verify 18, review 12, human-approval 30, merge 16, cleanup 10, observe 20); symbol 18 on top (22 far); dial r 13 while working | Process bubble r 15 | top: tint of state (idle `plate-top`); outline: state ink (idle `plate-edge`) | station symbol | Name sans 11 semibold + state 9.5, at near | idle, active (+progress), succeeded, failed (+round), waiting, human, blocked |
| **Agent** (`AgentMarker`) | Floor disc r 8 with role emblem; post 1.6 px; head by tier; height by tier (Fable 32, Opus 28, Sonnet 24, Haiku 18); progress arc r 8.5 | Head at 1:1 + label | head fill: `live` when working, tint otherwise; stroke: state ink | head = tier, emblem = role, seat letter A/S/P | Role (or name) 10.5 + tier 9.5 at near | idle, active, succeeded, failed, waiting, human, blocked; arrive 0..1; leave 0..1 |
| **Gate** (`GateGlyph`) | Portal: posts 2.4 px, span 44, height 34 (human 46); lintel 3 px; plaque 18 × 15 on the lintel with the gate symbol; arm 2.6 px pivoting at the near post, banded with three dots | Diamond r 14 + bar | posts and lintel `ink`; arm and plaque: state ink (closed: `ink`) | gate symbol; lamps | Gate name 11 + position 9.5 at near | closed (arm 0 degrees), open (82 degrees), refusing (drops 14 to 0 degrees, refuse curve, plaque flash), waiting (closed, human ink) |
| **Artifact** (`ArtifactCard`) | Upright sheet 14 × 18, folded corner 4, mark by kind | Card 1:1 | `plate-top` / `ink` (failed: `fail-soft` / `fail`) | kind mark | File name mono 9 at near | succeeded, active (being written), failed (findings); materialise 0..1 |
| **Tool call** (`ToolTick`) | Stem 11 with family cap, on the ticker | Stem 9 on the tool lane | `ink`; running `live`; failed `fail` with cross-bar | read ring, write square, run triangle, search lozenge, test check, git node | In the inspector only | idle (open cap), active, succeeded, failed; tick 0..1 |
| **Packet** (`Packet`) | Carriage 12 × 8 × 6 aligned to the track, chevron on top | Lozenge 13 × 9 | top `*-soft`, outline state ink | chevron | Ticket ID mono 9 above at near | any state; position from `pointAlong` |
| **Wave** | Manifest stack on the intake dock (artifact sheets) | Lane depth 0 | as region | wave mark | WAVE ID | — |
| **Slice** | Holding pad 40 × 40 in intake until dispatched | Cell lane | pad `plate-top`, waiting: `wait-soft` | state mark | Slice ID | waiting-on-dependency, eligible, dispatched |
| **Human** | The human gate in its gatehouse; a person's act is a callout | Human gate diamond | `human`, `human-soft` | person symbol | Who and when, in the callout | waiting, released |

Station symbols (24 grid, 1.5 stroke, round caps): intake hopper; groom wedge cut from a disc; plan set square; audit gauge; build bonded courses; verify crosshair; review three seats on a dashed triangle; human-approval person; merge two lines becoming one; cleanup archive box; observe lens; red-before-green: cross, divider, tick.

Gate kinds: audit (gauge), red-before-green (lamps: red then green), verification verdict (crosshair), review consensus (three vote lamps), human approval (person, gatehouse height), merge revalidation (merge).

Artifact marks: intent (four lines of prose), spec (braces), contract (double frame), plan (checkboxes), commit (node on a line), build-report (bars), evidence (viewfinder corners), results (ticks and a cross), vote (ballot with tick), findings (lines with an exclamation), decision (seal with tick), merge-commit (merge Y).

Agent roles (emblem on the floor disc): scheduler (clock), line supervisor (double ring), contract engineer (set-square triangle), builder (solid square), verifier (cross), reviewer (three dots; plus the seat letter A, S or P beside the head).

### d.3 Edges

| Type | Primitive | Atlas | Blueprint | Tokens | States |
|---|---|---|---|---|---|
| Workflow route | `RoutePath kind="route"` | Two rails 6 apart, rounded r 5, rails 1.2 px (1.8 live); sleepers every 12 at near; chevrons every 48 (mid, near) | 1.25 px (2 live), r 8, arrowhead | idle `route`, live `live`, passed `pass`, failed `fail` | draw 0..1; live while a packet is on it |
| Branch / fan-out | `Branches mode="fan-out"` | Cubic splays in the plane from the chamber entry to the seats | Cubic from the gate | per branch state ink | per-branch progress (staggered) |
| Join | `Branches mode="join"` | Seats to the consensus gate, arrowheads | Seats to the consensus diamond | branch ink = the vote | per-branch progress; vote mark at the seat |
| Retry loop | `RetryLoop` | Dashed 5/3 arc lifted 30–34 over the line, from verify to build; pips at the crest | Dashed loop to the next round's row | `fail` | draw 0..1; round n of 3 |
| Dependency, blocking | `DependencyLink state="blocking"` | Overhead cable lifted 40–46, dashed 4/3, padlock shut at the crest, arrow at the dependent | S-curve, dashed | `wait` | highlighted (1.8 px) |
| Dependency, satisfied | `DependencyLink state="satisfied"` | Solid line drawn over the dashes, shackle opens; afterwards dashes at 0.15 | Same | `pass` | unlock 0..1 |
| Artifact handoff | `RoutePath kind="handoff"` | Dotted (0.1/4, round caps), the card rides it | Same | `route`; live `live` | draw 0..1 |
| Escalation | `Escalation` | Riser straight up, dotted 2/3, to a person tag. Vertical is reserved for escalation | Riser up from the node | `fail`, tag `fail-soft` | draw 0..1 |

---

## e. Animation grammar

**Rule.** Every factory animation is `progress = animationProgress(name, playhead − event.at, { reduced })`, a pure function of the playhead. No animation reads a clock, keeps state between frames or uses randomness. Scrubbing backwards gives the earlier frame because the same function is evaluated at the earlier time. Spans of work (an agent working, a station running) use `spanProgress(playhead, start.at, end.at)`.

Curves (`easings`): `standard` (0.2, 0, 0, 1), `enter` (0, 0, 0, 1), `exit` (0.4, 0, 1, 1), `travel` (0.45, 0, 0.25, 1), `draw` (0.3, 0, 0.2, 1), `settle` (0.16, 0.84, 0.3, 1), `refuse` (drops to 1.12 in the first 35%, one damped return, exactly 1 at the end).

Reduced motion: `snap` means the end state appears at the event time (progress 1 when elapsed ≥ 0); `fade` means a 160 ms linear opacity ramp with no change of position or size.

| Name | Trigger event (meaning; the simulation owner names the kind) | ms | Curve | What moves | Reduced |
|---|---|---|---|---|---|
| `packetTravel` | Work leaves one station for the next | 1400 (or the gap to the arrival event, if shorter) | travel | Packet position `pointAlong(route, p)`; the route is live while 0 < p < 1 | snap: the packet is at its destination |
| `pathDraw` | A route or handoff is first used | 600 | draw | `RoutePath progress` from the start point | fade |
| `agentArrive` | Agent started | 480 | settle | Post grows from the disc (height × p), head drops in, opacity min(1, 1.6p) | fade |
| agent working | Agent started → agent finished | span | linear | Head arc fills with `spanProgress`; state active | arc shown at its value, no sweep between steps |
| `agentLeave` | Agent finished | 360 | exit | Post sinks (1 − p); opacity follows | fade |
| `toolTick` | Tool call started | 240 | settle | Stem rises, cap settles; colour live until the call's end event, then ink or fail | snap |
| `artifactMaterialise` | Artifact written | 520 | settle | Card rises out of the floor (height × p), mark fades in over the last 60% | fade |
| `artifactHandoff` | Artifact handed to the next station | 900 | travel | Card rides the handoff route | snap |
| `gateClose` | Gate closes (work arrives at it) | 420 | standard | Arm angle from 82 to 0 | snap |
| `gateOpen` | Gate passes | 520 | settle | Arm angle from 0 to 82; plaque to pass ink | snap |
| `gateRefuse` | Gate refuses | 640 | refuse | Arm drops from 14 to 0 with one overshoot; plaque flashes once (opacity 1 to 0.5 over 25–100%) in fail ink | snap |
| `testResult` | Each test result in `results.json` | 160 each, stagger 60 | settle | One tick per result accumulates on the ticker (pass tick / fail cross) | snap |
| `verifyReturn` | Verification fails (`FAIL_WITH_EVIDENCE`) | 1600 | travel | 0–40%: findings card materialises at verify; 20–100%: `RetryLoop` draws from verify to build; 50–80%: pip n fills; 60–100%: findings card rides the loop | snap: loop drawn, pip filled, card at build |
| `fanOut` | Review panel seated | 700, stagger 90 per seat | draw | Branches draw to each seat; reviewers `agentArrive` as their branch completes | fade |
| `voteConverge` | Each vote submitted | 600 | travel | That seat's join branch draws to the consensus gate; its lamp lights with the vote | snap |
| human waiting | Awaiting human | until release | none | Gate held closed in human ink; mast shows ring-dot. **Nothing pulses.** The elapsed wait is shown as text in the inspector and on the timeline, not as motion | same |
| `humanRelease` | Person approves | 700 | settle | Gatehouse arm opens; a callout "Approved by <name>" fades in | snap |
| `mergeIntegrate` | Merge completes | 1100 | travel | Packet rides from the merge machine onto the trunk and along it 96 pu, then the merge-commit card materialises on the trunk | fade |
| `dependencyUnlock` | Dependency satisfied | 800 | standard | Solid pass line draws over the dashes; shackle opens; dependent pad's state turns eligible at 100% | snap |
| `cellComplete` | Cell merged / archived | 900 | settle | Floor wash 0 to 0.85; lamp off; mast to double ring | fade |
| `stateChange` | Any state change without its own animation | 260 | standard | Cross-fade of tint and mark | snap |

**Interface motion** (motion/react, not factory progress): camera focus 650 ms standard; mode switch 700 ms; inspector open 260 ms enter; lane expand 400 ms standard; hover 120 ms.

### e.1 Motion budget

At most, at any playhead:

| Kind | Cap (`factoryTokens.budget`) |
|---|---|
| Packets travelling | 12 |
| Paths drawing | 6 |
| Things materialising (artifacts, agents arriving) | 8 |
| Gates in transition | 4 |
| Lamps lit | 4 visible in the viewport |

Over a cap, the lowest-priority animations **snap** to their end state (they are still correct; only travel is dropped). Priority, highest first: escalation, verification failure and retry, human gate, other gates, votes, packets, artifacts, agents, tool ticks. Tool ticks never animate more than one per cell at a time; the rest appear settled. Only things inside the viewport count toward the caps.

---

## f. Camera and interaction

### f.1 Camera

One camera `{ x, y, zoom }` (screen translation and scale) applied as a CSS `transform: translate(x px, y px) scale(zoom)` with `transform-origin: 0 0` on the scene wrapper (both SVG layers), and as the stage transform of the optional WebGL layer.

- **Zoom** 0.35 to 3 (`factoryTokens.zoom`). Wheel/pinch: zoom × 1.0015^(−deltaY), clamped. Buttons and keys: × or ÷ 1.2.
- **Zoom to cursor**: the world point under the pointer stays fixed: `x' = cx − (cx − x) × zoom'/zoom`, same for y.
- **Pan**: drag with the primary button on empty ground, or two-finger scroll; Shift + arrow keys pan 80 px. Pan is clamped so at least 20% of the plant's bounds stays on screen.
- **Semantic zoom**: thresholds 0.6 and 1.4 with hysteresis 0.05 (b.7).

### f.2 Focus and selection

- **Selection** (click, Enter, Space) marks one entity: brackets in the Atlas, lane bar or ring in the Blueprint, the inspector shows it. Selection never moves the camera.
- **Focus** (double-click, F, or "Focus" in the inspector) moves the camera to frame the selection: bounds of the entity (a cell: its plate plus 40 pu; a station: its cell; an agent: its station and the agent), padded by 64 px or 12% of the viewport (whichever is larger), zoom = min(fit, 2.2) and not below the current level's lower threshold for that entity type (cells mid, stations and agents near). Duration 650 ms, standard ease, interpolating x, y and log(zoom). Reduced motion: instant.
- **Hover** shows the upright label at any zoom and a 120 ms outline +0.5 px.

### f.3 Follow mode (live playback)

On by default while playing at the live edge. The camera keeps the **active set** (entities with an animation in progress or state `active`) inside the inner 70% of the viewport: when any active entity leaves that safe area, the camera eases (900 ms, standard) to frame the active set at the current zoom (zoom changes only if the set no longer fits, never above the current zoom). It never re-frames more often than every 2 s. Any manual pan, zoom or focus suspends follow; "Follow" in the timeline bar (key `L` when not live, or `Shift+F`) resumes it.

### f.4 Dependency highlighting

Hovering or selecting a cell, slice or dependency link highlights its **dependency chain** (prerequisites and dependents, transitively): those entities and links stay at full opacity, links at 1.8 px; everything else dims to 0.28, routes to 0.4. Labels of the chain are shown at any zoom. Escape or clicking empty ground clears it.

### f.5 Blueprint expansion

Click the disclosure chevron or press `Enter` on a focused lane header to expand or collapse; `Alt+→` / `Alt+←` expand / collapse the focused lane; `*` expands all lanes of the selected wave. Expansion animates per c.2.

### f.6 Mode switch

A two-option segmented control "Atlas | Blueprint" in the top bar, keys `1` and `2`. The transition is c.6. The URL hash carries the mode (`#atlas`, `#blueprint`) and the selection (`?sel=TCK-112`).

### f.7 Theater Mode

Key `T` or the button in the top bar. Hidden: the navigation rail, the top bar, the inspector, entity labels below near zoom, hover outlines. Collapsed: the timeline becomes a 3 px progress line along the bottom with the time code at the right (mono 13). **Always shown**: the simulation stamp (top left, 16 px inset: "Simulation" in the stamp style of the title block), the mode (top right, a quiet word "Atlas" or "Blueprint", ink-muted). Follow mode turns on. `Escape` or `T` exits. Pointer movement shows the timeline bar for 2.5 s (fade 180 ms), and the bar stays while hovered.

### f.8 Timeline

Docked at the bottom, 132 px high (collapsible to 40):

- **Tracks**: one per cell (ticket ID in mono at the left, 160 px gutter), a gates track, a people track. Station spans are bars 6 px high in the station's state tint with the state ink at their ends; gate events are diamonds; people's acts are terracotta triangles; failures are fail-ink ticks that extend through the track.
- **Markers**: the scenario's chapter marks (wave arrives, first failure, human gate, merge) as labelled flags above the tracks.
- **Playhead**: 2 px `--mach-ink` line with a handle; time code above (mono, `mm:ss.s`). Dragging scrubs; clicking a track jumps to that time; scroll horizontally zooms time.
- **Controls**: play/pause, step to previous/next event, speed (0.5×, 1×, 2×, 4×), Live (jumps to the live edge and turns on follow), loop off.
- **Live-follow**: at the live edge the playhead reads "Live" and advances with the clock; any scrub leaves live.

### f.9 Inspector

A right sheet, 400 px, opening over 260 ms (`slow`, enter). Anatomy for every entity:

1. **Header**: its glyph at 24, its name (ticket title, station name, agent role), its ID (mono), the state mark and word.
2. **Why it looks like this**: the event that set its current state: kind, `seq`, `at`, source; and a "Go to event" button that moves the playhead to it.
3. **Facts** (definition list), per type:
   - Cell: ticket, slice, stage, risk tier, round n of 3, worktree path, agents present, artifacts count.
   - Station: kind, skill, model tier of its worker, started, duration, result, round.
   - Agent: role, tier, seat, started, working on, tool calls (count by family).
   - Gate: kind, position, what it checked, the decision and its evidence (votes, verdict).
   - Artifact: file, written by, at, handed to.
   - Tool call: family, the tool's own words (as a quotation), duration, result.
   - Dependency: from, to, state, unlocked at.
4. **Events**: this entity's events in time order, the current one marked; each has its telemetry status (`exists`, `derivable`, `missing`) as a small badge from the event catalog.
5. **Related**: dependencies, the cell it belongs to, the artifacts it produced; each a link that selects.

### f.10 Keyboard map

| Key | Action |
|---|---|
| `Space` | Play / pause |
| `,` / `.` | Previous / next event |
| `Shift+,` / `Shift+.` | Back / forward 10 s |
| `Home` / `End` | Start / live edge |
| `L` | Go live (and follow) |
| `1` / `2` | Atlas / Blueprint |
| `T` | Theater Mode |
| `F` | Focus the selection |
| `Shift+F` | Resume follow |
| `+` / `-` / `0` | Zoom in / out / fit |
| `Shift+Arrows` | Pan |
| `Tab` / `Shift+Tab` | Next / previous entity in reading order |
| `Arrows` (canvas focused) | Move selection to the spatial neighbour (Atlas) or next node in the lane (Blueprint) |
| `Enter` / `Space` on an entity | Select (Space plays only when the canvas, not an entity, has focus) |
| `Alt+→` / `Alt+←` | Expand / collapse lane (Blueprint) |
| `I` | Toggle inspector |
| `Escape` | Clear highlight, then clear selection, then leave Theater Mode |
| `?` | Keyboard help |

### f.11 Focus order

Skip link → top bar (title, mode switch, Theater, theme) → canvas (one tab stop; inside it, entities in reading order: regions left to right, then each region's cells by row then column, then within a cell machines in belt order, agents, artifacts) → timeline controls → timeline tracks (one tab stop; arrows move between events) → inspector. The focus ring is the design system's (2 px `--mach-focus`, 2 px offset); on SVG entities it is drawn as an extra rounded rectangle around the entity's screen bounds.

### f.12 Reduced motion

All factory animations follow the `reduced` column of section e (no travel, no sweeping arcs, no drawing; end states appear at the event time; fades of 160 ms at most). The camera jumps instead of easing; follow mode re-frames by jumping and at most every 4 s. The mode switch is a 160 ms cross-fade. Playback still runs and the playhead can be stepped event by event with `,` and `.`. Nothing loops in either mode.

---

## g. Rendering architecture

```
┌ scene viewport (overflow hidden, receives pointer events) ───────────────┐
│  ┌ camera wrapper (CSS transform: translate + scale, origin 0 0) ──────┐  │
│  │  L1  <svg> SCENE      ground, plates, routes, cells and contents,   │  │
│  │                       gates, loops, cables (layers 1–6 of b.4)      │  │
│  │  L3  <svg> OVERLAY    selection, focus ring, callouts, near labels  │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
│  L2  <canvas> LIGHT (optional, PixiJS 8)  between L1 and L3 in z-order,  │
│       not CSS-transformed: its stage takes the same camera each frame;   │
│       aria-hidden, pointer-events: none                                  │
│  L4  DOM: simulation stamp, zoom controls, minimap (fixed, not cameraed) │
└───────────────────────────────────────────────────────────────────────────┘
```

- **L1 Scene (SVG)**: all structure and all meaning. Primitives from `@mach/ui` only. React components memoised per entity; their props are the entity's state and progress values computed by the selectors for the current playhead, **quantised to 1/240** so unchanged things do not re-render. Culling: entities whose screen bounds (with 64 px margin) are outside the viewport are not rendered.
- **L2 Light (optional WebGL)**: decoration only. Permitted effects: the cell lamp's soft bloom (radius 120 px, max alpha 0.18 dark / 0.10 light, blend `screen` in dark and `multiply` with the lamp tint in light), a short fading trail behind travelling packets (length ≤ 40 px, alpha ≤ 0.25, a pure function of the packet's progress), and the gate plaque flash on refusal. It reads the same scene selectors; it never decides anything; the page must be complete and correct with it switched off (it is off under reduced motion and when WebGL is unavailable). PixiJS: `import "pixi.js/unsafe-eval"`, no workers (contract rule 6).
- **L3 Overlay (SVG)**: not depth-sorted, never occluded. Hit targets for entities are in L1 (each entity's group carries `role="button"`, `tabIndex`, `aria-label`, `aria-pressed`); L3 only draws.
- **One camera, one playhead**: both come from the scene store (`src/scene`). L1 and L3 share the CSS transform of one wrapper, so they cannot drift; L2 copies the camera into its stage in the same animation frame (`requestAnimationFrame` reads the store once per frame and updates L2; React updates L1/L3 from the same snapshot).
- **Interaction**: pointer events on the viewport; hit testing by the SVG (L1 groups); `unproject` for ground positions.

Performance budgets (12 cells, 1440 × 900, Apple M1, Chromium):

| Measure | Budget |
|---|---|
| Scrubbing | 60 fps; scene update ≤ 8 ms per frame |
| SVG elements in the DOM | ≤ 2500 at mid zoom, ≤ 1200 at far |
| Upright text elements | ≤ 160 |
| React commits while playing | ≤ 1 per frame |
| L2 draw calls | ≤ 40 per frame |
| Mode switch | no frame over 24 ms |
| First paint of the Atlas | ≤ 400 ms after the app's JavaScript has run |

---

## h. Themes, contrast, colour independence

Both themes use the same roles; the Control Tower defaults to dark (`product="control-tower"`). New factory roles (`tokens.ts`):

| Role | Light | Dark | Use |
|---|---|---|---|
| `factory-ground` | #F2EFE7 | #111110 | The sheet |
| `factory-grid` / `-grid-major` | #E5E1D5 / #D5D0C1 | #1D1D1B / #282725 | Drafting grid |
| `factory-plate-top` / `-lit` / `-shade` | #FDFCF9 / #ECE8DD / #DAD5C6 | #242421 / #1B1B19 / #161614 | Solid faces |
| `factory-plate-edge` | #9F9B8E | #55534D | Drafted outlines (decorative) |
| `factory-floor` | #F7F5EF | #1C1C1A | Cell floor |
| `factory-hatch` | #BDB8A8 | #34332F | Poché |
| `factory-shadow` | rgba(58,52,40,0.13) | rgba(0,0,0,0.5) | Contact shadows |
| `factory-ink` / `-ink-soft` | #3A3833 / #7A766B | #DAD6CA / #8F8C81 | Symbols and structure lines |
| `factory-route` | #858175 | #76736A | Idle track |
| `factory-live` / `-soft` | #2F6AA3 / #DCE7F3 | #8DB4DD / #1C2938 | Work in progress |
| `factory-pass` / `-soft` | #56683F / #E6EBDB | #A7B98A / #222A1B | Passed |
| `factory-fail` / `-soft` | #A12F3A / #F5DEDF | #EC8F96 / #3A1D20 | Failed, blocked, escalation |
| `factory-wait` / `-soft` | #86621A / #F3E6C6 | #D9B061 / #2F2716 | Waiting, dependencies |
| `factory-human` / `-soft` | #A9482A / #F6E3D9 | #E8957A / #3A2620 | A person's gate |
| `factory-select` | #B5512F | #E48B6C | Selection brackets |
| `factory-lamp` | #FFF6E6 | #2A2620 | The work lamp |

**Contrast** (enforced by the token script, 100 pairs, all passing): text on ground, plates and floors ≥ 4.5:1 (`ink`, `ink-muted`, `factory-ink`); every mark that carries meaning ≥ 3:1 against the surface it sits on and against its own tint (`live`, `pass`, `fail`, `wait`, `human`, `route`, `select`, `ink-soft`). Decorative lines (grid, plate edges, hatch) have no requirement and carry no meaning on their own.

**Colour independence.** Every state has a distinct mark shape (d.1); a station's state is also its outline style (dashed when idle, heavier when failed or blocked); a gate's position is its arm angle; a tier is a head shape and a height; a role is an emblem; a dependency's state is dashed versus solid plus the padlock's shackle; a retry is a dashed arc with counted pips; an escalation is the only vertical. Every primitive's accessible name states its state in words. The reference sheet reads in greyscale.

Theme specifics: in dark, solids are lighter than the ground and the lamp is a warm lift of the floor; in light, solids are white on paper with darker shaded faces, and the lamp is a cream pool. Hatching is darker than its face in light and lighter than its face in dark. Shadows are warm-tinted in light, black in dark.

---

## Primitive reference

All in `@mach/ui`, pure, props only, no timers or randomness. Atlas `at` is a plan point; Blueprint `at` is a screen point (`variant="blueprint"`). Every animating primitive takes `progress` 0..1.

| Primitive | Props |
|---|---|
| `FactoryScene` | `label`, `interactive?`, `ground?`, SVG props. Provides defs (hatch, lamp, arrows, dimension tick) with ids unique to the scene |
| `FactoryDefs` | children; for drawing into an SVG you own |
| `GroundGrid` | `x, y, w, d, lod?, fade?` |
| `Prism` | `box, top?, lit?, shade?, edge?, hatch?, shadow?, weight?, dash?, children` (drawn on the top face in plan coordinates) |
| `RegionPlate` | `box, kind, title?, caption?, height?, lod?, dimmed?, active?, children` |
| `CellPlate` | `origin, ticket, slice?, stage, z?, lit?, completion?, progress?, lod?, dimmed?, rail?, children` |
| `cellAnatomy(origin, z?)` | returns `floorZ, size, rail, pads, agentSpot(pad, seat), shelf(i), ticker(f), tickerLine, door, mast` |
| `StationMachine` | `kind, state, progress?, round?, label?, at, variant?, lod?, dimmed?, showLabel?` |
| `AgentMarker` | `agentRole, tier, seat?, state, progress?, arrive?, leave?, label?, at, variant?, lod?, dimmed?, showLabel?` |
| `GateGlyph` | `kind, position, progress?, from?, lamps?, axis?, at, variant?, lod?, dimmed?, showLabel?` |
| `ArtifactCard` | `kind, state?, progress?, file?, at, variant?, lod?, dimmed?, showLabel?` |
| `ToolTick` | `family, state?, progress?, detail?, at, variant?, dimmed?` |
| `Packet` | `at, angle?, state?, ticket?, variant?, lod?, dimmed?, showLabel?` |
| `RoutePath` | `points, variant?, kind? ("route" \| "handoff"), state?, progress?, chevrons?, arrow?, lod?, dimmed?, label?` |
| `RetryLoop` | `from, to, round, maxRounds?, progress?, variant?, lift?, crestY?, lod?, dimmed?` |
| `Branches` | `origin, targets, mode ("fan-out" \| "join"), progress? (number or per branch), states?, variant?, dimmed?, label?` |
| `DependencyLink` | `from, to, state ("blocking" \| "satisfied"), progress?, variant?, lift?, dimmed?, highlighted?` |
| `Escalation` | `from, height?, progress?, variant?, label?, dimmed?` |
| `SelectionBrackets` | `bounds, pad?, arm?, label?` |
| `BlueprintSheet` | `width, height, title, subtitle?, simulationLabel, zonesX?, zonesY?, facts?, children` |
| `BlueprintLane` | `x, y, width, height, depth, title, id?, state?, collapsed?, summary?, dimmed?, selected?, children` |
| `DimensionLine` | `x1, x2, y, label, extend?` |
| `Callout` | `x, y, dx?, dy?, text, detail?, tone?` |
| Symbols | `StationSymbol`, `ArtifactMark`, `ToolCap`, `AgentHead`, `RoleEmblem`, `StateMark` |
| Projection | `project`, `unproject`, `planeMatrix`, `planeTransform`, `planeStroke`, `uprightTransform`, `uprightTransformY`, `prismFaces`, `shadowPolygon`, `depthOf`, `screenBounds`, `toPoints`, `projectPoints`, `projectPath` |
| Geometry | `polylineLength`, `pointAlong`, `slicePolyline`, `offsetPolyline`, `roundedPath`, `marksAlong`, `liftedArc` |
| Motion | `animationProgress`, `spanProgress`, `staggerDelay`, `segment`, `easings`, `cubicBezier`, `factoryAnimations`, `clamp01`, `lerp` |
| Grammar | `factoryStates`, `cellStages`, `stations`, `stationOrder`, `regions`, `agentRoles`, `reviewerSeats`, `modelTiers`, `gates`, `gatePositions`, `artifacts`, `toolFamilies`, `lodForZoom`, `fc`, `dimmedOpacity` |
| Tokens | `factoryTokens` (projection, grid, elevation, size, stroke, shadow, zoom, motion, budget) |

Builders wrap primitives for interaction: `<g role="button" tabIndex={0} aria-pressed={selected} aria-label={…} onClick onKeyDown>` around the primitive; the primitive's own accessible name then sits inside as an image description.
