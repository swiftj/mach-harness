/**
 * The engine: runs the reducer once over a fixture and keeps the scene after every event, so the
 * scene at any playhead time is a binary search away. Scenes share every part an event did not
 * touch, so the whole run costs little memory, and a view that selects `scene.cells["LOCAL-031"]`
 * gets the same object until that cell changes.
 *
 * Pure from the outside: the index is a cache keyed by the fixture object (a WeakMap), built on
 * first use. Scrubbing backwards and forwards returns identical scenes for identical times.
 */
import type { AnySimEvent } from "./events";
import type { AnyRef, EntityRef, Fixture, Scene } from "./model";
import { gateId, ref } from "./model";
import { emptyScene, reduce } from "./reducer";
import { actorOf } from "./actors";

export interface SimIndex {
  readonly fixture: Fixture;
  readonly events: readonly AnySimEvent[];
  /** `t` of each event, ascending. */
  readonly times: readonly number[];
  /** scenes[k] is the scene after the first k events; scenes[0] is before any. */
  readonly scenes: readonly Scene[];
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
  const scenes: Scene[] = new Array(events.length + 1);
  let scene = emptyScene(fixture.definitions);
  scenes[0] = scene;
  const times: number[] = new Array(events.length);
  const refsByEvent: EntityRef[][] = new Array(events.length);
  const eventsByRef = new Map<AnyRef, number[]>();
  const actorsByEvent: (AnyRef | null)[] = new Array(events.length);
  const indexBySeq = new Map<number, number>();
  const sliceDeps = new Map<string, readonly string[]>();
  for (let i = 0; i < events.length; i++) {
    const event = events[i] as AnySimEvent;
    if (i > 0 && event.t < (times[i - 1] ?? 0)) throw new Error(`Fixture events are not in time order at seq ${event.seq}`);
    times[i] = event.t;
    indexBySeq.set(event.seq, i);
    if (event.type === "slice.materialized" && event.slice_id) sliceDeps.set(event.slice_id, event.data.dependencies);
    const refs = refsOf(event, sliceDeps);
    refsByEvent[i] = refs;
    const actor = actorOf(event);
    actorsByEvent[i] = actor ? ref.actor(actor) : null;
    for (const r of actor ? [...refs, ref.actor(actor)] : refs) {
      const list = eventsByRef.get(r);
      if (list) list.push(i);
      else eventsByRef.set(r, [i]);
    }
    scene = reduce(scene, event, fixture.definitions);
    scenes[i + 1] = scene;
  }
  const index: SimIndex = { fixture, events, times, scenes, refsByEvent, actorsByEvent, eventsByRef, indexBySeq };
  cache.set(fixture, index);
  return index;
}

/** How many events have happened at time t (events with event.t <= t). */
export function cursorAt(fixture: Fixture, t: number): number {
  return upperBound(indexFixture(fixture).times, t);
}

/** The complete scene at playhead time t. The same object for every t between two events. */
export function sceneAt(fixture: Fixture, t: number): Scene {
  const index = indexFixture(fixture);
  return index.scenes[upperBound(index.times, t)] as Scene;
}

/** The scene after exactly `cursor` events. */
export function sceneAtCursor(fixture: Fixture, cursor: number): Scene {
  const index = indexFixture(fixture);
  return index.scenes[Math.max(0, Math.min(cursor, index.events.length))] as Scene;
}

/** The scene once every event has happened. */
export function finalScene(fixture: Fixture): Scene {
  const index = indexFixture(fixture);
  return index.scenes[index.events.length] as Scene;
}

/** First index whose value is greater than t (the count of values <= t). */
export function upperBound(values: readonly number[], t: number): number {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((values[mid] as number) <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** First index whose value is >= t (the count of values < t). */
export function lowerBound(values: readonly number[], t: number): number {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((values[mid] as number) < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// ---------------------------------------------------------------- what each event is about

function refsOf(event: AnySimEvent, sliceDeps: Map<string, readonly string[]>): EntityRef[] {
  const out = new Set<EntityRef>();
  const ticket = event.ticket_id;
  if (event.wave_id) out.add(ref.wave(event.wave_id));
  if (event.slice_id) out.add(ref.slice(event.slice_id));
  if (ticket) out.add(ref.cell(ticket));
  if (event.execution_id) out.add(ref.execution(event.execution_id));
  switch (event.type) {
    case "slice.materialized":
      for (const to of event.data.dependencies) out.add(ref.dependency(event.slice_id ?? "", to));
      break;
    case "dependency.resolved":
    case "dependency.blocked":
      for (const to of sliceDeps.get(event.slice_id ?? "") ?? []) out.add(ref.dependency(event.slice_id ?? "", to));
      break;
    case "slice.integrated":
      for (const [from, deps] of sliceDeps) if (deps.includes(event.slice_id ?? "")) out.add(ref.dependency(from, event.slice_id ?? ""));
      break;
    case "scheduling.decided":
      for (const id of event.data.dispatched) out.add(ref.slice(id));
      for (const id of event.data.started) out.add(ref.cell(id));
      break;
    case "human.required":
      if (ticket && /human-approval/.test(event.data.reason)) out.add(ref.gate(gateId(ticket, "human-approval")));
      break;
    case "station.entered":
    case "station.left":
      if (ticket) out.add(ref.station(event.data.station, ticket));
      if (event.data.station === "human-approval" && ticket) out.add(ref.gate(gateId(ticket, "human-approval")));
      break;
    case "agent.started":
      out.add(ref.agent(event.data.agent_id));
      if (event.data.parent_agent_id) out.add(ref.agent(event.data.parent_agent_id));
      if (event.data.station && ticket) out.add(ref.station(event.data.station, ticket));
      break;
    case "agent.finished":
      out.add(ref.agent(event.data.agent_id));
      break;
    case "tool.started":
    case "tool.finished":
      out.add(ref.agent(event.data.agent_id));
      out.add(ref.tool(event.data.call_id));
      break;
    case "artifact.written":
      out.add(ref.artifact(event.data.artifact_id));
      if (event.data.writer.agent_id) out.add(ref.agent(event.data.writer.agent_id));
      if (event.data.writer.call_id) out.add(ref.tool(event.data.writer.call_id));
      break;
    case "gate.checked":
      if (ticket) out.add(ref.gate(gateId(ticket, event.data.gate)));
      break;
    case "task.red":
    case "task.green":
      if (ticket) out.add(ref.gate(gateId(ticket, "red-before-green")));
      break;
    case "verification.started":
    case "verification.verdict":
    case "evidence.captured":
      if (ticket) out.add(ref.gate(gateId(ticket, "verification", event.data.round)));
      if (event.type === "evidence.captured") for (const id of event.data.evidence) out.add(ref.artifact(id));
      break;
    case "review.started":
    case "review.vote":
    case "review.decided":
      if (ticket) out.add(ref.gate(gateId(ticket, "review", event.data.round)));
      if (event.type === "review.decided" && event.data.outcome === "AWAITING_HUMAN" && ticket) out.add(ref.gate(gateId(ticket, "human-approval")));
      break;
    case "review.finding":
      if (ticket) out.add(ref.gate(gateId(ticket, "review", event.data.round)));
      out.add(ref.finding(event.data.finding_id));
      break;
    case "human.approval_recorded":
      if (ticket) out.add(ref.gate(gateId(ticket, "human-approval")));
      break;
    case "merge.revalidated":
      if (ticket) out.add(ref.gate(gateId(ticket, "merge-revalidation")));
      break;
    default:
      break;
  }
  return [...out];
}
