/**
 * The working floor's places: which bay each ticket stands in, and when (the Floor's working-floor rule).
 *
 * The old rule kept every bay a log had ever called for on the floor, finished or not, so a bay never
 * moved under a person's eyes. What that protected is kept for the tickets at work: a bay never moves
 * while its ticket is at work. What changes is that a finished ticket leaves the working floor: once
 * cleanup has closed it (merged or abandoned, its cleanup record or its run record received), its bay
 * is free. The others stay where they are; a free place is taken by the next ticket that arrives
 * (the lowest free place, so the floor fills from the front).
 *
 * Each claim (a slice, or a cell whose slice is not known: bayOrder's claims) is on the floor for one
 * or more spans of history ("runs": a ticket used again for a new run is a new span). A span holds
 * one place from its first record to its finish (or for good while it is at work). Places are
 * assigned once per span and never change, in a table kept per lineage like bayOrder's, so a late
 * record never moves a bay at work; spans seen together (a replay, a fresh page) are placed in the
 * order of their start, so the same history always gives the same places. The floor's size is the
 * most places in use at once over the history (it only grows), so nothing downstream moves when a
 * ticket leaves.
 *
 * Replay and the timeline: `baysAt(places, t)` is the floor at any moment, so a ticket is in its bay
 * at every moment in the past when it was at work.
 */
import type { SceneLog } from "./log";
import type { CellState, Scene } from "./model";
import { ref } from "./model";
import { bayOrder } from "./selectors";
import { isV3 } from "./v3";

/** One span of a claim on the floor. `to` is null while its ticket has not finished. */
export interface BaySpan {
  /** The claim (its index in bayOrder's table, which never changes) and which of its runs, from 0. */
  readonly claim: string;
  readonly run: number;
  readonly sliceId: string;
  readonly ticketId: string;
  readonly index: number;
  readonly from: number;
  readonly to: number | null;
}

export interface BayPlaces {
  /** Changes whenever a span or its place changes. */
  readonly version: number;
  readonly spans: readonly BaySpan[];
  /** The places on the floor: the most in use at once over the history (at least 1). */
  readonly capacity: number;
}

/** A bay at a moment: the claim, its ticket and its place. */
export interface PlacedSlot {
  readonly sliceId: string;
  readonly ticketId: string;
  readonly index: number;
}

/** When a cell's run finished: its cleanup record or its run record, the earlier; null while it has not. */
export function finishedAt(cell: Pick<CellState, "archived" | "runRecord"> | undefined | null): number | null {
  if (!cell) return null;
  const a = cell.archived?.at ?? null;
  const r = cell.runRecord?.at ?? null;
  return a === null ? r : r === null ? a : Math.min(a, r);
}

/** Whether a cell is off the working floor at t: its run finished at or before t. */
export function isFinishedAt(cell: Pick<CellState, "archived" | "runRecord"> | undefined | null, t: number): boolean {
  const f = finishedAt(cell);
  return f !== null && f <= t;
}

/** What a merged ticket cleanup has not closed yet is called: unfinished business, still on the working floor. */
export const WAITING_FOR_CLEANUP = "Merged, waiting for cleanup";

/** Merged, and not finished yet: cleanup has not closed it. */
export function waitingForCleanup(cell: Pick<CellState, "merged" | "archived" | "runRecord">): boolean {
  return cell.merged !== null && finishedAt(cell) === null;
}

/** How a finished ticket ended, in words: as its merge or its run record says, never guessed. */
export function finishedOutcomeWords(cell: Pick<CellState, "merged" | "runRecord">): string {
  if (cell.merged || cell.runRecord?.outcome === "merged") return "merged";
  if (cell.runRecord?.outcome === "abandoned") return "abandoned";
  return "closed by cleanup, how it ended not recorded";
}

/** The cells that have finished by t, the latest finish first (the Floor's Finished shelf and list). */
export function finishedCells(scene: Scene, t: number): CellState[] {
  return Object.values(scene.cells)
    .filter((c) => isFinishedAt(c, t))
    .sort((a, b) => (finishedAt(b) ?? 0) - (finishedAt(a) ?? 0) || (a.ticketId < b.ticketId ? -1 : 1));
}

interface MutableSpan {
  claim: string;
  run: number;
  sliceId: string;
  ticketId: string;
  index: number;
  from: number;
  to: number | null;
}

interface PlaceTable {
  seen: WeakMap<SceneLog, number>;
  spans: Map<string, MutableSpan>;
  out: BayPlaces;
}
const placeTables = new WeakMap<object, PlaceTable>();

/** `t` of the first retained record that touches an entity, or null. */
function firstT(log: SceneLog, entity: string): number | null {
  return log.entriesFor(entity as Parameters<SceneLog["entriesFor"]>[0])[0]?.t ?? null;
}

/**
 * A claim's runs as [from, to) spans. The run at work (or last finished) is the head scene's cell; a
 * ticket used again (live: a record of another cell instance after its earlier run) had an earlier
 * run from its first record to when the current run opened.
 */
