# The Living Factory simulation (`src/sim`) and the one store (`src/scene`)

**This is a simulation.** Everything here comes from one deterministic fixture. It reads no Factory state, starts nothing, and makes no network request.

`src/sim` is the only authority on what is happening (M6_0_CONTRACT.md, rule 1). The scene at playhead time `t` is a pure function of the fixture's events up to `t`. Atlas, Blueprint, the timeline, the inspector and any WebGL layer render that one scene, and none keeps progress of its own. `src/scene` is the one store: the playback clock, selection, focus, hover, view mode and Theater Mode.

Import from `src/sim/index.ts` (`../sim`) and `src/scene/index.ts` (`../scene`) only. Anything deeper may move.

## Contents

1. [Quick start for a view](#1-quick-start-for-a-view)
2. [The public API](#2-the-public-api)
3. [The event model](#3-the-event-model)
4. [The scene](#4-the-scene)
5. [Deriving animation from events and the playhead](#5-deriving-animation-from-events-and-the-playhead)
6. [The store](#6-the-store)
7. [The event catalog](#7-the-event-catalog)
8. [The scenario and its storyboard](#8-the-scenario-and-its-storyboard)
9. [Cost, determinism and tests](#9-cost-determinism-and-tests)

## 1. Quick start for a view

```tsx
import { SCENARIO, eventsInWindow, progress, MOTION, type SimEvent } from "../sim";
import { useScene, useSceneStore, useSceneActions } from "../scene";

function CellCard({ ticketId }: { ticketId: string }) {
  const cell = useScene((scene) => scene.cells[ticketId]);   // same object until this cell changes
  const t = useSceneStore((s) => s.playhead);                 // factory ms
  const reduced = useSceneStore((s) => s.reducedMotion);
  const { select } = useSceneActions();
  if (!cell) return null;                                     // not dispatched yet at this moment
  // A gate closing: motion is a function of t - event.t, so scrubbing shows the right frame.
  const verdict = eventsInWindow(SCENARIO, t, MOTION.gate, ["verification.verdict"]).find((e) => e.ticket_id === ticketId);
  const closing = verdict ? (reduced ? 1 : progress(t, verdict.t, MOTION.gate)) : 0;
  return <button onClick={() => select(`cell:${ticketId}`)}>{cell.title}: {cell.stage} ({closing})</button>;
}
```

## 2. The public API

### Data

| Export | What it is |
|---|---|
| `SCENARIO: Fixture` | The M6.0 run (section 8). Built once at module load; deterministic. |
| `buildScenario(): Fixture` | Builds it again (tests compare the two byte for byte). |
| `EVENT_CATALOG: Record<EventKind, CatalogEntry>`, `CATALOG_ENTRIES` | Every kind: meaning, payload, telemetry class, source (section 7). |
| `REAL_KINDS`, `SIM_KINDS` | The 22 kinds MACH emits today (`intake.EVENT_TYPES`), and the 29 the simulation adds. |
| `STATIONS`, `CELL_STAGES`, `STEP_ACTIONS`, `ACTION_STATION`, `NEXT_ACTIONS`, `STAGE_TRANSITIONS`, `SCHEDULER_STATES`, `MODELS`, `TIER_MODEL`, `AGENT_ROLES`, `AGENT_TYPES`, `REVIEW_SEATS`, `PANELS`, `MAX_ROUNDS`, `BELT_PHASES`, `TASK_KINDS`, `TASK_STEP`, `TOOLS`, `GATE_KINDS`, `ARTIFACT_KINDS` | MACH's vocabulary as data, each copied from the file named beside it in `vocabulary.ts`. |
| `PEOPLE`, `PROJECT`, `WAVE`, `TICKETS`, `SLICE_IDS`, `SCENARIO_START`, `isoAt(t)` | Scenario constants. |

### The scene

| Signature | Notes |
|---|---|
| `sceneAt(fixture: Fixture, t: number): Scene` | The complete scene at playhead `t` (factory ms from the start). Returns the **same object** for every `t` between two events. |
| `sceneAtCursor(fixture, cursor): Scene` | The scene after exactly `cursor` events. |
| `finalScene(fixture): Scene` | After every event. |
| `cursorAt(fixture, t): number` | How many events have happened at `t` (`event.t <= t`). |
| `indexFixture(fixture): SimIndex` | The cached index (all scenes, entity index). Rarely needed directly. |

The signature takes the `Fixture`, not a bare event array: titles, risks and app types come from `fixture.definitions`, the approved product definitions that the events' `refs` point at, which is where a real Control Tower would read them. Pass `SCENARIO`.

### Selectors (all pure)

| Signature | Use |
|---|---|
| `eventsBetween(fixture, from, to): SimEvent[]` | Events with `from < e.t <= to`. |
| `eventsInWindow(fixture, t, windowMs, kinds?)` | The last `windowMs` before `t`, optionally by kind. The basis of every factory animation. |
| `changesBetween(fixture, t1, t2): Changes` | `{ direction: "forward" \| "backward" \| "none", events, refs }`: what to animate in or out after a seek. |
| `eventsFor(fixture, ref, t?)` | The events behind an entity, oldest first; with `t`, only those that have happened. The inspector's "why". |
| `latestEventFor(fixture, ref, t)` | The one event that explains an entity's current look. |
| `eventBySeq(fixture, seq)`, `refsOfEvent(fixture, seq)` | Look up an event; the entities it touches. |
| `nextEventTime(fixture, t)`, `previousEventTime(fixture, t)` | For stepping. `null` at the ends. |
| `entityAt(scene, ref): EntityState \| null` | Any entity by reference, as `{ kind, value }`. `null` if it does not exist at this moment. |
| `allAgents(scene)`, `activeAgents(scene)`, `toolCallsInFlight(scene)` | Flattened across cells (cached per `scene.cells` object). |
| `findAgent`, `findToolCall`, `findArtifact`, `cellsAtStation(scene, station)` | Lookups. |
| `relatedRefs(scene, ref): EntityRef[]` | The highlight set: for a slice or cell, the slice's full upstream and downstream dependency set with edges and cells; for a dependency link, its chain (both ends with their cells, everything the prerequisite waits for, and everything that waits on the dependent, transitively; a sibling prerequisite of the dependent is not in it); an agent's cell, parent, children and current call; a tool call's agent, cell and artifacts; an artifact's cell, writer agent and call; a gate's cell. The store uses it for `highlighted`. |
| `cellTimelines(fixture, t)`, `cellTimeline(fixture, ticket, t)` | As known at `t`: station spans, stage changes, agent spans with a non-overlapping `row`, and the cell's moments. A span still open at `t` has `end: null` and no outcome; nothing that starts after `t` is listed. Pass `fixture.duration` for the whole recorded run, and then hide what lies beyond the live edge, never colouring a span by an outcome later than the edge. Cached per scene. |
| `agentTimeline(fixture, agentId, t)` | An agent's span and its tool-call spans as known at `t` (open calls `running`, `end: null`). |
| `moments(fixture, atLeast = "major", t?)` | Events at or above a significance, each with a sentence (`describe`) and its refs. Timeline markers. With `t`, only those that have happened. |
| `chapters(fixture)`, `chapterAt(fixture, t)` | The 14 named chapters (section 8), each with a `focus` ref for the camera. |
| `describe(event): string` | One plain sentence per event, for the inspector, tooltips and screen readers. |
| `agentTimingAt(agent, t)`, `toolCallTimingAt(call, t)`, `visitTimingAt(visit, t)`, `timingAt(startedAt, finishedAt, t)` | What is **known** about work at `t`: `{ started, startedAt, elapsed, finishedAt, finished }`. Nothing predictive (see section 5). |
| `actorOfEvent(fixture, seq): AnyRef \| null` | `actor:supervisor` or `actor:scheduler` for an event they wrote, else `null`. |

### Motion helpers

`progress(t, start, duration)`, `spanProgress(t, start, end, expected)` (deprecated for open spans: its `expected` is a guess), `ease(x)`, `easeOut(x)`, `motionProgress(t, start, duration, reducedMotion)`, and `MOTION` (standard lengths in factory ms: `travel` 20 s, `gate` 8 s, `appear` 6 s, `afterglow` 30 s).

### Entity references

One string names anything selectable: `` `${kind}:${id}` `` (`EntityRef`). Build them with `ref.cell("LOCAL-031")` etc.; read them with `refKind`, `refId`; gate IDs with `gateId(ticket, gate, round?)`.

| Kind | Example |
|---|---|
| `wave` | `wave:WAVE-007` |
| `slice` | `slice:SLICE-021` |
| `cell` | `cell:LOCAL-031` |
| `station` | `station:LOCAL-031/build` (one cell's visits) or `station:build` (the station) |
| `execution` | `execution:x4856eca1812e` |
| `agent` | `agent:ag-031-07` |
| `tool` | `tool:tc-031-0042` |
| `artifact` | `artifact:LOCAL-031:plan.md`, `artifact:LOCAL-031:commit:3f2a9c1` |
| `gate` | `gate:LOCAL-031/audit`, `gate:LOCAL-031/verification#1`, `gate:LOCAL-032/review#2`, `gate:LOCAL-032/human-approval`, `gate:LOCAL-031/merge-revalidation`, `gate:LOCAL-031/red-before-green`, `gate:LOCAL-031/plan-check` |
| `dependency` | `dependency:SLICE-024->SLICE-021` (the first waits for the second) |
| `finding` | `finding:LOCAL-032/r1/security/1` |

### Actors: the supervisor and the scheduler

The line supervisor and the scheduler act in the record without being agents, so they have identities of their own: `actor:supervisor` and `actor:scheduler` (`ActorRef`; `ref.actor(id)`, `isActorRef(s)`, `ACTORS`). Attribution is by kind, from the real emitters (`ACTOR_KINDS`, `actorOf(event)`):

| Actor | Real code | Kinds |
|---|---|---|
| `actor:supervisor` | `supervisor.py` (`Supervisor.once`, `observe`, `decided`, `start`, `recover`, `finish`, `park`) | `revision.discovered`, `scheduling.decided`, `work.claimed`, `execution.started`, `station.observed`, `recovery.started`, `execution.completed`, `execution.failed`; `human.required` when the supervisor parks a ticket |
| `actor:scheduler` | `intake.py` (`Factory.plan`, `record`, `dispatch`, `open_cell`) | `dependency.resolved`, `dependency.blocked`, `slice.integrated`, `work.scheduled`; `human.required` from the recorded plan (reason `waiting for ...`) |

Intake's own kinds (`wave.discovered`, `intake.validated`, `slice.materialized`), the engineer's commands and the stations' facts belong to no actor. In the fixture every attributed event has `source: "supervisor"`, because both act inside the supervisor's tick.

`scene.actors.supervisor` and `scene.actors.scheduler` hold `{ id, title, code, acts, lastActedAt, lastSeq, lastKind }`. `entityAt(scene, "actor:scheduler")` returns `{ kind: "actor", value }`; `eventsFor(fixture, "actor:scheduler", t?)` and `latestEventFor` work as for any entity, so a figure can light on its own events and the inspector can say why.

`"actor"` is an `EntityKind`, so `actor:supervisor` and `actor:scheduler` are ordinary `EntityRef`s: the store can select and focus them. The Atlas frames the supervisor's console and the scheduler's desk; the Blueprint has no actor mark, so a focus request for an actor is a no-op there (no camera move).

**No early outcomes.** At playhead `t`, nothing the scene or the timeline selectors expose is derived from an event later than `t`: no outcome, end time, verdict, vote or decision shows before its event (`test/no-early-outcomes.test.mjs` walks every time field and outcome for a sample of times, including one millisecond before each deciding event). `finalScene` is the end of the run; read it only for what does not change (names, which stations a layout needs), never to colour or label work at an earlier time.

## 3. The event model

The envelope is the real Factory event, version 2 (`docs/mach-next/schemas/factory-event.schema.json`, written by `intake.py Factory.emit`), field for field: `schema_version`, `seq`, `at`, `type`, `project_id`, `source_commit`, `wave_id`, `slice_id`, `revision`, `ticket_id`, `runner_id`, `execution_id`, `source`, `cause`, `refs`, `data`. These are the schema's names, which M6_0_CONTRACT.md section 4 also uses.

The simulation adds one field, `t`: milliseconds since the scenario's start. `at` is what MACH writes (UTC, whole seconds, `YYYY-MM-DDTHH:MM:SSZ`) and is too coarse to order or animate by, so the engine uses `t`. Tests check that removing `t` leaves exactly the schema's required fields.

- **Real kinds** (`REAL_KINDS`, 22) are used unchanged, with exactly the `data` fields their real emitter writes (checked by test against `intake.py`). Their `cause` is `null`, because no MACH emitter sets it today.
- **Simulation kinds** (`SIM_KINDS`, 29) are what the experience needs and MACH does not emit: workflow, station, stage, agent, tool, artifact, gate, task, test, verification, review, merge and cleanup events. They set `cause` where one event led to another. Their `source` stays within the schema's enum (`supervisor` for work inside an execution, `engineer` for the person's approval).
- `switch (event.type)` narrows `event.data` (`AnySimEvent` is a discriminated union).

The beats the brief names, and the kind that carries each:

| Beat | Kind |
|---|---|
| Wave arrives / becomes tickets | `wave.discovered`, `intake.validated`, `slice.materialized` (real) |
| Scheduler decisions; waiting and why | `dependency.blocked`, `dependency.resolved`, `scheduling.decided` (real) |
| Slice eligible / dependency satisfied | `dependency.resolved` (real); edges turn `satisfied` on `slice.integrated` (real) |
| Dispatched | `work.scheduled` (real) |
| Execution / workflow started | `work.claimed`, `execution.started` (real); `workflow.started`, `workflow.phase`, `workflow.finished` |
| Station entered / left | `station.entered`, `station.left`; stage written: `cell.stage_changed`; sampled by the supervisor: `station.observed` (real) |
| Agent started / finished (role, seat, tier) | `agent.started`, `agent.finished` |
| Tool call started / finished | `tool.started`, `tool.finished` |
| Artifact written | `artifact.written` |
| Gates with no event of their own | `gate.checked` (audit at build start, `cell.py check-plan`) |
| TDD red / green | `task.started`, `task.red`, `task.green`, `task.done` |
| Test result | `test.result` |
| Return to build | `build.revised` |
| Evidence captured; verdict | `verification.started`, `evidence.captured`, `verification.verdict` |
| Findings, votes, consensus | `review.started`, `review.finding`, `review.vote`, `review.decided` |
| Human approval requested / recorded | `human.required` (real); `human.approval_recorded` |
| Merge revalidation; merged | `merge.revalidated`, `merge.completed` |
| Integrated | `slice.integrated` (real) |
| Cleanup | `cleanup.completed` |

## 4. The scene

`Scene` (all plain, serialisable data; never mutate it):

| Field | Contents |
|---|---|
| `cursor`, `at`, `lastSeq` | Events applied, time and seq of the last one. |
| `project`, `factory` | Project; whether the Factory is enabled, autonomy, by whom, limits, the product commit read. |
| `supervisor` | `lastDecision` (dispatched, started, held with why), `attention` (what a person must decide, by ticket or slice). |
| `waves[id]` | Title, slices, who approved and when, `discovered` or `validated`. |
| `slices[id]` | Title, summary, risk, ticket, `dependsOn`, scheduler state (`materialized`, `waiting-on-dependency`, `eligible`, `dispatched`, `integrated`), the scheduler's own `reasons`, history. |
| `dependencies["A->B"]` | `from` waits for `to`; `blocking` or `satisfied`, and when. |
| `cells[ticket]` | See below. Exists from the moment intake opens the cell; stays (with `archived` set) after cleanup. |
| `executions[id]` | Claim, start, the workflow's phase, end, outcome and cost. |
| `gates[id]` | `open`, `passed`, `failed`, `waiting` (human approval) or `skipped` (no revalidation needed), with detail and times. |
| `counters` | Events, agents active and started, tool calls active and total, artifacts, commits, test runs, checks passed and failed, verification failures, review rounds, blockers, notes, human approvals, merged, integrated, executions running, cost so far. |

`CellState`: `stage` (what the station scripts last wrote) and `observedStage` (what the supervisor last sampled; it lags), `stageHistory`; `station`, `action` and `stationSince` (null between stations: the belt is asking "what next?"); `visits` (every station visit with round and outcome); `round` (1 to 3) and `loop`; `executionId`, `workflowPhase`; `suite`, `lastTest`, `testsRun`; `tasks` (status `active`, `red`, `green`, `done`, with commit); `verifications` (per round: every check with result, evidence and note); `reviews` (per round: seats with model, agent and vote; findings with `outvoted`; outcome; delta; human approval); `agents` (by ID, with `agentOrder` and `activeAgentIds`); `artifacts` (in write order, with version and writer); `merged`; `archived`.

`AgentState`: role, `agentType` (`mach:builder` etc. or null), seat, tier, model, effort, label (as belt.js labels it), `parentId` (the contract engineer's parent is the plan worker), phase, station, status, times, `currentToolCallId` and `toolCalls` (each with tool, short target, times, status and the artifacts it produced).

## 5. Deriving animation from events and the playhead

Rule: **factory motion is a function of `t - event.t`**. Never animate factory progress with a timer, a spring or `motion/react`; those are for interface transitions (inspector, camera easing, mode change).

1. Read state from `sceneAt` (or `useScene`): where things are now.
2. Read recent events with `eventsInWindow(SCENARIO, t, MOTION.travel, kinds)`: what is moving now, and since when.
3. Compute `progress(t, event.t, duration)` and draw that frame. When `t` moves backwards past `event.t`, the event drops out of the window and the motion is undone automatically.
4. **Work in flight has no completion fraction.** Neither MACH nor the simulation knows how long an agent, a tool call or a station visit will take, so a view must not draw "x% done" (a filling arc, a progress bar) for open work, and must not divide elapsed time by an expected length per role or station. Show what is known: `agentTimingAt(agent, t)`, `toolCallTimingAt(call, t)` and `visitTimingAt(visit, t)` give `started`, `startedAt`, `elapsed` and, once it has happened, `finishedAt`. Draw elapsed time (a counter, ticks per minute, an arc that grows without a fixed end) or a plain "at work" state. A completed span may be drawn whole. `spanProgress` is deprecated for open spans.
5. After a seek, `changesBetween(SCENARIO, previousT, t)` says what appeared or disappeared, in which direction, for a single cross-fade.
6. Under `prefers-reduced-motion` (`store.reducedMotion`), use `motionProgress(..., true)`: anything started is shown at its end state, with no travel or looping.
7. Every visible change must trace to an event: show `latestEventFor(SCENARIO, ref, t)` (and `describe(event)`) in the inspector.

Examples: a packet travelling from build to verify is the `station.entered` (verify) event, drawn for `MOTION.travel`; a gate closing is `verification.verdict` or `review.decided`; a tool spark is a `tool.started` to `tool.finished` span; the reviewer fan-out is three `agent.started` events with `seat` set, under one `review.started`; the dependency edge turning is `slice.integrated` for its `to` slice, followed on the same tick by `dependency.resolved` and `work.scheduled` for its `from` slice.

## 6. The store

`src/scene` holds one store for the whole app: `getSceneStore()` (the scenario on the browser clock, reduced motion from the media query, and the dev hook installed in development and capture builds). React bindings, on `useSyncExternalStore` with no other dependency:

| Hook | Returns |
|---|---|
| `useSceneStore(selector)` | A slice of the store state. The selector must return a stable value (a field, or an object taken from the scene). |
| `useScene()` / `useScene(selector)` | `sceneAt(fixture, playhead)`, or part of it; re-renders only when the selected value changes. |
| `useSceneActions()` | The actions below (stable). |
| `usePlaybackKeys(enabled?)` | Optional defaults: Space plays or pauses, Shift+Left and Shift+Right step by event. The shell owns the keyboard map and may ignore this. |
| `SceneStoreProvider` | Give a subtree its own store (tests, previews). |

State (`SceneStoreState`): `fixture`, `playhead` (factory ms), `liveAt` (the simulated now), `following` (live-follow), `playing`, `speed` (0.5, 1, 2, 4, 8 or 16), `cursor`, `selection`, `focus` (`{ target: EntityRef | "overview", reason, nonce }`), `hovered`, `highlighted`, `view` (`"atlas" | "blueprint"`), `theater`, `reducedMotion`, `follow` (camera follow).

Actions: `play()`, `pause()`, `toggle()`, `seek(t)`, `seekToSeq(seq)`, `seekToChapter(id)`, `stepNext()`, `stepPrevious()` (by event; pause playback), `setSpeed(s)`, `followLive()`, `select(ref | null, { focus? })` (selecting also requests focus unless `focus: false`), `focusOn(ref | "overview", reason?)`, `hover(ref | null)`, `setView(v)`, `setTheater(on)`, `setReducedMotion(on)`, `setFollow(on)`, `dispose()`.

Camera follow (one flag for both views and the Shell): `follow` is on by default. It goes off when the person pans or zooms (the view calls `setFollow(false)`) and when the camera is asked to frame something (`focusOn` with any reason but `"follow"`, so also `select` with focus and `seekToChapter`). It comes back on with `followLive()` (return to live) or `setFollow(true)`. The camera follows the live action only when `cameraFollows(state)` is true: `follow` is on **and** the playhead is live (`following`). Whether it also needs `playing` is the view's choice. Theater Mode changes neither `follow` nor `following`: it does not force live. A view's own follow camera should request focus with reason `"follow"`, which leaves the flag on.

Playback: at 1x, one wall second is `PLAYBACK_BASE_RATE` (10) factory seconds, so the 55:50 run plays in about 5.5 minutes at 1x and 21 seconds at 16x. The clock is driven by `requestAnimationFrame` through an injectable `Clock` (`browserClock()`, or `manualClock()` for tests and capture). A frame gap is capped at 250 ms so a background tab does not leap.

Live-follow and replay: `liveAt` is how far the simulated factory has run; it advances whenever playback runs. While `following`, the playhead is pinned to it. Seeking or stepping to an earlier moment turns following off (replay): the replay plays on at the same speed while the factory keeps running ahead. `followLive()` jumps back. Seeking past `liveAt` moves it forward (the fixture is recorded, so the future exists). At the end, playback stops; `play()` again replays from the start.

Focus: a request both views honour. `nonce` changes on every request, so selecting the same thing twice re-frames it. Chapters carry a `focus` ref, which `seekToChapter` requests.

Hover and selection: `highlighted` is `relatedRefs` of the hovered entity, or else of the selection, at the playhead.

### `window.__machSim` (development and capture builds only)

Installed when `import.meta.env.DEV` or the build mode is `capture` (`vite build --mode capture`); never in a production build, which also keeps the plain browser clock. In development and capture builds the store runs on a `switchableClock(browserClock())`, which the capture script can switch to manual time.

```js
const sim = window.__machSim;
// Version 1: seeking and reading (unchanged)
sim.version;            // 1
sim.duration;           // factory ms
sim.eventCount;
sim.chapters;           // [{ id, title, t, seq }]
sim.seek(t);            // factory ms
sim.seekToSeq(seq);
sim.seekToChapter("human-gate");
sim.step(n);            // n events forward, or back if negative; pauses
sim.play(); sim.pause(); sim.setSpeed(4);
sim.state();            // { playhead, liveAt, following, playing, speed, cursor, view, theater, selection,
                        //   follow, focus, reducedMotion, clock: "live" | "manual" | "fixed" }
// Driving the app (pass 2)
sim.select("cell:LOCAL-031");   // or null; also frames it (and releases camera follow)
sim.focus("gate:LOCAL-032/human-approval");  // or "overview"
sim.setMode("blueprint");       // or "atlas"
sim.setTheater(true);
sim.setFollow(true); sim.followLive();
// Rendering frame by frame
sim.useManualClock();           // browser frames no longer move time
sim.clockMode();                // "manual"
sim.play();
sim.advance(0);                 // first frame: sets the reference time
sim.advance(1000 / 30);         // one 30 fps frame: factory time += 33.3 ms x 10 x speed
sim.advance(5000, 1000 / 60);   // 5 s of wall time in 60 fps frames
sim.useLiveClock();             // back to browser frames; time continues without a leap
```

`advance(ms, frameMs = 250)` delivers frames of at most `frameMs` (the store treats a frame longer than 250 ms as 250 ms), so the total moved is exactly `ms` of wall time, which is `ms x PLAYBACK_BASE_RATE x speed` of factory time while playing. The same calls from the same state always give the same frames. Rendering between frames is the capture script's job (for example, wait for the next animation frame after each `advance`). `advance` and the clock switches throw when the store's clock cannot be switched (`clockMode()` is then `"fixed"`).

## 7. The event catalog

`catalog.ts` holds one entry per kind: `meaning`, `payload`, `telemetry`, `source` (file and function), `missingFields` where a derivable source does not hold everything shown, `proposedAs` where the telemetry analyst's gap document proposes a name, and `significance` (`chapter`, `major`, `minor`, `ambient`) for timeline markers.

- **exists**: MACH emits it today in `.factory/intake/events.jsonl`. Only the 22 `intake.EVENT_TYPES` kinds.
- **derivable**: no event, but the fact is on disk and an observer could make one without changing MACH: a station's own record (`cell.json`, `build.json`, `evidence/*.json`, `review/round-N/*`), Git, or the execution's `stream.jsonl` (kept whole; `executor.outcome` parses only its result).
- **missing**: recorded nowhere MACH or Claude Code is known to keep it.

| Kind | Telemetry | Where it exists or could come from |
|---|---|---|
| 22 real kinds | exists | `intake.py` (`_intake`, `materialize`, `record`, `open_cell`), `supervisor.py` (`once`, `decided`, `start`, `observe`, `recover`, `finish`, `park`), `activation.py` |
| `workflow.started` | derivable | `stream.jsonl` tool_use named `Workflow` |
| `workflow.phase` | missing | belt.js `phase()` is not persisted; whether it reaches the stream is unverified |
| `workflow.finished` | derivable | the stream's result; `executor.outcome` keeps 4 fields per ticket |
| `station.entered`, `station.left` | missing | no stage history or visit record; approximations from `build.json started_at`, `results.json started_at`, `packet.json started_at`, `decision.json decided_at`, `merged.at` |
| `cell.stage_changed` | derivable | watch `cell.json` (`station.observed` is the sampled real form) |
| `agent.started`, `agent.finished`, `tool.started`, `tool.finished` | derivable | `stream.jsonl` (`task_*`, `parent_tool_use_id`, `tool_use`/`tool_result`), if the Workflow tool's agents appear there: unverified |
| `artifact.written` | derivable | file mtimes, commits; the writer only from the stream |
| `gate.checked` | derivable | `build.json audit`, `audit-report.json`; `cell.json` stage `planned` |
| `task.started` | missing | `build.py next` records nothing |
| `task.red`, `task.green`, `task.done`, `build.revised` | derivable | `build.json tasks[]`, commits, `review-findings-N.md` |
| `test.result` | derivable | `build.json test_run`; counts only in raw logs |
| `verification.started`, `evidence.captured`, `verification.verdict` | derivable | `evidence/results.json`, `summary.json` |
| `review.started`, `review.finding`, `review.vote`, `review.decided` | derivable | `review/round-N/packet.json`, `votes/<role>.json`, `decision.json` |
| `human.approval_recorded` | derivable | `decision.json human_approval` |
| `merge.revalidated`, `merge.completed` | derivable | `cell.json revalidated`, `merged` (nothing is written when no revalidation is needed) |
| `cleanup.completed` | derivable | archive and `runs.jsonl` |

The fixture's 2,126 events by class: **exists 75, derivable 1,940, missing 111** (`workflow.phase` 34, `station.entered` 26, `station.left` 25, `task.started` 26). Of the derivable ones, 1,565 (agents and tool calls) depend on the unverified question of whether workflow sub-agents appear in `stream.jsonl` (M6_0_TELEMETRY_GAPS.md section 7, item 1).

## 8. The scenario and its storyboard

One approved delivery wave, `WAVE-007` "Invoicing: get paid on time" (epic EPIC-004, approved in Product Studio by Maya Lindqvist), for "Tally", a B2B billing web app. Priya Raman enables the Factory (supervised, `max_parallel` 3, merging allowed, `poll_seconds` 60). Daniel Okafor, who owns payments, signs off the High-risk change.

| Slice | Ticket | Risk | Waits for | What happens |
|---|---|---|---|---|
| SLICE-021 Invoice list with status filters | LOCAL-031 | Medium | | Verification fails on R4 (an invoice due today listed as overdue), revise round 2, passes, review round 2 approves 3 of 3, merged with revalidation |
| SLICE-022 Charge a saved card for an open invoice | LOCAL-032 | High | | Changes an existing contract (`payments.proto`); review round 1 rejected by a security blocker (INV-02: a timed-out charge could charge twice); delta review round 2 approves 3 of 3; stops for a person; approved; a second execution merges it with revalidation |
| SLICE-023 Download an invoice as a PDF | LOCAL-033 | Medium | | First-pass: approved 2 of 3 with the product seat's blocker outvoted (reported, not hidden); first to merge, no revalidation |
| SLICE-024 Email a reminder when an invoice becomes overdue | LOCAL-034 | Medium | SLICE-021 | Waits; becomes eligible and is dispatched on the tick after SLICE-021 is integrated; still building at the end |
| SLICE-025 Pay-now link in overdue reminders | LOCAL-035 | High | SLICE-022, SLICE-024 | Waits throughout |

Each execution runs `mach:belt` for one ticket, as the supervisor starts it: preflight clerks (locate run.py, check the project, read the board), then for every step a Haiku clerk running `run.py next <ticket> --headless`, then the worker it names: the plan worker on Opus with the `contract-engineer` sub-agent; `mach:builder` on Sonnet doing red and green task by task through `build.py`; `mach:verifier` on Sonnet driving Playwright and recording each scenario and matrix rule through `verify.py`; a clerk seating the panel, three `mach:reviewer` seats at once (Opus for High risk, Sonnet otherwise), a clerk tallying; Haiku workers for merge and cleanup; then the Learn phase's clerk. The supervisor's records (`station.observed`, `execution.completed`, `slice.integrated`, `dependency.*`, `human.required`, claims and starts, `scheduling.decided`) fall on its 60-second ticks.

Scenario time zero is 2026-11-10T14:00:00Z. Duration 55:50 (last event 55:30, plus a 20-second hold). 2,126 events, 93 agents (up to 6 at once), 690 tool calls, 171 artifacts.

### Chapters (`fixture.chapters`)

| Time | Chapter | Focus |
|---|---|---|
| 00:00 | `enabled`: The Factory is enabled | overview |
| 00:30 | `wave`: An approved wave arrives | `wave:WAVE-007` |
| 00:31 | `dispatch`: Three cells start | `wave:WAVE-007` |
| 01:22 | `plan`: Contracts and plans | `cell:LOCAL-031` |
| 06:55 | `build`: Test-first construction | `cell:LOCAL-031` |
| 21:10 | `verify`: Verification | `cell:LOCAL-033` |
| 24:23 | `review`: Review panels | `cell:LOCAL-033` |
| 27:11 | `integrate`: First work lands | `cell:LOCAL-033` |
| 27:19 | `verify-fail`: R4 fails, back to build | `gate:LOCAL-031/verification#1` |
| 32:08 | `blocker`: A security blocker | `gate:LOCAL-032/review#1` |
| 43:30 | `unblocked`: SLICE-024 is free to start | `dependency:SLICE-024->SLICE-021` |
| 46:42 | `human-gate`: A person must approve | `gate:LOCAL-032/human-approval` |
| 51:57 | `approved`: Daniel Okafor approves | `gate:LOCAL-032/human-approval` |
| 54:20 | `last-merge`: Revalidated and merged | `cell:LOCAL-032` |

Exact times are in `SCENARIO.chapters` (use those, not this table, in the capture script).

### Storyboard (key beats; mm:ss and seq)

| Time | Seq | Kind | Beat |
|---|---|---|---|
| 00:00 | 1 | `factory.activated` | Priya Raman enables the Factory (supervised, 3 cells at once). |
| 00:30 | 2 | `wave.discovered` | WAVE-007 arrives with 5 slices; 5 `slice.materialized` follow (LOCAL-031 to 035). |
| 00:30 | 9 | `dependency.resolved` | SLICE-021, 022, 023 depend on nothing; SLICE-024 and 025 are `dependency.blocked`. |
| 00:31 to 00:33 | 20, 26, 32 | `work.scheduled` | Cells LOCAL-031, 032, 033 opened at spec-ready. |
| 00:34 to 00:37 | 36, 38, 40 | `execution.started` | One mach:belt execution per cell. |
| 00:37 | 41 | `scheduling.decided` | Dispatched 3, started 3. |
| 01:11 to 01:13 | 100 to 110 | `station.entered` | All three at plan: contract engineers on Opus. |
| 03:38 to 03:43 | 246 to 259 | `station.entered` | All three at build: builders red and green, task by task (busiest stretch). |
| 20:11 | 746 | `station.entered` | LOCAL-033 at verify. |
| 24:06 | 878 | `verification.verdict` | LOCAL-033 PASS, 5 of 5. |
| 24:23 | 897 | `review.started` | LOCAL-033 round 1: three seats fan out. |
| 26:47 | 1053 | `review.decided` | LOCAL-033 APPROVED 2 of 3; the product seat's blocker (FR-02, tax ID) is outvoted. |
| 27:11 | 1079 | `merge.completed` | LOCAL-033 lands; no revalidation (main has not moved). |
| 27:19 | 1094 | `verification.verdict` | LOCAL-031 FAIL_WITH_EVIDENCE: R4, 7 of 8. |
| 27:30 | 1119 | `slice.integrated` | SLICE-023 integrated. |
| 27:36 | 1123 | `build.revised` | LOCAL-031 back to build, round 2 of 3. |
| 27:39 | 1133 | `cleanup.completed` | LOCAL-033 archived. |
| 28:57 | 1193 | `verification.verdict` | LOCAL-032 PASS, 7 of 7. |
| 29:14 | 1207 | `review.started` | LOCAL-032 round 1, three Opus seats, 3 approvals needed. |
| 32:08 | 1334 | `review.decided` | LOCAL-032 REJECTED: security blocker (INV-02). |
| 32:25 | 1354 | `build.revised` | LOCAL-032 back to build, round 2. |
| 38:36 | 1506 | `verification.verdict` | LOCAL-031 PASS, 8 of 8. |
| 38:52 | 1527 | `review.started` | LOCAL-031 round 2 (its first review: round 2, no delta). |
| 41:21 | 1654 | `review.decided` | LOCAL-031 APPROVED 3 of 3, notes only. |
| 42:42 | 1698 | `merge.completed` | LOCAL-031 lands after revalidation on top of LOCAL-033. |
| 43:30 | 1742 | `slice.integrated` | SLICE-021 integrated. |
| 43:30 | 1743 | `dependency.resolved` | SLICE-024 eligible. |
| 43:31 | 1750 | `work.scheduled` | SLICE-024 dispatched as LOCAL-034; started at 43:33. |
| 43:31 | 1751 | `verification.verdict` | LOCAL-032 PASS, round 2. |
| 43:48 | 1775 | `review.started` | LOCAL-032 round 2: delta review (since the rejected head; earlier blocker file listed). |
| 44:09 | 1823 | `station.entered` | LOCAL-034 at plan. |
| 46:35 | 1936 | `station.entered` | LOCAL-034 at build. |
| 46:42 | 1946 | `review.decided` | LOCAL-032 AWAITING_HUMAN: 3 of 3, High risk. |
| 46:51 | 1955 | `station.entered` | LOCAL-032 at the human-approval gate; its execution returns. |
| 47:30 | 1967, 1968 | `execution.completed`, `human.required` | The execution ends waiting for human-approval; the supervisor asks for a person. Quieter stretch: only LOCAL-034 at work. |
| 51:57 | 2018 | `human.approval_recorded` | Daniel Okafor approves. |
| 52:32 | 2028 | `execution.started` | A second execution for LOCAL-032 (next: merge). |
| 54:20 | 2082 | `merge.completed` | LOCAL-032 lands after revalidation on top of LOCAL-033 and LOCAL-031. |
| 54:30 | 2094 | `slice.integrated` | SLICE-022 integrated; SLICE-025 still waits for SLICE-024. |
| 54:49 | 2108 | `cleanup.completed` | LOCAL-032 archived. |
| 55:30 | 2126 | `execution.completed` | Last event. LOCAL-034's builder is still at work. |

## 9. Cost, determinism and tests

- **Cost** (measured by `test/reducer.test.mjs`, Node 25, Apple silicon): indexing the 2,126-event fixture takes about 5 ms, once, on first use; `sceneAt` is a binary search into precomputed scenes, about 0.07 µs per call; the index keeps about 4 MB of heap (scenes share every part an event did not touch). Calling it every frame for the whole run is free.
- **Determinism**: no `Math.random`, `Date.now`, timers or wall clock anywhere in `src/sim` (source-scanned by test); hashes and IDs come from FNV-1a over labels. `buildScenario()` twice gives identical JSON. Scenes are identical forwards and backwards and after arbitrary seeks.
- **Tests** (`pnpm --filter @mach/control-tower test`, `node --test`, no dependencies): `test/scenario.test.mjs` (envelope, seq, causes, real data fields, catalog coverage, every beat, durations, agent and tool-call lifetimes, artifact writers, station order against `run.py`'s table, stage transitions, three-round limit and round numbering, vote and decision rules, dependency dispatch order, the human gate, commit-bound merges, supervisor ticks); `test/reducer.test.mjs` (the reducer, selectors and the highlight sets); `test/no-early-outcomes.test.mjs` (nothing at `t` is derived from a later event); `test/store.test.mjs`; `test/pass2.test.mjs` (the capture hook's driving controls and manual clock, camera follow, the actors, known timing); `test/purity.test.mjs` (source scans, and the catalog and agents checked against MACH's own files).
- **TypeScript for node**: the sources use erasable syntax only and import without extensions (the app's tsconfig has `allowImportingTsExtensions: false`). `test/_load.mjs` registers a resolve hook that adds `.ts`, so node runs the same files tsc checks.
