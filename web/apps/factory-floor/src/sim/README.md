# The Living Factory simulation (`src/sim`) and the one store (`src/scene`)

**This is a simulation.** Everything here comes from one deterministic fixture. It reads no Factory state, starts nothing, and makes no network request.

`src/sim` is the only authority on what is happening (M6_0_CONTRACT.md, rule 1). The scene at time `t` is a pure function of the fixture's events up to `t`. The Line, the Atlas and the inspector read that one scene, and none keeps progress of its own. `src/scene` is the one store: the moment shown (`now`), selection, focus, hover, the workspace and Theater Mode. There is no playback: the store only ever moves forward.

Import from `src/sim/index.ts` (`../sim`) and `src/scene/index.ts` (`../scene`) only. Anything deeper may move.

> **M6.2 (live execution).** The engine is incremental and serves two sources: the simulation
> below and the Live Factory. `reduce` also takes the observer's version 3 events
> (`v3.ts`, `reduce-v3.ts`); every scene comes from a scene log (`log.ts`: ordered, de-duplicated
> events, checkpoints plus forward reduction, late-event re-derivation, bounded memory); every scene
> carries `provenance` and `completeness`, every entity a `meta` (authority, unknown and inferred
> fields, time quality). `indexFixture` keeps its M6.0 shape on top of a log, without precomputing
> every scene. Every selector that takes a fixture also takes a log. The design, the measured costs,
> the scene-model changes and the changes the views must make are in `../live/README.md`.

## Contents

