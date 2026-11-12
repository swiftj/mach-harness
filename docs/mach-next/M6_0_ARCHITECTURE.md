# MACH Next — M6.0 architecture: how the Living Factory renders

Status: prototype, built on `feature/mach-next-m6-living-factory` (HEAD `34e5f39`), on top of MACH 0.12.0 (`fb86441`). Experimental, like the rest of MACH Next.

M6.0 is a visual-experience prototype of the Control Tower. It is a simulation: it reads no Factory state and changes nothing about how the Factory runs. This note records how its scenes are built and drawn, as the code has it, for the engineer who will build the production Control Tower on it. Companion files:

| File | Holds |
|------|-------|
| `M6_0_CONTRACT.md` | The working rules: one authority, every animation has an event, motion is a function of the playhead, local only, accessible |
| `M6_0_VISUAL_SPEC.md` | The visual grammar (sections a to f, h) and the design owner's rendering recommendation (section g). Referenced here, not repeated |
| `M6_0_TELEMETRY_GAPS.md` | What the real Factory records today, and what the picture could not show truthfully |
| `M6_0_FINDINGS.md` | The review findings and the captured evidence (written by the capture owner) |
| `web/apps/control-tower/src/sim/README.md` | The simulation's API, event model, store, scenario and storyboard, in full |
| `web/apps/control-tower/README.md` | Running, building, testing, capturing; URL parameters; the keyboard map |

File references below are relative to `web/apps/control-tower/src` unless they start with `web/` or `docs/`.

## 1. Shape

```
 sim/scenario (story.ts, belt.ts, content.ts)        built once at module load: SCENARIO
              │  Fixture { definitions, events[2,126], chapters, duration }
              ▼
 sim/engine.ts indexFixture(fixture)                 once per fixture, cached in a WeakMap
   reduce() over every event ──► scenes[0..2126]     scene after k events, structurally shared
   times[], refsByEvent[], eventsByRef, indexBySeq
              │  sceneAt(fixture, t) = scenes[upperBound(times, t)]
              ▼
 scene/store.ts createSceneStore  ── the one store ─────────────────────────────────────────
   playhead, liveAt, following, playing, speed, cursor       (time)
   selection, hovered, highlighted, focus {target, reason, nonce}   (attention)
   view "atlas" | "blueprint", theater, reducedMotion, follow       (presentation)
   clock: Clock (browserClock | switchableClock in dev/capture | manualClock in tests)
              │  useSceneStore(sel) / useScene(sel) / useSceneActions()  (scene/react.ts)
   ┌──────────┼───────────────┬──────────────────┬───────────────────┬────────────────────┐
   ▼          ▼               ▼                  ▼                   ▼                    ▼
 AtlasView  BlueprintView   Timeline           Inspector           Announcer          PixiEffects
 (atlas/)   (blueprint/)    (shell/timeline/)  (shell/inspector/)  (shell/)           (effects/, optional,
 camera,    camera, open    window, expanded   nothing             live-region text   Atlas only, off by
 LOD, focus lanes, tree     tracks, size                                               default)
 entity     tab stop
```

**What owns what.** `src/sim` owns what is happening: the events, the reducer, and every selector that turns events into state or timing. `src/scene` owns time and attention: the playhead, the live edge, speed, selection, hover and its highlight set, the focus request, the view mode, Theater Mode, reduced motion and the one camera-follow flag (`SceneStoreState` in `scene/store.ts`). Each view owns only interface state: its camera, its level of detail, which lanes or tracks are open, which entity holds keyboard focus. The Shell owns panel sizes, the inspector's open state, the help sheet and the light-layer switch (`shell/Shell.tsx`).

**The rule: no renderer owns progress.** No view keeps a counter, timer or animation state for anything the factory does. What a view draws at a moment is computed from `sceneAt(fixture, playhead)` and from events near the playhead. The few timers in the views are interface motion only: Theater Mode's 2.5 s auto-hide (`shell/Theater.tsx`), the Blueprint's 460 ms expansion flag (`blueprint/index.tsx`), and the two cameras' easings. `test/purity.test.mjs` source-scans `src/sim` and `src/scene` for randomness and wall-clock reads; the views are held to the rule by review and by the capture scripts, not by a test.

## 2. Time

### 2.1 The event and its `t`

The fixture's events are the real Factory event envelope, version 2, field for field (`FactoryEvent` in `sim/events.ts`: `schema_version`, `seq`, `at`, `type`, `project_id`, `source_commit`, `wave_id`, `slice_id`, `revision`, `ticket_id`, `runner_id`, `execution_id`, `source`, `cause`, `refs`, `data`). The 22 real kinds (`REAL_KINDS`, exactly `intake.EVENT_TYPES`) carry the `data` their emitters write; the 29 simulation kinds (`SIM_KINDS`) are what the picture needs and MACH does not emit.

The simulation adds one field, `t` (`SimEvent`): milliseconds since the scenario's start. `at` has whole-second resolution, as MACH writes it, which is too coarse to order or animate by, so everything time-based uses `t`. The engine requires events in `t` order and throws otherwise (`indexFixture`).

### 2.2 The clock

`scene/clock.ts` defines `Clock { now(), request(cb), cancel(h) }` and three implementations:

- `browserClock()`: `performance.now` and `requestAnimationFrame`. Production builds use it.
- `switchableClock(base)`: runs on the browser clock until `manual()`, then moves only by `advance(ms, frameMs = 250)`; `live()` resumes without a leap. Development and capture builds use it (`getSceneStore` in `scene/react.ts`, gated by `shouldExposeHook()`), so the capture script can render a recording frame by frame.
- `manualClock()`: for tests.

The store's frame loop (`onFrame` in `createSceneStore`) caps a frame gap at 250 ms, then moves factory time by `dt × PLAYBACK_BASE_RATE (10) × speed`. Speeds are `SPEEDS` = 0.5, 1, 2, 4, 8, 16; the 55:50 run plays in about 5.5 minutes at 1×.

**Live and replay.** `liveAt` is how far the simulated factory has run; it advances whenever playback runs. While `following`, the playhead is pinned to `liveAt`. `seek(t)` to an earlier moment turns `following` off (replay); replay plays on at the same speed while `liveAt` keeps advancing. `followLive()` jumps back and turns camera follow on. Seeking past `liveAt` moves `liveAt` forward, because the fixture is recorded and its future exists; this is the one behaviour a live stream cannot keep (section 7). At the end playback stops; `play()` replays from 0.