function runsOf(log: SceneLog, scene: Scene, claim: string, ticketId: string): { from: number; to: number | null }[] {
  const sliceFirst = claim.startsWith("cell:") ? null : firstT(log, ref.slice(claim));
  const cell = scene.cells[ticketId];
  if (!cell) return [{ from: sliceFirst ?? -Infinity, to: null }];
  const entries = log.entriesFor(ref.cell(ticketId));
  const cellFirst = entries[0]?.t ?? cell.openedAt;
  const first = Math.min(sliceFirst ?? Infinity, cellFirst);
  const instance = cell.cellInstance;
  const earlier = instance
    ? entries.find((e) => e.t < cell.openedAt && isV3(e.event) && typeof e.event.ids?.cell_instance === "string" && e.event.ids.cell_instance !== "" && e.event.ids.cell_instance !== instance)
    : undefined;
  const to = finishedAt(cell);
  if (earlier) {
    // The earlier run left the floor when its cleanup record or run record came, before this run opened.
    let closed = cell.openedAt;
    for (const e of entries) if (e.t < cell.openedAt && isV3(e.event) && (e.event.type === "cleanup.completed" || e.event.type === "run.recorded")) closed = Math.min(closed, e.t);
    return [{ from: first, to: closed }, { from: cell.openedAt, to }];
  }
  return [{ from: first, to }];
}

const overlaps = (a: { from: number; to: number | null }, b: { from: number; to: number | null }) => a.from < (b.to ?? Infinity) && b.from < (a.to ?? Infinity);

/**
 * The working floor's places for a log's history (see the module's note). Kept per lineage; the same
 * object while nothing changed.
 */
export function bayPlaces(log: SceneLog): BayPlaces {
  const lineage = log.lineage ?? log;
  let table = placeTables.get(lineage);
  const version = log.version();
  if (table && table.seen.get(log) === version) return table.out;
  if (!table) {
    table = { seen: new WeakMap(), spans: new Map(), out: { version: 0, spans: [], capacity: 1 } };
    placeTables.set(lineage, table);
  }
  const scene = log.head();
  const claims = bayOrder(log).slots;
  let changed = false;
  const fresh: (MutableSpan & { order: number })[] = [];
  claims.forEach((claim, order) => {
    runsOf(log, scene, claim.sliceId, claim.ticketId).forEach((r, run) => {
      // Keyed by the claim's bay-order index, which never changes (a cell's claim re-keyed to its
      // slice once known keeps it), so the span and its place survive the re-keying.
      const key = `${order}#${run}`;
      const had = table!.spans.get(key);
      if (!had) {
        fresh.push({ claim: String(order), run, sliceId: claim.sliceId, ticketId: claim.ticketId, index: -1, from: r.from, to: r.to, order });
        return;
      }
      // A placed span keeps its place for good; what it learns later is its ticket, an earlier
      // start (a record read late) and its finish.
      if (had.ticketId !== claim.ticketId || had.sliceId !== claim.sliceId || had.to !== r.to || r.from < had.from) {
        had.ticketId = claim.ticketId;
        had.sliceId = claim.sliceId;
        had.to = r.to;
        had.from = Math.min(had.from, r.from);
        changed = true;
      }
    });
  });
  // New spans, placed in the order they start (then the claim's arrival): the lowest place free for
  // the whole span, the claim's own earlier place first (a ticket used again keeps its bay when free).
  fresh.sort((a, b) => a.from - b.from || a.order - b.order || a.run - b.run);
  const placed = [...table.spans.values()];
  for (const span of fresh) {
    const own = placed.filter((p) => p.claim === span.claim).map((p) => p.index);
    const free = (i: number) => !placed.some((p) => p.index === i && overlaps(p, span));
    let index = own.find(free) ?? -1;
    for (let i = 0; index < 0; i++) if (free(i)) index = i;
    const done: MutableSpan = { claim: span.claim, run: span.run, sliceId: span.sliceId, ticketId: span.ticketId, index, from: span.from, to: span.to };
    table.spans.set(`${span.claim}#${span.run}`, done);
    placed.push(done);
    changed = true;
  }
  table.seen.set(log, version);
  if (changed) {
    const spans = [...table.spans.values()].map((s) => ({ ...s }) as BaySpan);
    table.out = { version: table.out.version + 1, spans, capacity: Math.max(1, ...spans.map((s) => s.index + 1)) };
  }
  return table.out;
}

/** The floor at t: every claim at work then, in its place (by place). */
export function baysAt(places: BayPlaces, t: number): PlacedSlot[] {
  return places.spans
    .filter((s) => s.from <= t && (s.to === null || t < s.to))
    .map((s) => ({ sliceId: s.sliceId, ticketId: s.ticketId, index: s.index }))
    .sort((a, b) => a.index - b.index);
}

/** A key that changes exactly when the floor at t would. */
export function baysKey(places: BayPlaces, t: number): string {
  return `${places.capacity}|${baysAt(places, t)
    .map((s) => `${s.index}:${s.sliceId}=${s.ticketId}`)
    .join("|")}`;
}