1. [Quick start for a view](#1-quick-start-for-a-view)
2. [The public API](#2-the-public-api)
3. [The event model](#3-the-event-model)
4. [The scene](#4-the-scene)
5. [Deriving animation from events](#5-deriving-animation-from-events)
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
  const t = useSceneStore((s) => s.now);                      // factory ms
  const reduced = useSceneStore((s) => s.reducedMotion);
  const { select } = useSceneActions();
  if (!cell) return null;                                     // not dispatched yet at this moment
  // A gate closing: motion is a function of t - event.t, so any moment draws the right frame.
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
| `REAL_KINDS`, `SIM_KINDS` | The 21 kinds MACH emits today (`intake.EVENT_TYPES`), and the 29 the simulation adds. |
| `STATIONS`, `CELL_STAGES`, `STEP_ACTIONS`, `ACTION_STATION`, `NEXT_ACTIONS`, `STAGE_TRANSITIONS`, `SCHEDULER_STATES`, `MODELS`, `TIER_MODEL`, `AGENT_ROLES`, `AGENT_TYPES`, `REVIEW_SEATS`, `PANELS`, `MAX_ROUNDS`, `BELT_PHASES`, `TASK_KINDS`, `TASK_STEP`, `TOOLS`, `GATE_KINDS`, `ARTIFACT_KINDS` | MACH's vocabulary as data, each copied from the file named beside it in `vocabulary.ts`. |
| `PEOPLE`, `PROJECT`, `EPIC`, `ISSUES`, `TICKETS`, `SLICE_IDS`, `SCENARIO_START`, `isoAt(t)` | Scenario constants. |

### The scene

| Signature | Notes |
|---|---|
| `sceneAt(fixture: Fixture, t: number): Scene` | The complete scene at time `t` (factory ms from the start). Returns the **same object** for every `t` between two events. |
| `sceneAtCursor(fixture, cursor): Scene` | The scene after exactly `cursor` events. |
| `finalScene(fixture): Scene` | After every event. |
| `cursorAt(fixture, t): number` | How many events have happened at `t` (`event.t <= t`). |
| `indexFixture(fixture): SimIndex` | The cached index (all scenes, entity index). Rarely needed directly. |

The signature takes the `Fixture`, not a bare event array: titles, risks and app types come from `fixture.definitions`, the approved product definitions that the events' `refs` point at, which is where a real Factory Floor would read them. Pass `SCENARIO`.

### Selectors (all pure)

| Signature | Use |
|---|---|
| `eventsBetween(fixture, from, to): SimEvent[]` | Events with `from < e.t <= to`. |
| `eventsInWindow(fixture, t, windowMs, kinds?)` | The last `windowMs` before `t`, optionally by kind. The basis of every factory animation. |
| `changesBetween(fixture, t1, t2): Changes` | `{ direction: "forward" \| "backward" \| "none", events, refs }`: what appeared or disappeared between two times. |
| `eventsFor(fixture, ref, t?)` | The events behind an entity, oldest first; with `t`, only those that have happened. The inspector's "why". |
| `latestEventFor(fixture, ref, t)` | The one event that explains an entity's current look. |
| `eventBySeq(fixture, seq)`, `refsOfEvent(fixture, seq)` | Look up an event; the entities it touches. |
| `nextEventTime(fixture, t)`, `previousEventTime(fixture, t)` | The time of the next or previous event. `null` at the ends. No view uses them now. |
| `entityAt(scene, ref): EntityState \| null` | Any entity by reference, as `{ kind, value }`. `null` if it does not exist at this moment. |
| `allAgents(scene)`, `activeAgents(scene)`, `toolCallsInFlight(scene)` | Flattened across cells (cached per `scene.cells` object). |
| `findAgent`, `findToolCall`, `findArtifact`, `cellsAtStation(scene, station)` | Lookups. |
| `relatedRefs(scene, ref): EntityRef[]` | The highlight set: for a slice or cell, the slice's full upstream and downstream dependency set with edges and cells; for a dependency link, its chain (both ends with their cells, everything the prerequisite waits for, and everything that waits on the dependent, transitively; a sibling prerequisite of the dependent is not in it); an agent's cell, parent, children and current call; a tool call's agent, cell and artifacts; an artifact's cell, writer agent and call; a gate's cell. The store uses it for `highlighted`. |
| `cellTimelines(fixture, t)`, `cellTimeline(fixture, ticket, t)` | As known at `t`: station spans, stage changes, agent spans with a non-overlapping `row`, and the cell's moments. A span still open at `t` has `end: null` and no outcome; nothing that starts after `t` is listed. Pass `fixture.duration` for the whole recorded run, and then hide what lies beyond the live edge, never colouring a span by an outcome later than the edge. Cached per scene. |
| `agentTimeline(fixture, agentId, t)` | An agent's span and its tool-call spans as known at `t` (open calls `running`, `end: null`). |
| `moments(fixture, atLeast = "major", t?)` | Events at or above a significance, each with a sentence (`describe`) and its refs: the Line's "What just happened", Theater Mode's caption and the announcer. With `t`, only those that have happened. |
| `chapters(fixture)`, `chapterAt(fixture, t)` | The 14 named chapters (section 8), each with a `focus` ref. Theater Mode's caption and the inspector name the current one. |
| `describe(event): string` | One plain sentence per event, for the inspector, tooltips and screen readers. |
| `agentTimingAt(agent, t)`, `toolCallTimingAt(call, t)`, `visitTimingAt(visit, t)`, `timingAt(startedAt, finishedAt, t)` | What is **known** about work at `t`: `{ started, startedAt, elapsed, finishedAt, finished }`. Nothing predictive (see section 5). |
| `actorOfEvent(fixture, seq): AnyRef \| null` | `actor:supervisor` or `actor:scheduler` for an event they wrote, else `null`. |

### Motion helpers

`progress(t, start, duration)`, `spanProgress(t, start, end, expected)` (deprecated for open spans: its `expected` is a guess), `ease(x)`, `easeOut(x)`, `motionProgress(t, start, duration, reducedMotion)`, and `MOTION` (standard lengths in factory ms: `travel` 20 s, `gate` 8 s, `appear` 6 s, `afterglow` 30 s).

### Entity references

One string names anything selectable: `` `${kind}:${id}` `` (`EntityRef`). Build them with `ref.cell("131")` etc.; read them with `refKind`, `refId`; gate IDs with `gateId(ticket, gate, round?)`.

| Kind | Example |
|---|---|
| `slice` | `slice:SLICE-021` |
| `cell` | `cell:131` |
| `station` | `station:131/build` (one cell's visits) or `station:build` (the station) |
| `execution` | `execution:x4856eca1812e` |
| `agent` | `agent:ag-131-07` |
| `tool` | `tool:tc-131-0042` |
| `artifact` | `artifact:131:plan.md`, `artifact:131:commit:3f2a9c1` |
| `gate` | `gate:131/audit`, `gate:131/verification#1`, `gate:132/review#2`, `gate:132/human-approval`, `gate:131/merge-revalidation`, `gate:131/red-before-green`, `gate:131/plan-check` |
| `dependency` | `dependency:SLICE-024->SLICE-021` (the first waits for the second) |
| `finding` | `finding:132/r1/security/1` |

### Actors: the supervisor and the scheduler

The line supervisor and the scheduler act in the record without being agents, so they have identities of their own: `actor:supervisor` and `actor:scheduler` (`ActorRef`; `ref.actor(id)`, `isActorRef(s)`, `ACTORS`). Attribution is by kind, from the real emitters (`ACTOR_KINDS`, `actorOf(event)`):

| Actor | Real code | Kinds |
|---|---|---|
| `actor:supervisor` | `supervisor.py` (`Supervisor.once`, `observe`, `decided`, `start`, `recover`, `finish`, `park`) | `revision.discovered`, `scheduling.decided`, `work.claimed`, `execution.started`, `station.observed`, `recovery.started`, `execution.completed`, `execution.failed`; `human.required` when the supervisor parks a ticket |
| `actor:scheduler` | `intake.py` (`Factory.plan`, `record`, `dispatch`, `open_cell`) | `dependency.resolved`, `dependency.blocked`, `slice.integrated`, `work.scheduled`; `human.required` from the recorded plan (reason `waiting for ...`) |

Intake's own kinds (`intake.validated`, `slice.materialized`), the engineer's commands and the stations' facts belong to no actor. In the fixture every attributed event has `source: "supervisor"`, because both act inside the supervisor's tick.

`scene.actors.supervisor` and `scene.actors.scheduler` hold `{ id, title, code, acts, lastActedAt, lastSeq, lastKind }`. `entityAt(scene, "actor:scheduler")` returns `{ kind: "actor", value }`; `eventsFor(fixture, "actor:scheduler", t?)` and `latestEventFor` work as for any entity, so a figure can light on its own events and the inspector can say why.

`"actor"` is an `EntityKind`, so `actor:supervisor` and `actor:scheduler` are ordinary `EntityRef`s: the store can select and focus them. The Atlas frames the supervisor's console and the scheduler's desk.

**No early outcomes.** At time `t`, nothing the scene or the timeline selectors expose is derived from an event later than `t`: no outcome, end time, verdict, vote or decision shows before its event (`test/no-early-outcomes.test.mjs` walks every time field and outcome for a sample of times, including one millisecond before each deciding event). `finalScene` is the end of the run; read it only for what does not change (names, which stations a layout needs), never to colour or label work at an earlier time.

## 3. The event model

The envelope is the real Factory event, version 3 since M11 (`docs/mach-next/schemas/factory-event.schema.json`, written by `intake.py Factory.emit`), field for field: `schema_version`, `seq`, `at`, `type`, `source_commit`, `epic_id`, `issue`, `slice_id`, `revision`, `ticket_id`, `runner_id`, `execution_id`, `source`, `cause`, `refs`, `data`. These are the schema's names, which M6_0_CONTRACT.md section 4 also uses.

The simulation adds one field, `t`: milliseconds since the scenario's start. `at` is what MACH writes (UTC, whole seconds, `YYYY-MM-DDTHH:MM:SSZ`) and is too coarse to order or animate by, so the engine uses `t`. Tests check that removing `t` leaves exactly the schema's required fields.

- **Real kinds** (`REAL_KINDS`, 21) are used unchanged, with exactly the `data` fields their real emitter writes (checked by test against `intake.py`). Their `cause` is `null`, because no MACH emitter sets it today.
- **Simulation kinds** (`SIM_KINDS`, 29) are what the experience needs and MACH does not emit: workflow, station, stage, agent, tool, artifact, gate, task, test, verification, review, merge and cleanup events. They set `cause` where one event led to another. Their `source` stays within the schema's enum (`supervisor` for work inside an execution, `engineer` for the person's approval).
- `switch (event.type)` narrows `event.data` (`AnySimEvent` is a discriminated union).

The beats the brief names, and the kind that carries each:

| Beat | Kind |
|---|---|
| Ready slices arrive / become their tickets | `intake.validated`, `slice.materialized` (real) |
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
| `slices[id]` | Title, summary, epic (id and name) and issue number where recorded, risk, ticket, `dependsOn`, scheduler state (`materialized`, `waiting-on-dependency`, `eligible`, `dispatched`, `integrated`), the scheduler's own `reasons`, history. |
| `dependencies["A->B"]` | `from` waits for `to`; `blocking` or `satisfied`, and when. |
| `cells[ticket]` | See below. Exists from the moment intake opens the cell; stays (with `archived` set) after cleanup. |
| `executions[id]` | Claim, start, the workflow's phase, end, outcome and cost. |
| `gates[id]` | `open`, `passed`, `failed`, `waiting` (human approval) or `skipped` (no revalidation needed), with detail and times. |
| `counters` | Events, agents active and started, tool calls active and total, artifacts, commits, test runs, checks passed and failed, verification failures, review rounds, blockers, notes, human approvals, merged, integrated, executions running, cost so far. |

`CellState`: `stage` (what the station scripts last wrote) and `observedStage` (what the supervisor last sampled; it lags), `stageHistory`; `station`, `action` and `stationSince` (null between stations: the belt is asking "what next?"); `visits` (every station visit with round and outcome); `round` (1 to 3) and `loop`; `executionId`, `workflowPhase`; `suite`, `lastTest`, `testsRun`; `tasks` (status `active`, `red`, `green`, `done`, with commit); `verifications` (per round: every check with result, evidence and note); `reviews` (per round: seats with model, agent and vote; findings with `outvoted`; outcome; delta; human approval); `agents` (by ID, with `agentOrder` and `activeAgentIds`); `artifacts` (in write order, with version and writer); `merged`; `archived`.

`AgentState`: role, `agentType` (`mach:builder` etc. or null), seat, tier, model, effort, label (as belt.js labels it), `parentId` (the contract engineer's parent is the plan worker), phase, station, status, times, `currentToolCallId` and `toolCalls` (each with tool, short target, times, status and the artifacts it produced).

## 5. Deriving animation from events

Rule: **factory motion is a function of `t - event.t`**. Never animate factory progress with a timer or a spring; those are for interface transitions (inspector, camera easing).

1. Read state from `sceneAt` (or `useScene`): where things are now.
2. Read recent events with `eventsInWindow(SCENARIO, t, MOTION.travel, kinds)`: what is moving now, and since when.
3. Compute `progress(t, event.t, duration)` and draw that frame. Once `t` is past the window, the event drops out and the motion is over.
4. **Work in flight has no completion fraction.** Neither MACH nor the simulation knows how long an agent, a tool call or a station visit will take, so a view must not draw "x% done" (a filling arc, a progress bar) for open work, and must not divide elapsed time by an expected length per role or station. Show what is known: `agentTimingAt(agent, t)`, `toolCallTimingAt(call, t)` and `visitTimingAt(visit, t)` give `started`, `startedAt`, `elapsed` and, once it has happened, `finishedAt`. Draw elapsed time (a counter, ticks per minute, an arc that grows without a fixed end) or a plain "at work" state. A completed span may be drawn whole. `spanProgress` is deprecated for open spans.
5. Under `prefers-reduced-motion` (`store.reducedMotion`), use `motionProgress(..., true)`: anything started is shown at its end state, with no travel or looping.
6. Every visible change must trace to an event: show `latestEventFor(SCENARIO, ref, t)` (and `describe(event)`) in the inspector.

Examples: a packet travelling from build to verify is the `station.entered` (verify) event, drawn for `MOTION.travel`; a gate closing is `verification.verdict` or `review.decided`; a tool spark is a `tool.started` to `tool.finished` span; the reviewer fan-out is three `agent.started` events with `seat` set, under one `review.started`; the dependency edge turning is `slice.integrated` for its `to` slice, followed on the same tick by `dependency.resolved` and `work.scheduled` for its `from` slice.

## 6. The store

`src/scene` holds one store per source. `getSceneStore()` is the Simulation's: the scenario on the browser clock, reduced motion from the media query, and the development hook in development and capture builds. The Live Factory's store is made by `createLiveFactory` (`src/live`). React bindings, on `useSyncExternalStore` with no other dependency:

| Hook | Returns |
|---|---|
| `useSceneStore(selector)` | A slice of the store state. The selector must return a stable value (a field, or an object taken from the scene). |
| `useScene()` / `useScene(selector)` | `log.sceneAt(now)`, or part of it; re-renders only when the selected value changes. |
| `useSceneActions()` | The actions below (stable). |
| `useNowEffect(fn, deps)` | Calls `fn` with the state whenever `now` moves, without a React render (for a running time written straight to the DOM). |
| `SceneStoreProvider` | Give a subtree its own store (tests, previews, the held Floor). |

State (`SceneStoreState`): `source` (`"live"` or `"simulation"`), `log`, `logVersion`, `extent`, `connection` and `factoryStatus` (live only), `fixture`, `now` (the moment shown, factory ms; it only moves forward), `cursor`, `selection`, `focus` (`{ target: EntityRef | "overview", reason, nonce }`), `hovered`, `highlighted`, `workspace` (`"line"`, `"floor"` or `"analytics"`), `analytics` (Analytics' interface state), `theater`, `evidence` (the evidence player, when open), `reducedMotion`, `follow` (camera follow).

Actions: `select(ref | null, { focus? })` (selecting also requests focus unless `focus: false`), `focusOn(ref | "overview", reason?)`, `hover(ref | null)`, `setWorkspace(w)`, `setAnalyticsView(patch)`, `setTheater(on)` (the Floor only), `openEvidence(ticket, options?)`, `setEvidenceCheck(id)`, `closeEvidence()`, `setReducedMotion(on)`, `setFollow(on)`, `dispose()`. The live source alone calls `logChanged()`, `setLiveEdge(t)`, `observeClock(ms)`, `setConnection(status)` and `setFactoryStatus(status)`. Helpers: `showOnLine(store, ref?)`, `showOnFloor(store, { ref }?)`, `showInAnalytics(store, target?)`, `heldStore(store)` (the Floor's view of the store, held still while another workspace is up).

Time: the Simulation runs forward on its own while anything subscribes to the store, at `PLAYBACK_BASE_RATE` (10) factory seconds per wall second, so the 55:50 run takes about 5.5 minutes. It stops at its last moment. The clock is driven by `requestAnimationFrame` through an injectable `Clock` (`browserClock()`, or `manualClock()` for tests and capture). A frame gap is capped at 250 ms so a background tab does not leap. Live, `now` is the live edge (see `../live/README.md`). `timeScaleOf(state)` is 10 for the Simulation and 1 live: motion lasts the same on screen in both.

Camera follow (one flag, for the Atlas): `follow` is on by default. It goes off when the person pans or zooms (the Atlas calls `setFollow(false)`) and when the camera is asked to frame something (`focusOn` with any reason but `"follow"`, so also `select` with focus). It comes back on with `setFollow(true)` (Shift+F, or the Following button). The Atlas's own follow camera requests focus with reason `"follow"`, which leaves the flag on, and moves only while the Factory moves (always for the Simulation; live, while the connection is not stale). Theater Mode does not change it.

Focus: a request the Atlas honours. `nonce` changes on every request, so selecting the same thing twice re-frames it.

Hover and selection: `highlighted` is `relatedRefs` of the hovered entity, or else of the selection, now.

### `window.__machSim` (development and capture builds only)

Installed when `import.meta.env.DEV` or the build mode is `capture` (`vite build --mode capture`); never in a production build, which also keeps the plain browser clock. In development and capture builds the Simulation's store runs on a `switchableClock(browserClock())`, which a script can switch to manual time. The hook exists so tests and screenshots see a known moment; nothing in the interface can move the Simulation's moment.

```js
const sim = window.__machSim;
sim.version;            // 2
sim.fixtureId;
sim.duration;           // factory ms
sim.eventCount;
sim.seek(t);            // move the Simulation to factory ms t, either way; it runs on from there
sim.state();            // { now, cursor, workspace, theater, selection, follow, focus, reducedMotion,
                        //   clock: "live" | "manual" | "fixed" }
sim.select("cell:131");   // or null; also frames it (and releases camera follow)
sim.focus("gate:132/human-approval");  // or "overview"
sim.setWorkspace("floor");      // "line", "floor" or "analytics"
sim.setTheater(true);
sim.setFollow(true);
// Rendering frame by frame
sim.useManualClock();           // browser frames no longer move time
sim.clockMode();                // "manual"
sim.advance(0);                 // first frame: sets the reference time
sim.advance(1000 / 30);         // one 30 fps frame: factory time += 33.3 ms x 10
sim.advance(5000, 1000 / 60);   // 5 s of wall time in 60 fps frames
sim.useLiveClock();             // back to browser frames; time continues without a leap
```

`advance(ms, frameMs = 250)` delivers frames of at most `frameMs`, so the total moved is exactly `ms` of wall time, which is `ms x PLAYBACK_BASE_RATE` of factory time (until the run's end). The same calls from the same state always give the same frames. `advance` and the clock switches throw when the store's clock cannot be switched (`clockMode()` is then `"fixed"`).

## 7. The event catalog

`catalog.ts` holds one entry per kind: `meaning`, `payload`, `telemetry`, `source` (file and function), `missingFields` where a derivable source does not hold everything shown, `proposedAs` where the telemetry analyst's gap document proposes a name, and `significance` (`chapter`, `major`, `minor`, `ambient`), which decides what `moments` lists.

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

The fixture's 2,129 events by class: **exists 78, derivable 1,940, missing 111** (`workflow.phase` 34, `station.entered` 26, `station.left` 25, `task.started` 26). Of the derivable ones, 1,565 (agents and tool calls) depend on the unverified question of whether workflow sub-agents appear in `stream.jsonl` (M6_0_TELEMETRY_GAPS.md section 7, item 1).

## 8. The scenario and its storyboard

Five slices of one epic, `EPIC-004` "Collect what customers owe" (issue #130), each a GitHub issue marked ready to build in Product Studio by Maya Lindqvist, for "Tally", a B2B billing web app. Each slice's issue number is its ticket (#131 to #135). Priya Raman enables the Factory (supervised, `max_parallel` 3, merging allowed, `poll_seconds` 60). Daniel Okafor, who owns payments, signs off the High-risk change.

| Slice | Ticket | Risk | Waits for | What happens |
|---|---|---|---|---|
| SLICE-021 Invoice list with status filters | 131 | Medium | | Verification fails on R4 (an invoice due today listed as overdue), revise round 2, passes, review round 2 approves 3 of 3, merged with revalidation |
| SLICE-022 Charge a saved card for an open invoice | 132 | High | | Changes an existing contract (`payments.proto`); review round 1 rejected by a security blocker (INV-02: a timed-out charge could charge twice); delta review round 2 approves 3 of 3; stops for a person; approved; a second execution merges it with revalidation |
| SLICE-023 Download an invoice as a PDF | 133 | Medium | | First-pass: approved 2 of 3 with the product seat's blocker outvoted (reported, not hidden); first to merge, no revalidation |
| SLICE-024 Email a reminder when an invoice becomes overdue | 134 | Medium | SLICE-021 | Waits; becomes eligible and is dispatched on the tick after SLICE-021 is integrated; still building at the end |
| SLICE-025 Pay-now link in overdue reminders | 135 | High | SLICE-022, SLICE-024 | Waits throughout |

Each execution runs `mach:belt` for one ticket, as the supervisor starts it: preflight clerks (locate run.py, check the project, read the status), then for every step a Haiku clerk running `run.py next <ticket> --headless`, then the worker it names: the plan worker on Opus with the `contract-engineer` sub-agent; `mach:builder` on Sonnet doing red and green task by task through `build.py`; `mach:verifier` on Sonnet driving Playwright and recording each scenario and matrix rule through `verify.py`; a clerk seating the panel, three `mach:reviewer` seats at once (Opus for High risk, Sonnet otherwise), a clerk tallying; Haiku workers for merge and cleanup; then the Learn phase's clerk. The supervisor's records (`station.observed`, `execution.completed`, `slice.integrated`, `dependency.*`, `human.required`, claims and starts, `scheduling.decided`) fall on its 60-second ticks.

Scenario time zero is 2026-11-10T14:00:00Z. Duration 55:50 (last event 55:30, plus a 20-second hold). 2,129 events, 93 agents (up to 6 at once), 690 tool calls, 171 artifacts.

### Chapters (`fixture.chapters`)

| Time | Chapter | Focus |
|---|---|---|
| 00:00 | `enabled`: The Factory is enabled | overview |
| 00:30 | `ready`: Ready slices arrive | `slice:SLICE-021` |
| 00:31 | `dispatch`: Three cells start | `cell:131` |
| 01:22 | `plan`: Contracts and plans | `cell:131` |
| 06:55 | `build`: Test-first construction | `cell:131` |
| 21:10 | `verify`: Verification | `cell:133` |
| 24:23 | `review`: Review panels | `cell:133` |
| 27:11 | `integrate`: First work lands | `cell:133` |
| 27:19 | `verify-fail`: R4 fails, back to build | `gate:131/verification#1` |
| 32:08 | `blocker`: A security blocker | `gate:132/review#1` |
| 43:30 | `unblocked`: SLICE-024 is free to start | `dependency:SLICE-024->SLICE-021` |
| 46:42 | `human-gate`: A person must approve | `gate:132/human-approval` |
| 51:57 | `approved`: Daniel Okafor approves | `gate:132/human-approval` |
| 54:20 | `last-merge`: Revalidated and merged | `cell:132` |

Exact times are in `SCENARIO.chapters` (use those, not this table, in the capture script).

### Storyboard (key beats; mm:ss and seq)

| Time | Seq | Kind | Beat |
|---|---|---|---|
| 00:00 | 1 | `factory.activated` | Priya Raman enables the Factory (supervised, 3 cells at once). |
| 00:30 | 2 to 11 | `intake.validated`, `slice.materialized` | Each of the 5 slices is verified and filed as its ticket, its own issue (131 to 135). |
| 00:30 | 12 | `dependency.resolved` | SLICE-021, 022, 023 depend on nothing; SLICE-024 and 025 are `dependency.blocked`. |
| 00:31 to 00:33 | 23, 29, 35 | `work.scheduled` | Cells 131, 132, 133 opened at spec-ready. |
| 00:34 to 00:37 | 39, 41, 43 | `execution.started` | One mach:belt execution per cell. |
| 00:37 | 44 | `scheduling.decided` | Dispatched 3, started 3. |
| 01:11 to 01:13 | 103 to 113 | `station.entered` | All three at plan: contract engineers on Opus. |
| 03:38 to 03:43 | 249 to 262 | `station.entered` | All three at build: builders red and green, task by task (busiest stretch). |
| 20:11 | 749 | `station.entered` | 133 at verify. |
| 24:06 | 881 | `verification.verdict` | 133 PASS, 5 of 5. |
| 24:23 | 900 | `review.started` | 133 round 1: three seats fan out. |
| 26:47 | 1056 | `review.decided` | 133 APPROVED 2 of 3; the product seat's blocker (FR-02, tax ID) is outvoted. |
| 27:11 | 1082 | `merge.completed` | 133 lands; no revalidation (main has not moved). |
| 27:19 | 1097 | `verification.verdict` | 131 FAIL_WITH_EVIDENCE: R4, 7 of 8. |
| 27:30 | 1122 | `slice.integrated` | SLICE-023 integrated. |
| 27:36 | 1126 | `build.revised` | 131 back to build, round 2 of 3. |
| 27:39 | 1136 | `cleanup.completed` | 133 archived. |
| 28:57 | 1196 | `verification.verdict` | 132 PASS, 7 of 7. |
| 29:14 | 1210 | `review.started` | 132 round 1, three Opus seats, 3 approvals needed. |
| 32:08 | 1337 | `review.decided` | 132 REJECTED: security blocker (INV-02). |
| 32:25 | 1357 | `build.revised` | 132 back to build, round 2. |
| 38:36 | 1509 | `verification.verdict` | 131 PASS, 8 of 8. |
| 38:52 | 1530 | `review.started` | 131 round 2 (its first review: round 2, no delta). |
| 41:21 | 1657 | `review.decided` | 131 APPROVED 3 of 3, notes only. |
| 42:42 | 1701 | `merge.completed` | 131 lands after revalidation on top of 133. |
| 43:30 | 1745 | `slice.integrated` | SLICE-021 integrated. |
| 43:30 | 1746 | `dependency.resolved` | SLICE-024 eligible. |
| 43:31 | 1753 | `work.scheduled` | SLICE-024 dispatched as 134; started at 43:33. |
| 43:31 | 1754 | `verification.verdict` | 132 PASS, round 2. |
| 43:48 | 1778 | `review.started` | 132 round 2: delta review (since the rejected head; earlier blocker file listed). |
| 44:09 | 1826 | `station.entered` | 134 at plan. |
| 46:35 | 1939 | `station.entered` | 134 at build. |
| 46:42 | 1949 | `review.decided` | 132 AWAITING_HUMAN: 3 of 3, High risk. |
| 46:51 | 1958 | `station.entered` | 132 at the human-approval gate; its execution returns. |
| 47:30 | 1970, 1971 | `execution.completed`, `human.required` | The execution ends waiting for human-approval; the supervisor asks for a person. Quieter stretch: only 134 at work. |
| 51:57 | 2021 | `human.approval_recorded` | Daniel Okafor approves. |
| 52:32 | 2031 | `execution.started` | A second execution for 132 (next: merge). |
| 54:20 | 2085 | `merge.completed` | 132 lands after revalidation on top of 133 and 131. |
| 54:30 | 2097 | `slice.integrated` | SLICE-022 integrated; SLICE-025 still waits for SLICE-024. |
| 54:49 | 2111 | `cleanup.completed` | 132 archived. |
| 55:30 | 2129 | `execution.completed` | Last event. 134's builder is still at work. |

## 9. Cost, determinism and tests

- **Cost** (measured by `test/reducer.test.mjs`, Node 25, Apple silicon): indexing the 2,129-event fixture takes about 5 ms, once, on first use; `sceneAt` is a binary search into precomputed scenes, about 0.07 µs per call; the index keeps about 4 MB of heap (scenes share every part an event did not touch). Calling it every frame for the whole run is free.
- **Determinism**: no `Math.random`, `Date.now`, timers or wall clock anywhere in `src/sim` (source-scanned by test); hashes and IDs come from FNV-1a over labels. `buildScenario()` twice gives identical JSON. The scene for a given `t` is the same however it is reached.
- **Tests** (`pnpm --filter @mach/factory-floor test`, `node --test`, no dependencies): `test/scenario.test.mjs` (envelope, seq, causes, real data fields, catalog coverage, every beat, durations, agent and tool-call lifetimes, artifact writers, station order against `run.py`'s table, stage transitions, three-round limit and round numbering, vote and decision rules, dependency dispatch order, the human gate, commit-bound merges, supervisor ticks); `test/reducer.test.mjs` (the reducer, selectors and the highlight sets); `test/no-early-outcomes.test.mjs` (nothing at `t` is derived from a later event); `test/store.test.mjs`; `test/pass2.test.mjs` (the capture hook's driving controls and manual clock, camera follow, the actors, known timing); `test/purity.test.mjs` (source scans, and the catalog and agents checked against MACH's own files); `test/inspector-wording.test.mjs` (the inspector's "Finished at" times and review tallies, such as "3 of 3 approved, 2 needed"; a decided review gate's detail reads "<outcome>: N approved, M needed", never approvals over approvals needed).
- **TypeScript for node**: the sources use erasable syntax only and import without extensions (the app's tsconfig has `allowImportingTsExtensions: false`). `test/_load.mjs` registers a resolve hook that adds `.ts`, so node runs the same files tsc checks.
