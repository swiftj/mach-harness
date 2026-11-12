/**
 * The simulation's fixture, served by the same incremental engine as live and replay (log.ts).
 *
 * `indexFixture(fixture)` builds a scene log from the fixture once (cached per fixture object, a
 * WeakMap) and keeps the fixture-shaped indexes the M6.0 views and tests read. It no longer keeps a
 * scene for every event: scenes come from checkpoints every SIM_CHECKPOINT_EVERY events plus forward
 * reduction, with recently asked scenes cached, so a fixture costs the same machinery as a live
 * stream. Scrubbing backwards and forwards still returns identical scenes for identical times while
 * they are cached.
 */
import type { AnySimEvent } from "./events";
import type { AnyRef, EntityRef, Fixture, Scene } from "./model";
import { provenance } from "./provenance";
import type { SceneLog } from "./log";
import { createSceneLog, lowerBound, upperBound } from "./log";

export { lowerBound, upperBound };

/** Checkpoint interval for a fixture: every 16 events, so any scene is at most 15 reductions away. */
export const SIM_CHECKPOINT_EVERY = 16;

export interface SimIndex {
  readonly fixture: Fixture;
  /** The scene log every simulation scene comes from (provenance "simulation"). */
  readonly log: SceneLog;
  readonly events: readonly AnySimEvent[];
  /** `t` of each event, ascending. */
  readonly times: readonly number[];
  /** The entities each event touches (same order as events). Actors are listed in actorsByEvent. */
  readonly refsByEvent: readonly (readonly EntityRef[])[];
  /** The actor behind each event, if any (same order as events). */
  readonly actorsByEvent: readonly (AnyRef | null)[];
  /** For each entity or actor, the indexes of the events that touch it, ascending. */
  readonly eventsByRef: ReadonlyMap<AnyRef, readonly number[]>;
  readonly indexBySeq: ReadonlyMap<number, number>;
}

const cache = new WeakMap<Fixture, SimIndex>();

export function indexFixture(fixture: Fixture): SimIndex {
  const cached = cache.get(fixture);
  if (cached) return cached;
  const events = fixture.events;
  for (let i = 1; i < events.length; i++) {
    if ((events[i] as AnySimEvent).t < (events[i - 1] as AnySimEvent).t) throw new Error(`Fixture events are not in time order at seq ${(events[i] as AnySimEvent).seq}`);
  }
  // A fixture is bounded: keep every scene asked for (at most one per event), so identity holds for the whole run.
  const log = createSceneLog({ definitions: fixture.definitions, provenance: provenance("simulation", fixture.id), checkpointEvery: SIM_CHECKPOINT_EVERY, cacheSize: events.length + 1 });
  log.ingest(events);
  const entries = log.entries();
  const times = log.times();
  const refsByEvent = entries.map((e) => e.refs);
  const actorsByEvent = entries.map((e) => e.actor);
  const eventsByRef = new Map<AnyRef, number[]>();
  const indexBySeq = new Map<number, number>();
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] as (typeof entries)[number];
    indexBySeq.set((events[i] as AnySimEvent).seq, i);
    for (const r of entry.actor ? [...entry.refs, entry.actor] : entry.refs) {
      const list = eventsByRef.get(r);
      if (list) list.push(i);
      else eventsByRef.set(r, [i]);
    }
  }
  const index: SimIndex = { fixture, log, events, times, refsByEvent, actorsByEvent, eventsByRef, indexBySeq };
  cache.set(fixture, index);
  return index;
}

/** The scene log behind a fixture. */
export function fixtureLog(fixture: Fixture): SceneLog {
  return indexFixture(fixture).log;
}

/** How many events have happened at time t (events with event.t <= t). */
export function cursorAt(fixture: Fixture, t: number): number {
  return fixtureLog(fixture).cursorAt(t);
}

/** The complete scene at playhead time t. The same object for every t between two events. */
export function sceneAt(fixture: Fixture, t: number): Scene {
  return fixtureLog(fixture).sceneAt(t);
}

/** The scene after exactly `cursor` events. */
export function sceneAtCursor(fixture: Fixture, cursor: number): Scene {
  return fixtureLog(fixture).sceneAtCursor(cursor);
}

/**
 * The scene once every event has happened. Simulation only: a recorded fixture has an end. A live
 * log has none; its equivalent is `log.head()`, the scene so far.
 */
export function finalScene(fixture: Fixture): Scene {
  return fixtureLog(fixture).head();
}