**Stepping and scrubbing.** `stepNext` and `stepPrevious` pause, then seek to `nextEventTime` / `previousEventTime` (`sim/selectors.ts`); events sharing a `t` move together. Scrubbing is `seek(t)` from the timeline's ruler (a `role="slider"`) or the track canvas. The Shell adds `,`/`.` (step), `Shift+,`/`Shift+.` (±10 s, `nudge`), `[`/`]` (chapters, `stepChapter`), `{`/`}` (speed, `stepSpeed`), `Home`/`End` (`shell/keyboard.ts`). Every one of these is an action on the store; nothing else moves time.

### 2.3 Motion as a function of the playhead

Every factory animation is `progress = f(playhead − event.t)`. Because the playhead is the only input, pausing, scrubbing backwards and changing speed all show the right frame with no bookkeeping: when the playhead moves before `event.t`, the event leaves the window and the motion is undone.

How the views derive it:

- **Which events are moving now**: `eventsInWindow(fixture, t, windowMs, kinds?)` (events with `t − windowMs < e.t ≤ t`). The Atlas wraps it as `animating(fixture, t, filter)` with a window per kind (`atlas/derive.ts`).
- **How far along**: the grammar's `animationProgress(name, elapsedWallMs, { reduced })` (`web/packages/ui/src/factory/motion.ts`), whose durations are written in 1× wall milliseconds. The views convert factory time to it by dividing by `PLAYBACK_BASE_RATE`: `anim()` in `atlas/derive.ts`, `eventProgress()` / `useEventProgress()` in `blueprint/motion.ts`. So an animation lasts the same share of the run at every speed. The simulation's own helpers (`progress`, `motionProgress`, `MOTION` in `sim/motion.ts`) do the same in factory time.
- **Work in flight has no fraction.** Neither MACH nor the simulation knows how long an agent, tool call or station visit will take. `agentTimingAt`, `toolCallTimingAt`, `visitTimingAt` and `timingAt` (`sim/selectors.ts`) return only `{ started, startedAt, elapsed, finishedAt, finished }`. Views draw elapsed time (ticks per minute, words), never "x% done"; `spanProgress` is deprecated for open spans. The one filling dial is verification's checks proven of checks declared, a real fraction (`verifyFraction` in `atlas/Bay.tsx`).
- **What changed after a seek**: `changesBetween(fixture, t1, t2)`.
- **Why it looks like this**: `latestEventFor(fixture, ref, t)` and `eventsFor(fixture, ref, t)`, which the inspector shows with each event's telemetry class.
- **Reduced motion**: `animationProgress(..., { reduced: true })` and `motionProgress(..., true)` return the end state for anything started; the store's `reducedMotion` tracks the media query.

### 2.4 How determinism and "nothing shown before it happens" are held

- **Pure engine.** `reduce` (`sim/reducer.ts`) never mutates; it copies what an event touches. `sceneAt` returns the same object for every `t` between two events.
- **No hidden inputs.** No `Math.random`, `Date.now`, timers or wall clock in `src/sim`; `src/scene` reads wall time only through `Clock`. IDs and hashes are FNV-1a over labels (`sim/scenario/recorder.ts`).
- **No early outcomes.** At playhead `t`, the scene and the timeline selectors expose nothing decided after `t`: `cellTimelines(fixture, t)` and `agentTimeline(fixture, id, t)` give open spans `end: null` and no outcome; `moments(fixture, level, t)` lists only what has happened. `finalScene` may be read only for what never changes (names, which columns a layout needs).

The tests (`pnpm --filter @mach/control-tower test`, 63 tests, node's runner, no dependencies):

| Test file | Tests that hold time and determinism |
|---|---|
| `test/reducer.test.mjs` | "the same t gives the same scene, whatever was asked before"; "a fresh index over a copy of the fixture gives equal scenes (no hidden state in the cache)"; "scrubbing backwards shows exactly what playing forwards showed"; "earlier scenes are never changed by later events (structural sharing, no mutation)"; "the scene at t has exactly the events up to t applied"; "cost: index once, then sceneAt is a binary search (measured)" |
| `test/no-early-outcomes.test.mjs` | "the detector works: the final scene, read at an earlier time, is caught leaking"; "the scene at t exposes nothing decided after t"; "cell timelines at t: spans open at t have no end and no outcome; nothing starts after t"; "agent tracks at t: tool calls open at t are running, with no end"; "moments at t are only those that have happened"; "a span that ends in failure reads as plain work until its end" |
| `test/purity.test.mjs` | "src/sim uses no randomness and no wall clock"; "src/scene reads wall time only through the injectable clock"; "the real kinds are exactly intake.py EVENT_TYPES"; "the envelope's fields are the schema's required fields"; "the catalog covers every kind; only real kinds 'exist'; every entry says where" |
| `test/scenario.test.mjs` | "the scenario is deterministic: building it again gives the same bytes"; "seq is strictly increasing by one and time never goes backwards"; and 17 more holding the scenario to how MACH runs |
| `test/store.test.mjs` | "play advances factory time by wall time x rate x speed; pause stops it"; "live-follow pins the playhead to the simulated now; seeking back replays; followLive returns"; "stepping moves event by event and pauses"; "stepping works the same under reduced motion"; "the run ends: playback stops at the duration, and play again replays from the start" |
| `test/pass2.test.mjs` | "hook: the manual clock advances factory time by exact milliseconds, frame by frame"; "hook: back to the live clock, time continues without a leap"; "timing: an agent at work shows only what is known at t; a finished one, its whole span"; the follow-flag tests |

What the tests do not cover: view code. The timeline's model, the Atlas's journeys and the Blueprint's sheet size are computed from the whole run (section 3.5); that they hide the future correctly is checked by the capture scripts and by eye, not by a unit test.

## 3. Rendering each view

### 3.1 Factory Atlas (`atlas/`)

**Layers, back to front** (`AtlasView` in `atlas/index.tsx`):

```
.atlas-viewport  (role="application", one tab stop, pointer, wheel and keys)
├ .atlas-camera  (CSS transform)  L1 <svg> FactoryScene, in this order:
│     PlantLayer (ground, region plates, bridges, tracks)  LiveConduits  IntakeWorks  FreeBays
│     Bay × n (layout order; inside each, children painter-sorted by depthOf)
│     ChamberWorks  GatehouseWorks  IntegrationWorks  ArchiveWorks  AwayAgents
│     Transit (packets, handed artifacts)  Dependencies (cables, unlocks)
├ .atlas-effects  (aria-hidden)   L2 slot: PixiEffects when switched on
├ .atlas-camera-overlay (same transform)  L3 <svg aria-hidden> Overlay: brackets, hover outline,
│     focus ring, near-zoom labels, callouts
├ Sheet   (fixed to the viewport: border, zones, title block, key; not cameraed)
└ .atlas-controls (zoom −, level and %, +, Fit), Meter (development only)
```

**Projection.** The 2:1 dimetric projection is the grammar's (`project`, `planeTransform`, `screenBounds`, `depthOf` in `web/packages/ui/src/factory/projection.ts`; spec b.1). Flat things are drawn in plan coordinates inside a plane transform; upright things are projected in JavaScript. No CSS 3D in the drawing.

**Camera.** `createCamera(bounds)` (`atlas/camera.ts`) is a small store holding `{ x, y, zoom }`, the viewport size, the plant's projected bounds and a `fitted` flag. `set` clamps zoom to 0.35–3 and pans so at least 20% of the plant stays on screen (`clampPan`); `animateTo` eases over `ms` with the standard curve, interpolating the world point at the viewport centre and `log(zoom)`. The view subscribes once and **writes `translate(x px, y px) scale(zoom)` straight to both wrappers' `style.transform`** in the same call, so panning and easing never re-render React. It then schedules at most one React update per animation frame with the latest camera: level of detail (`lodForZoom` with hysteresis), zoom rounded to 0.01, which bays are visible, and whether the camera is at fit. Writers: the person (wheel with zoom to cursor via `zoomAt`, drag, pinch, `+`/`-`/`0`, Shift+arrows, the toolbar), store focus requests, the follow camera, roving keyboard focus (pans just enough to keep the focused entity in view), and the resize observer. Any person-made move calls `store.setFollow(false)`.

**Fit** (`fitAll`): projected bounds of the region plates and the dock; zoom = `min(1.4, (w − 64) / bw, (h − 48) / bh)`; centred across; spare height split 40% above, 60% below. The first measurement fits, then frames the store's selection if there is one; later resizes re-fit when `fitted`, else keep the centre point.

**Levels of detail.** `far` below 0.6, `mid`, `near` above 1.4, hysteresis 0.05 (`lodForZoom`, `factoryTokens.zoom`). Primitives take `lod` and drop or add detail per spec b.7; the Overlay counter-scales its text per level (`LEVEL_K`) so callouts do not move while the camera moves within a level.

**What re-renders when.**

- `PlantLayer` reads the whole scene each event but passes `Plant` captions memoised on their text, so plates and tracks re-render only when a caption, an active flag, the level or route dimming changes.
- `Bay` is memoised per bay and reads its own cell. `LiveBay` subscribes through `usePlayheadKeyed` (`atlas/context.tsx`): its key is the playhead itself while one of the cell's animations runs (`animating`), and otherwise a string of elapsed minutes for the open visit and each working agent, so a settled bay re-renders once per factory minute or at its next event. The component then reads the current playhead at render, so every render is still a pure function of the playhead.
- Progress values passed to primitives are quantised to 1/240 (`q` in `atlas/derive.ts`) so unchanged things keep identical props.
- `Hit` (selectable wrapper) subscribes only to `selection === entity`.

**Culling and batching.** Culling is per bay: a bay whose projected box (with a 64 px margin) is off screen renders only its `CellPlate` (plate, lamp, completion), not its machines, agents, shelf or ticker (`visible` prop). Region works, transit and the overlay are not culled. There is no element batching in the Atlas; the tool ticker caps at 24 ticks and merges the rest into a density bar (grammar rule, spec b.3).

**Layout.** `plantLayout(fixture)` (`atlas/layout.ts`), computed once per fixture and cached; nothing reflows while playing. It is the U of spec b.2:

```
rows = n ≤ 3 ? n : n ≤ 9 ? 3 : 4;   cols = ceil(n / rows)
W = 48 + cols·C.x + (cols − 1)·aisle            C = factoryTokens.size.cell (216 × 148), aisle 56
D = 48 + 40 + rows·C.y + (rows − 1)·cellGap      cellGap 32; the 40 is the lettering strip
bay i: col = floor(i / rows), row = i mod rows,
       origin = (floor.x + 24 + col·(C.x + aisle), 24 + row·(C.y + cellGap))
intake (0, 0, 240, D) │ floor (296, 0, W, D) │ review (floor.x + W + 56, 0, 220, 232)
human (review.x + 40, review.d + 56, 180, 180)
integration y = max(D, human.y + human.d) + 56; archive to its left
```

Bays are assigned from `fixture.definitions.slices` in order, with tickets from `slice.materialized`. Unused slots in the last column are drawn as reserved bays (`freeBays`). Every track is named in `tracks`; journeys between stations (`legsOf`, `atlas/derive.ts`) are computed once per fixture from the events and drawn while their window covers the playhead.

**Follow camera** (`atlas/follow.ts`, spec f.3 as built). Runs only while `cameraFollows(state)` (the store's `follow` flag and `following`) and playback is playing, at most every 4 s (6 s under reduced motion, as a cut). `activeMembers` collects bays with work on the floor, the chamber while a panel sits (`chamberOccupant`), the gatehouse and the yard; `withGrace` keeps a place for 90 factory seconds after its work stops. `followDecision`: nothing moves if the set is inside the inner 70%; frame the whole set if it fits at the person's zoom or up to a quarter further out (never below far + 0.06); otherwise follow one sticky primary at the person's zoom; moves under 12% of the viewport are skipped. The follow camera issues `store.focusOn(ref, "follow")`, which leaves the flag on; the view applies its own pending framing over 900 ms.

**Labels and callouts** (`atlas/Overlay.tsx`). Agent labels sit centred under the agent's floor disc, stacked in seat order when agents share a spot. Callouts are placed deterministically in priority order (escalation, failure, waiting for a person, the event under the playhead), trying six leader directions at 36 then 64 px and taking the first whose leader and label box meet no machine, gate, agent, label or earlier callout; failing that, up-right at 64 px.

### 3.2 Execution Blueprint (`blueprint/`)

**Layers** (`BlueprintView` in `blueprint/index.tsx`):

```
.bp-viewport  (pointer, wheel)
├ .bp-stage  (CSS transform; also carries --bp-gx, --bp-hy, data-lod)
│   <svg> FactoryScene > BlueprintSheet (border, zones, title-block strip)
│     <g role="tree"> WaveItem → LaneView × slices → CellFlow, ExecutionRows, agents, ToolTrace
│                   (or PlaceholderBelt before the wave arrives)
│     DependencyLayer (channel form)
│     gutter layer <g>  ← lane and wave gutters, portalled (gutter.tsx)
│     rows layer <g>    ← row gutters, portalled
│     ColumnHead (pinned by --bp-hy)   Legend   Revisions   PlayheadFact
├ .bp-chrome (outside the camera): ZoneRulers, PinnedTitle, Minimap
└ .bp-controls: zoom −, %, +, Fit
```

**One SVG, one CSS camera.** The camera is `{ x, y, k }` (`blueprint/camera.ts`: `clamp` keeps 20% of the sheet on screen, `fitCamera`, `focusCamera` frames at no more than 2.2× and anchors a tall lane at its top). `apply()` writes the stage's `style.transform`, and two CSS variables: `--bp-gx` (how far the sheet's left edge has scrolled off) and `--bp-hy` (how far the column head has). The gutters translate by `var(--bp-gx)` and the column head by `var(--bp-hy)`, so the gutters stay pinned at the stage's left like a frozen pane and the column head at the top, **with no React work per frame**. `apply()` also publishes the camera to a tiny external store (`createCameraStore` in `blueprint/context.ts`) that only the minimap, rulers and zoom word subscribe to, and updates two pieces of React state only when they change: the level of detail (`overview` below 0.55 with exit at 0.6, `near` above 1.4) and the rendered band (below). Camera easing uses `animate` from `motion/react` (interface motion, 650 ms, or 900 ms for follow).

**Layout.** Two stages, neither per frame:

1. **Columns from one ELK pass** (`loadColumns` in `blueprint/columns.ts`). ELK's layered algorithm is loaded lazily (`elkjs/lib/elk.bundled.js`), given the columns the fixture uses in belt order (`COLUMN_ORDER`, with review as three seat nodes between fan-out and join), and run once per fixture; the result is cached (`useColumns`). Its cost is recorded on the template (`cost.load`, `cost.layout`). `spreadTemplate` scales the column x positions to the sheet's width; the sheet is cut landscape (`SHEET_ASPECT` 1.8) to a height planned from the whole run at the default expansion (`plannedHeight`), so the paper does not grow under a fitted camera.
2. **Lanes and rows by arithmetic** (`computeLayout` in `blueprint/layout.ts`, `flowOf` in `blueprint/flow.ts`). Lanes stack in wave order; expanding one moves only the lanes below. Round 1 runs on the main line; a column that runs again drops `ROW` (80) per repetition; columns the belt has not reached are drawn unbuilt. Each execution has one broken-scale time axis (`execAxis` in `blueprint/axis.ts`: a segment per visit, width growing with the square root of its duration; an open visit's window grows in steps so segments change a dozen times an hour, not per frame); visit rows, agent lanes and tool ticks all sit on it.

The tree (`treeOf` in `blueprint/tree.ts`) is a pure function of the scene, cached per cell state object, so unchanged cells cost nothing between events.

**What re-renders when.** `BlueprintView` itself subscribes to the whole scene (`useScene()`), so it re-renders at every event; `computeLayout` is memoised on the scene, the tree and the expansion set. Rows use a field-by-field memo comparator (`sameRowProps` in `blueprint/rows.tsx`) so a row re-renders only when what it draws changed. Motion hooks return progress quantised to 1/48 (`STEPS` in `blueprint/motion.ts`), so a component re-renders only while its own motion runs. The playhead's text in the title block is its own component (`PlayheadFact`). Selection, hover and dimming are per-item store subscriptions (`useSelected`, `useHovered`, `useDimmed`).

**Culling and batching.** The rendered band is the view plus half a screen above and below, quantised to 200 sheet units (`BandContext`); rows outside it do not render their detail, and tree items mount as the camera or the keyboard comes near. Tool calls are batched: one path per ink and cap shape per agent lane (`ToolTrace` in `blueprint/ticks.tsx`), so a lane of 74 calls is a handful of elements; only the call in flight is a `ToolTick` with its animation. Hit-testing the batched traces uses a registry of call x positions per lane (`createHitRegistry`, `nearestHit`).

**Follow** (`followMove`, `blueprint/index.tsx`). Same flag and cadence as the Atlas; members are each cell's current visit node (or its strip when the lane is closed), kept 90 factory seconds after the visit ends. It never changes the zoom, and it does not run while the camera shows the whole sheet. It moves the camera directly; it does not issue focus requests.

**Labels and callouts.** Labels sit below nodes; long slice titles wrap at spaces (`wrap` in `blueprint/Lane.tsx`) and never truncate. Callouts follow spec c.5.

### 3.3 Timeline (`shell/timeline/`)

`timelineModel()` (`shell/timeline/model.ts`) is computed once from the whole recorded run (`cellTimelines(fixture, fixture.duration)`, `moments`) and never depends on the playhead. The tracks (one per slice, expandable to agent rows, plus a factory track) are drawn on **one canvas** (`drawTracks` in `shell/timeline/draw.ts`), with colours read from the design tokens at draw time (`readPalette`), so 690 tool calls and 93 agents cost a few draw calls, not DOM nodes. Headers, focus and the hover tip are DOM.

The canvas redraws only when what it draws changes: width, time window, expansion, selection, hover, the highlighted cells and slices (subscribed as one string), the theme, or `endsKnown`, the count of station visits that have ended by the live edge (a few dozen changes in the run). **The playhead cursor and the live edge move by direct DOM writes** from a store subscription (`usePlayheadEffect` in `shell/timeline/playhead.ts`), so playback never re-renders the tracks; the ruler slider's `aria-valuetext` is set the same way. Everything beyond the live edge is covered by a hatched DOM mask, outcomes are coloured only once the live edge has passed their end, and hit-testing ignores anything later than `liveAt` (`hitTest`).

### 3.4 The optional light layer (`effects/`)

`PixiEffects` (`effects/index.tsx`), PixiJS 8 with `pixi.js/unsafe-eval` and no workers, loaded as its own chunk only when switched on (`LazyLight` in `shell/Stage.tsx`). It sits in the Atlas's L2 slot, `aria-hidden`, no pointer events, and is not CSS-transformed: each animation frame it reads the store's playhead and the Atlas camera and sets its world container's position and scale. It draws three things, each a pure function of the playhead through the Atlas's own selectors: lamp pools (with `lampPool`, `lampFalloff` and `planeMatrix` from the grammar) plus a bloom, packet trails (`legsInFlight`), and gate washes. While it draws, the SVG lamp pools switch off (`onActive` sets the Atlas context's `lightLayer`), so there is never a double light. It returns `null` under reduced motion and without WebGL.

### 3.5 Things computed from the whole run

The rule is that nothing is *shown* before it happens; some things are *laid out* from the whole run so the picture never reflows. They are: the Atlas plant (`plantLayout`, from the definitions and `slice.materialized`) and its journeys (`legsOf`); the Blueprint's columns (`usedColumns`) and sheet height (`plannedHeight`); the timeline model; the Announcer's and Theater caption's list of major moments; and the inspector's names (`identityOf`). Each is safe against a recorded fixture and each must change for a live stream (section 7).

## 4. Interaction and accessibility

**Selection and focus go through the store.** Clicking or pressing Enter on an entity calls `select(ref, { focus: false })`: selection never moves the camera. Double-click, `F`, the inspector's Focus button and chapter seeks call `focusOn(ref, reason)`; each request carries a new `nonce`, so asking twice re-frames. Both views honour focus requests (`reason` `"select"`, `"chapter"`, `"api"`, `"follow"`); any reason but `"follow"` turns camera follow off. An entity is one string, `EntityRef` (`` `${kind}:${id}` ``, `ref.*` in `sim/model.ts`), the same in every view, the URL (`#blueprint?sel=cell:LOCAL-031`, `useHashSync` in `shell/Shell.tsx`) and the capture hook. After a mode switch the Shell re-requests focus on the selection, and each view's first placement frames it.

**Dependency highlighting.** The store recomputes `highlighted = relatedRefs(sceneAt(playhead), hovered ?? selection)` whenever the subject or the cursor changes, and keeps the same array object when the set is unchanged. `relatedRefs` (`sim/selectors.ts`) gives a slice's or cell's full upstream and downstream dependency set with its edges and cells; an agent's cell, parent, children and current call; a tool call's agent, cell and artifacts; an artifact's writer. The Atlas reads it as a `Set` (`useHighlight`, `isDimmed`); the Blueprint dims a lane only for slice-level subjects (`useDimmed` in `blueprint/Lane.tsx`); the timeline draws highlighted cells and slices as bands.

**Keyboard: one tab stop per view, arrows inside.**

- *Atlas*: the viewport is the tab stop (`role="application"`, `tabIndex=0`); entities are `Hit` groups with `role="button"`, `tabIndex=-1`, an accessible name and `aria-pressed`. Arrow keys move focus through the entities in document (reading) order, region by region, and pan just enough to keep the focused one in view; Shift+arrows pan 80 px; `+`, `-`, `0` zoom and fit.
- *Blueprint*: an ARIA tree. Every selectable thing is a `treeitem` with level, position in set, `aria-expanded` and `aria-selected`; one item holds the roving tab stop (`treeitem.tsx`). Up and Down move through visible items; Right opens or descends; Left closes or ascends; Alt+Right and Alt+Left open and close without moving; Home and End; `*` opens siblings; Enter or Space selects. An item whose lane is far from the camera is not mounted yet, so the view first brings that lane on screen, then focuses it.
- *Timeline tracks*: one `role="application"` canvas; Left and Right step events, Up and Down choose a track, Enter selects.

**The Shell's key table and the handled-event rule.** `KEYMAP` in `shell/keyboard.ts` is the single list; the help sheet renders it, so what is listed is what works. `useShellKeys` installs one `keydown` listener on `window` in the bubble phase, so the views' own handlers run first. It ignores any event whose default is already prevented, and events with Meta or Ctrl, in text fields, or while the help sheet is open; Space and Enter belong to buttons, links and ARIA widgets (`ownsActivation`); Home and End belong to sliders. Views call `preventDefault()` on every key they handle, which is how a view's Escape (clear hover, then selection) runs before the Shell's (hover, selection, then Theater). Keys listed with `view: true` are for discovery only and never handled by the Shell. `useFocusKeeper` (same file) puts focus back in its region (inspector heading, view canvas, stage) when a key removes the focused node or makes its region inert.

**Live regions** (`shell/Announcer.tsx`): two polite regions. One says the transport's state when it changes (playing at n times or paused at a time, live or replay) and the view on a mode switch, never per tick. The other says significant moments while playing: chapters always, other major moments at most one per 4 s of wall time, folding the rest into "and n more". The words are `describe(event)` from the simulation. The Atlas's zoom level text is also `aria-live="polite"`.

**Reduced motion.** The store's `reducedMotion` follows `prefers-reduced-motion`. Factory animations show end states at their event time; camera moves are cuts; follow re-frames by cuts, at most every 6 s; the mode switch is a cut, announced (`Stage`); the light layer is off. Playback still runs and stepping works ("stepping works the same under reduced motion").

**Landmarks.** Skip link to the stage, `header`, `main#stage` labelled with the mode, `aside` for the inspector, `section` for the timeline. Theater Mode makes the header, inspector and timeline `inert`. The Simulation stamp is in the top bar, in Theater Mode, in each view's sheet and in the dev entries.

## 5. The design-system boundary

`@mach/ui/factory` (`web/packages/ui/src/factory`, re-exported from `@mach/ui`) holds the grammar: projection and geometry, motion math (`animationProgress`, `formatElapsed`), the semantic tables (`stations`, `cellStages`, `factoryStates`, `agentRoles`, `gates`, `lodForZoom`, `fc`), and presentational SVG primitives (`FactoryScene`, `CellPlate`, `StationMachine`, `AgentMarker`, `GateGlyph`, `RoutePath`, `RetryLoop`, `BlueprintSheet`, `BlueprintLane`, `Callout`, and the rest in the spec's primitive reference). Primitives take props only, including a `progress`, `elapsed` or `fraction` the caller computed; they read no clock, keep no state and know nothing of events, the store or the simulation. The only React context they use is `useFactoryIds`, for unique `<defs>` ids per scene.

The app holds everything that knows about time and MACH: the simulation, the store, the mapping from simulation words to grammar symbols (`blueprint/vocab.ts`, `atlas/derive.ts`, `shell/vocab.ts`), layout, cameras, interaction and the inspector.

Tokens and themes: `factoryTokens` (projection, grid, elevation, sizes, zoom, motion, budget) in `web/packages/ui/src/tokens/tokens.ts`; 25 factory colour roles as CSS variables `--mach-factory-*` in `web/packages/ui/src/styles/tokens.css`, both themes, contrast-checked by the token script. The Control Tower sets `product="control-tower"` on `ThemeProvider` (`main.tsx`), which defaults to dark and applies its product overrides; `?theme=light|dark` pins it. Components use `fc("role")` or `var(--mach-*)`, never hex; the canvas timeline and the light layer read the same variables at draw time.

## 6. Tradeoffs for the reviewers

### 6.1 One SVG with a CSS camera, not React Flow, for the Blueprint

- **Chosen.** One SVG drawing under one CSS transform; ELK once for the column template; arithmetic for lanes and rows. The reasoning is at the top of `blueprint/index.tsx`.
- **Why.** The Blueprint is a drawing, not an editable node graph: bubbles, diamonds, round rows, retry loops, fan-out and join, dimension lines, rulers, pinned gutters and a title block share one coordinate system. React Flow would wrap each mark in an HTML node with its own layout, selection and focus model, and its edges would have to relearn every path the grammar already draws. One transform keeps text crisp and hit-testing exact, and lets the gutters and column head pin by CSS variable with no React work per frame. It also gives both views the same camera model.
- **Cost.** The brief named React Flow; this departs from it. The minimap, zoom controls, edge drawing, culling and the ARIA tree were written by hand (about 4,600 lines in `blueprint/`). `@xyflow/react` is still a dependency of the app and is imported nowhere. The Blueprint view re-renders at every event (section 3.2), which is fine at 2,126 events over the run but is the first thing to revisit at higher event rates.
- **Revisit when** the Control Tower needs editing of the graph (dragging, connecting), free-form layouts per run rather than fixed belt columns, or graphs far beyond one wave, where React Flow's virtualisation and interaction model would pay for themselves.

### 6.2 SVG only, not the PixiJS/WebGL light layer

- **Chosen.** SVG for everything. The light layer was built, measured and is switchable (help sheet, "Experimental light layer (WebGL)"; off by default; a separate chunk). Two owners recommend against it: the Atlas owner ("measured and judged not to improve on the SVG", `5da2b7d`) and the visual design owner (spec section g).
- **Why, exactly.** (1) In the canvas's place between L1 and L3 the light lies on top of everything in the scene SVG: on the bay floor in dark the bloom veils the machines and agents, which carry the meaning, while the SVG lamp pool already says "work is here" at the right tone. (2) The gate wash barely registers. (3) It costs about 0.8 ms more per frame (design owner's measure, with side-by-sides) for nothing a reader needs. (4) As built it runs its own `requestAnimationFrame` loop for as long as it is mounted, returning early only when nothing changed. (5) It adds a dependency that needs `pixi.js/unsafe-eval` under the CSP and a second rendering path to keep aligned with the camera.
- **What would change the answer** (spec g): light only floors, which means splitting L1 into a floor SVG and a solids SVG with the canvas between them; replace the SVG lamp at the same geometry rather than add to it (already done for pools); stay under 0.3 ms a frame and show something SVG cannot, such as falloff across a plate seam. A second reason to revisit is scale: if the Atlas grows past what SVG can hold (section 7.3), a WebGL renderer for the floor and moving marks becomes a performance decision, not a decoration.

### 6.3 Precomputed scenes, not incremental reduction

- **Chosen.** `indexFixture` reduces the whole fixture once and keeps all 2,127 scenes; `sceneAt` is a binary search.
- **Why.** Seeking anywhere, in either direction, costs nothing (about 0.07 µs per call), scrubbing is exact by construction, and identical `t` gives the identical object, which makes React's `===` checks the change detector. Structural sharing keeps the whole run at about 4 MB of heap and about 5 ms to index (`test/reducer.test.mjs`, Node 25, Apple silicon).
- **Cost.** Memory grows with the event count with no bound; a long-running live factory would retain every scene. It also assumes the whole history is known and ordered: the engine throws on an event earlier than its predecessor.
- **Revisit for production**: keep the reducer and the scene shape, replace "every scene" with checkpoints (a scene every N events or every M minutes) plus forward reduction from the nearest checkpoint, with the most recent scene always held. Seeks then cost at most N reductions. See section 7.2 for live streams.

### 6.4 Canvas timeline tracks, not DOM

- **Chosen.** One canvas for all tracks; DOM for headers, focus, the cursor, the live mask and the tip.
- **Why.** 690 tool calls, 93 agents and their spans would be several thousand DOM nodes in a panel that redraws on hover and selection. On canvas they cost a few draw calls; playback costs no redraw at all, because the cursor and live edge are DOM transforms.
- **Cost.** The canvas content is not in the accessibility tree; it is reached through the track application's keys (step events, choose tracks, select) and the inspector. Colours are re-read from CSS at draw time and the canvas must redraw on theme change (it does). Hit-testing is hand-written (`hitTest`).
- **Revisit when** tracks must carry text a screen reader should browse item by item, or when a second canvas consumer appears and a small canvas scene graph becomes worth sharing.

### 6.5 Simulated event kinds versus what the Factory emits

- **Chosen.** The fixture uses the real envelope and the real 22 kinds unchanged, and adds 29 kinds the picture needs, each catalogued in `sim/catalog.ts` with `telemetry: "exists" | "derivable" | "missing"` and its source.
- **The numbers.** Of the 51 kinds, 22 exist (15 of them occur in the fixture), 25 are derivable and 4 are missing (`workflow.phase`, `station.entered`, `station.left`, `task.started`). Of the fixture's 2,126 events, **75 exist, 1,940 are derivable and 111 are missing**. 1,565 of the derivable ones are agent and tool events that depend on an unverified question: whether the Workflow tool's sub-agents appear in `stream.jsonl` at all (`M6_0_TELEMETRY_GAPS.md` section 7, item 1).
- **Why it matters.** Most of what makes the picture look like a factory is not emitted today. Gap G1 (nothing visible inside an execution) and G2 (stations sampled once per supervisor tick, so a failed verification and its return to build produce no stage change) mean that driven by today's events alone, a cell would sit still for minutes and then jump. G3 (no identity for agents, tool calls or visits) means the inspector could not say who did what.
- **Cost.** The prototype shows what the product could be, not what MACH can feed. The inspector's telemetry badge on each event is the honest marker of that.
- **Revisit** with the proposed event model (`M6_0_TELEMETRY_GAPS.md` section 6): the cell-local station log and the observer-derived agent and tool kinds would move almost all derivable and missing kinds to real sources. The reducer's switch is where each new kind lands.

## 7. From prototype to production

### 7.1 Keep as is

- The scene shape (`sim/model.ts`) and the reducer pattern: pure, immutable, structurally shared.
- The one-store design: playhead, live edge, selection, focus requests with nonce, hover highlight, view, Theater, reduced motion, the single follow flag and `cameraFollows`.
- Motion as a function of `playhead − event time`, the "known timing only" helpers, and the no-early-outcomes test, which should run against the production selectors.
- `EntityRef` as the one name for anything, in every view, the URL and the inspector.
- `@mach/ui/factory` and its boundary (props and progress only), the tokens and both themes.
- Both views' camera model (one CSS transform, written outside React), the Atlas's per-bay keyed re-rendering, the Blueprint's pinned gutters by CSS variable, its band culling and batched ticks, and the canvas timeline with DOM-written cursor.
- The keyboard architecture (one table, handled-event rule, one tab stop per view) and the announcer's rate limiting.

### 7.2 Replace: the fixture and the clock, by an observer and a stream

The `Fixture` becomes a read-only observer's output: a merged, ordered stream built from the ledger stream, a cell-local station stream and stream-derived agent and tool events, as proposed in `M6_0_TELEMETRY_GAPS.md` section 6. The clock becomes real time; `PLAYBACK_BASE_RATE` applies to replay only. Where the hard cases land in this design:

- **Live edge.** `liveAt` becomes "received up to", set by the stream, not by the frame loop. `seek` beyond it must clamp instead of moving it forward (today's `seek` assumes a recorded future).
- **Back-pressure.** The engine appends events in batches, at most once per animation frame, and the store publishes one state change per batch. Subscribers already read narrow slices, so one batch is one commit. The observer coalesces on its side; the browser never asks for more than it can draw.
- **Late and out-of-order events.** The engine today throws on an event earlier than its predecessor. Production must order by occurred time with `seq` as a tie-breaker (gaps document 5.2), accept a bounded lateness window, and on a late arrival recompute scenes from the nearest checkpoint before its time. Views need nothing new: a recomputed scene is a new object, and they re-render from it.
- **Reconnection.** Resume from the last `seq` per stream; duplicates are dropped by `seq`. While disconnected the transport should say so rather than show a frozen "Live".
- **Partial history.** A session may start mid-run: the engine starts from a snapshot scene, not `emptyScene`, and the inspector must say when an entity's earliest events are not loaded.
- **Whole-run computations** (section 3.5) become incremental: the timeline model appends spans; the Blueprint's columns become the static belt order (spec c.2) and the sheet grows, or is planned per wave; the Atlas layout reserves bays per wave and changes only when a wave arrives; `legsOf` is computed per event as it arrives; the announcer reads moments as they arrive.

### 7.3 Scale beyond five slices and one wave

Measured on this branch (development build, headless Chromium, 1440 × 900, dark theme, at fit unless noted; counts are elements inside the active view):

| View, moment | SVG elements | `<text>` | Whole document |
|---|---|---|---|
| Atlas, start | 1,220 | 88 | 1,675 |
| Atlas, build chapter (3 cells) | 2,316 | 103 | 2,873 |
| Atlas, build at far (0.45) / near (1.8) | 1,359 / 2,713 | 44 / 110 | 1,919 / 3,273 |
| Atlas, human gate (peak) | 2,947 | 111 | 3,502 |
| Blueprint, start (unbuilt belt) | 501 | 116 | 956 |
| Blueprint, human gate | 2,482 | 369 | 3,037 |
| Blueprint, end | 2,629 | 390 | 3,185 |

Playing at 16× from 03:20 for 4 s, frame intervals were 16.7 ms at the median and 17.6 ms (Atlas) and 17.3 ms (Blueprint) at the 95th percentile, with a worst frame of 67 ms and 50 ms. These are indicative, not the spec's measured budget run (12 cells, Apple M1); the capture owner's figures are in `M6_0_FINDINGS.md`.

What they say: the spec's budget is 2,500 SVG elements at mid zoom for **12** cells; the Atlas already passes it with **5** slices (2,947 at the human gate). The Atlas needs real culling before more bays: cull region works, transit and overlay by screen bounds as bays are culled, and at mid zoom draw a bay's agents and ticker only when it is near the centre. The Blueprint's band culling scales with lanes but its view re-renders per event; at many waves it needs lane-level memoisation keyed on cell state, and virtualised lanes (mount by band, which it half does). Single-wave assumptions to remove: the Atlas captions read the first wave only (`captionsOf`), the Blueprint tree has one wave root, the timeline's factory track names the first wave. The Atlas layout formula stops at four rows and does not cap columns; past 12 bays it needs a second floor or a paged floor. The timeline canvas scales well in items but its height grows with tracks; past a few dozen tracks it needs a virtualised header list.

### 7.4 Security posture that must carry over

- **Read-only observer.** The browser reads; it never writes under `.factory/` and never calls `run.py` at frequency (gaps document 5.8). Nothing in the Control Tower can enable, start, pause, schedule or approve; per `M5_DESIGN.md` section 8, the Factory console is a separate surface with its own operation list, and nothing in the Product Studio host can be extended into enabling execution by adding a route.
- **Loopback host.** As M5: bound to `127.0.0.1` only, one-time token exchanged for an `HttpOnly`, `SameSite=Strict` cookie, `Host` checks, and the M5 Content-Security-Policy. The prototype already builds under that policy (no inline script or style, no `eval`; Radix's style injection is replaced by a constructable stylesheet, `vite.config.ts`) and makes no network request.
- **Redaction.** Tool inputs and outputs, `Edit` contents, absolute paths, the execution's `spec.json` argv, credential-like values, test output tails and people's names never leave the observer (gaps document 5.7). The simulation already models the boundary: `tool.started` carries only the tool name and a short target. Model-written text (findings, summaries) is shown as text, never rendered as HTML; the prototype uses no `innerHTML`.

### 7.5 Risks

1. **The data may not exist.** 1,565 of the fixture's events depend on whether sub-agent activity appears in `stream.jsonl`. If it does not, the Atlas's agents and tool ticks, and the Blueprint's agent and tool lanes, have no source. Settle gaps document section 7 item 1 before building views on them.
2. **Sampled stations.** Until stations write their own events, a real run cannot show the verification failure loop or correct station timing (G2).
3. **Memory and late events** under a live, unbounded stream (7.2).
4. **DOM budget** already exceeded in the Atlas at five slices (7.3).
5. **Two hand-written cameras and two follow rules** (Atlas and Blueprint) that differ in detail (the Atlas may zoom out by a quarter, the Blueprint never zooms; the Atlas follows through focus requests, the Blueprint directly). A production build should share one camera module.
6. **View determinism is untested.** The simulation's purity is enforced by tests; the views' is by convention and capture.

## 8. File map (`web/apps/control-tower/src`)

| Path | What it is |
|---|---|
| `main.tsx`, `App.tsx`, `index.css` | Entry: `ThemeProvider product="control-tower"`, `?theme=`, the Shell |
| `sim/` | The simulation, the only authority (README.md documents its API) |
| `sim/events.ts` | The factory-event v2 envelope, `REAL_KINDS`, `SIM_KINDS`, `EventDataMap`, `SimEvent` (adds `t`) |
| `sim/catalog.ts` | `EVENT_CATALOG`: every kind's meaning, payload, telemetry class and source |
| `sim/vocabulary.ts` | MACH's own words as data (stations, stages, models, tools), each from its source file |
| `sim/model.ts` | `Fixture`, `Scene` and entity state shapes, `EntityRef`, `ref`, `gateId` |
| `sim/reducer.ts` | `reduce(scene, event)`: pure, structurally shared |
| `sim/engine.ts` | `indexFixture`, `sceneAt`, `sceneAtCursor`, `finalScene`, `cursorAt` |
| `sim/selectors.ts` | Event windows, `changesBetween`, `eventsFor`, `relatedRefs`, timelines, moments, chapters, known timing |
| `sim/motion.ts`, `describe.ts`, `actors.ts` | Playhead motion helpers; one sentence per event; supervisor and scheduler attribution |
| `sim/scenario/` | The deterministic scenario: `story.ts` (storyboard), `belt.ts` (one belt execution), `content.ts` (what it is about), `recorder.ts` (ordering, IDs) |
| `scene/store.ts` | The one store, `cameraFollows`, `PLAYBACK_BASE_RATE`, `SPEEDS`, `window.__machSim` |
| `scene/clock.ts` | `Clock`, `browserClock`, `manualClock`, `switchableClock` |
| `scene/react.ts` | `getSceneStore`, `useSceneStore`, `useScene`, `useSceneActions` |
| `atlas/index.tsx` | `AtlasView`: layers, camera wiring, fit, focus and follow, pointer and keys |
| `atlas/camera.ts`, `follow.ts` | The camera store and framing math; the follow rule |
| `atlas/layout.ts` | `plantLayout`: the U, bays, tracks, bridges |
| `atlas/derive.ts`, `locate.ts` | Pure drawing state from scene and playhead (`anim`, `q`, `animating`, journeys); entity bounds |
| `atlas/context.tsx` | `Hit`, highlight set, `usePlayheadKeyed` |
| `atlas/Plant.tsx`, `Bay.tsx`, `Stations.tsx`, `Air.tsx` | Ground and plates; one cell; intake, chamber, gatehouse, yard, archive; cables and transit |
| `atlas/Overlay.tsx`, `Sheet.tsx`, `Meter.tsx` | L3 brackets, labels, callouts; the drawing sheet; the development frame meter |
| `blueprint/index.tsx` | `BlueprintView` and the React Flow tradeoff note; camera, follow, tree keys |
| `blueprint/columns.ts` | The ELK column template, `spreadTemplate` |
| `blueprint/layout.ts`, `flow.ts`, `axis.ts`, `bounds.ts` | Lanes and rows by arithmetic; a cell's workflow drawing; the per-execution broken time axis; leaf bounds |
| `blueprint/tree.ts`, `treeitem.tsx` | The ARIA tree as data; tree items and the band context |
| `blueprint/Lane.tsx`, `CellFlow.tsx`, `rows.tsx`, `ticks.tsx` | A slice lane; a cell's flow; execution, visit and agent rows; batched tool traces |
| `blueprint/gutter.tsx`, `furniture.tsx`, `overlays.tsx`, `TitleBlock.tsx`, `Placeholder.tsx` | Pinned gutters; column head, legend, revisions; rulers, pinned title, minimap; the live playhead fact; the unbuilt belt before the wave |
| `blueprint/camera.ts`, `context.ts`, `motion.ts`, `time.ts`, `vocab.ts` | Camera math; camera store, layers, hit registry; quantised motion hooks; time words; word-to-symbol mapping |
| `shell/Shell.tsx` | The frame: grid, panels, hash sync, Theater inerting, the light switch state |
| `shell/Stage.tsx` | The active view and the mode-switch transition (a cut under reduced motion) |
| `shell/keyboard.ts`, `HelpSheet.tsx` | `KEYMAP`, `useShellKeys`, focus keeper; the generated help sheet and light switch |
| `shell/Announcer.tsx`, `Theater.tsx`, `chrome.tsx`, `glyphs.tsx`, `vocab.ts` | Live regions; Theater overlays; brand, Simulation stamp, mode switch; state glyphs; words |
| `shell/timeline/` | `Timeline`, `Transport`, `Ruler` (slider), `Tracks` (canvas), `draw.ts`, `model.ts`, `playhead.ts` |
| `shell/inspector/` | `Inspector`, per-entity `anatomies`, `entity.ts` (names), `parts.tsx` (telemetry badge, Go to event), `RunNow` |
| `effects/index.tsx` | `PixiEffects`, the optional WebGL light layer |

Outside `src`: `dev/atlas.html` and `dev/blueprint.html` (single-view development entries, not built), `test/` (the suites above and `_load.mjs`, which lets node run the TypeScript sources), `scripts/` (capture, being written by the capture owner).
