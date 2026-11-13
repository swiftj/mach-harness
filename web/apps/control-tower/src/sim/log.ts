/**
 * The scene log: the incremental engine behind every scene, for all three sources.
 *
 * It replaces M6.0's "reduce the whole fixture once and keep every scene" (engine.ts before M6.2,
 * architecture 6.3) with a structure fit for an unbounded live stream:
 *
 * - **Ordered, de-duplicated events.** Entries are kept sorted by the contract's history `order`
 *   (6.3). An event whose id is already held is dropped (same content: a duplicate; different
 *   content: a conflict, counted, the first kept), so a re-delivery never produces a second
 *   transition.
 * - **Checkpoints plus forward application.** The scene after every `checkpointEvery`-th event is
 *   kept; any other scene is reduced forward from the nearest checkpoint (or nearer cached scene),
 *   at most `checkpointEvery - 1` reductions. Recently asked scenes are kept in a small LRU, so the
 *   same `t` gives the same object while it is in use (React's `===` change detection).
 * - **Appends are O(1) reductions.** An event that sorts after everything held is reduced onto the
 *   head scene.
 * - **Late events re-derive.** An event that sorts before the head is inserted in order; every
 *   checkpoint and cached scene after it is dropped and the scenes are re-derived from the nearest
 *   checkpoint at or before it. Cost: (events after the checkpoint) reductions, counted in
 *   `stats().rederived`. Within the observer's settle window late events are rare and recent, so the
 *   cost is small; the worst case (an event older than everything) is a full re-reduction.
 * - **Stable identity.** After a re-derivation the new head is interned against the old one
 *   (`reuse`): every entity whose content did not change keeps its object, so React does not
 *   re-render it.
 * - **Bounded memory.** With `retain`, the oldest events beyond it are dropped at a checkpoint
 *   boundary (compaction); the checkpoint becomes the floor. Scenes stay complete (the floor scene
 *   holds everything before it), only replay cannot go below the floor. An event older than the
 *   floor is refused (`belowFloor`).
 *
 * The log is a mutable container of immutable scenes: `ingest` changes which scenes exist, never a
 * scene already handed out. No randomness and no wall clock (test/purity.test.mjs).
 */
import { actorOf } from "./actors";
import type { AnyRef, EntityRef, ProductDefinitions, Scene } from "./model";
import { ref } from "./model";
import type { Authority, SceneProvenance } from "./provenance";
import { actorOfV3 } from "./reduce-v3";
import { beginTransient, emptyScene, endTransient, reduce } from "./reducer";
import { simRefsOf } from "./sim-refs";
import type { EngineEvent, Precision } from "./v3";
import { eventIdOf, eventOrderOf, eventTimeOf, isEntityRefString, isV3 } from "./v3";

export interface LogEntry {
  readonly id: string;
  /** History order key (contract 6.3). Entries are sorted by it. */
  readonly order: string;
  /** Place on the time axis: scenario ms (simulation) or `order_ms` (live, replay). */
  readonly t: number;
  readonly event: EngineEvent;
  /** The entities the event touches: the observer's `entities` (v3), or derived for the simulation. */
  readonly refs: readonly EntityRef[];
  readonly actor: AnyRef | null;
  readonly authority: Authority;
  readonly precision: Precision | "simulated";
  /** It arrived after an event that sorts after it, and was inserted (or the observer flagged it `late`). */
  readonly late: boolean;
}

export interface IngestResult {
  readonly added: number;
  readonly duplicates: number;
  readonly conflicts: number;
  /** Inserted before the head. */
  readonly late: number;
  /** Refused: older than the retained floor. */
  readonly belowFloor: number;
  /** Reductions spent re-deriving scenes after late inserts. */
  readonly rederived: number;
  /** `t` of the earliest event added, or null if nothing was. */
  readonly earliest: number | null;
}

export interface LogStats {
  readonly events: number;
  readonly dropped: number;
  readonly checkpoints: number;
  readonly cached: number;
  readonly duplicates: number;
  readonly conflicts: number;
  readonly late: number;
  readonly belowFloor: number;
  readonly rederived: number;
  readonly reductions: number;
  readonly compactions: number;
  readonly version: number;
}

export interface SceneLogOptions {
  readonly definitions: ProductDefinitions;
  readonly provenance: SceneProvenance;
  /** Keep the scene after every N-th event (default 128). */
  readonly checkpointEvery?: number;
  /** Scenes kept besides checkpoints, least recently used dropped first (default 256). */
  readonly cacheSize?: number;
  /**
   * Beyond this many events behind the head, keep only every `thinFactor`-th checkpoint (default
   * 8,192 and 8): recent history scrubs fast, far history costs less memory (default: far scenes
   * are at most 8 x checkpointEvery reductions away).
   */
  readonly denseWindow?: number;
  readonly thinFactor?: number;
  /** Events kept; older ones are compacted into the floor checkpoint (default: all). */
  readonly retain?: number;
  /**
   * Logs that show parts of the same history (a live log and the history windows read behind it, or
   * a replay's windows) share one lineage object, so what a view assigns per history (the Atlas's
   * bays) stays the same whichever part is shown. Default: the log is its own lineage.
   */
  readonly lineage?: object;
}

export interface SceneLog {
  readonly kind: "scene-log";
  readonly provenance: SceneProvenance;
  readonly definitions: ProductDefinitions;
  /** The history this log shows part of (SceneLogOptions.lineage); the log itself when it has none. */
  readonly lineage: object;
  /** Increases whenever the set of events changes. */
  version(): number;
  /** Events applied by the head scene, including those compacted away. */
  size(): number;
  /** Retained entries, in history order. Do not mutate. */
  entries(): readonly LogEntry[];
  /** `t` of each retained entry, ascending (parallel to entries()). */
  times(): readonly number[];
  /** Absolute index of entries()[0] (how many events were compacted away). */
  dropped(): number;
  ingest(events: readonly EngineEvent[]): IngestResult;
  /** Scene after `cursor` events (absolute), clamped to [dropped, size]. */
  sceneAtCursor(cursor: number): Scene;
  /** Scene with every event of t <= `t` applied. */
  sceneAt(t: number): Scene;
  /** The scene after every event received so far. Not "final": a live log has no end. */
  head(): Scene;
  /** Events with t <= `t` (absolute count). */
  cursorAt(t: number): number;
  entry(id: string): LogEntry | undefined;
  /** Retained entries that touch an entity (or actor), in history order. */
  entriesFor(entity: AnyRef): readonly LogEntry[];
  /** `t` of the earliest retained event, or null when empty. */
  floorTime(): number | null;
  /** `t` of the latest event received, or null when empty. */
  headTime(): number | null;
  stats(): LogStats;
}

export function isSceneLog(value: unknown): value is SceneLog {
  return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "scene-log";
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

/** First index of an entry whose order is greater than `order`. */
function upperBoundOrder(list: readonly LogEntry[], order: string): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((list[mid] as LogEntry).order <= order) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The content of an event without its delivery facts (position, lateness, when the observer read it). */
function fingerprint(event: EngineEvent): string {
  if (!isV3(event)) return JSON.stringify(event);
  const { pos: _pos, late: _late, time, ...rest } = event;
  return JSON.stringify({ ...rest, time: { ...time, observed_at: "" } });
}

const EMPTY_REFS: readonly EntityRef[] = Object.freeze([]) as readonly EntityRef[];

/**
 * Keep every part of `next` that equals the corresponding part of `prev` as `prev`'s object, so
 * consumers comparing by identity see no change where there was none. Plain data only.
 */
export function reuse<T>(prev: T, next: T): T {
  if (prev === next) return prev;
  if (typeof prev !== "object" || typeof next !== "object" || prev === null || next === null) return Object.is(prev, next) ? prev : next;
  if (Array.isArray(prev) !== Array.isArray(next)) return next;
  if (Array.isArray(prev) && Array.isArray(next)) {
    let same = prev.length === next.length;
    const out = next.map((value: unknown, i: number) => {
      const kept = i < prev.length ? reuse(prev[i], value) : value;
      if (kept !== prev[i]) same = false;
      return kept;
    });
    return (same ? prev : out) as T;
  }
  const p = prev as Record<string, unknown>;
  const n = next as Record<string, unknown>;
  const keys = Object.keys(n);
  let same = keys.length === Object.keys(p).length;
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const kept = key in p ? reuse(p[key], n[key]) : n[key];
    if (kept !== p[key]) same = false;
    out[key] = kept;
  }
  return (same ? prev : out) as T;
}

export function createSceneLog(options: SceneLogOptions): SceneLog {
  const { definitions, provenance } = options;
  const every = Math.max(1, Math.floor(options.checkpointEvery ?? 128));
  const cacheSize = Math.max(1, Math.floor(options.cacheSize ?? 256));
  const retain = options.retain ?? Infinity;
  const denseWindow = options.denseWindow ?? 8192;
  const sparse = every * Math.max(1, Math.floor(options.thinFactor ?? 8));
  let thinnedBelow = 0;

  let entries: LogEntry[] = [];
  let times: number[] = [];
  let dropped = 0;
  let floorOrder: string | null = null;
  const byId = new Map<string, LogEntry>();
  const checkpoints = new Map<number, Scene>();
  const cache = new Map<number, Scene>();
  const refIndex = new Map<string, LogEntry[]>();
  const simDeps = new Map<string, readonly string[]>();
  let head = emptyScene(definitions, provenance);
  checkpoints.set(0, head);
  let version = 0;
  const totals = { duplicates: 0, conflicts: 0, late: 0, belowFloor: 0, rederived: 0, reductions: 0, compactions: 0 };

  const total = (): number => dropped + entries.length;

  /** Drop checkpoints far behind the head that are not on the sparse grid (the floor is always kept). */
  const thin = (): void => {
    const limit = total() - denseWindow;
    if (limit - thinnedBelow < sparse) return;
    for (const key of [...checkpoints.keys()]) if (key < limit && key > dropped && key % sparse !== 0) checkpoints.delete(key);
    thinnedBelow = limit;
  };

  /** The latest checkpoint at or before an index (dense grid, then sparse grid, then the floor). */
  const checkpointAtOrBefore = (index: number): number => {
    const dense = index - (index % every);
    if (dense >= dropped && checkpoints.has(dense)) return dense;
    const far = index - (index % sparse);
    if (far >= dropped && checkpoints.has(far)) return far;
    for (let k = dense; k > dropped; k -= every) if (checkpoints.has(k)) return k;
    return dropped;
  };

  const remember = (index: number, scene: Scene): void => {
    if (cache.has(index)) cache.delete(index);
    cache.set(index, scene);
    while (cache.size > cacheSize) cache.delete(cache.keys().next().value as number);
  };

  const step = (scene: Scene, entry: LogEntry): Scene => {
    totals.reductions += 1;
    return reduce(scene, entry.event, definitions);
  };

  const makeEntry = (event: EngineEvent): LogEntry => {
    if (isV3(event)) {
      const refs = !event.entities.length ? EMPTY_REFS : event.entities.every(isEntityRefString) ? (event.entities as readonly EntityRef[]) : (event.entities.filter(isEntityRefString) as EntityRef[]);
      const actor = actorOfV3(event);
      return {
        id: event.id,
        order: event.order,
        t: event.time.order_ms,
        event,
        refs,
        actor: actor ? ref.actor(actor) : null,
        authority: event.type.startsWith("client.") ? "reconstructed" : (event.authority as Authority),
        precision: event.time.precision,
        late: event.late,
      };
    }
    if (event.type === "slice.materialized" && event.slice_id) simDeps.set(event.slice_id, event.data.dependencies);
    const actor = actorOf(event);
    return { id: eventIdOf(event), order: eventOrderOf(event), t: eventTimeOf(event), event, refs: simRefsOf(event, simDeps), actor: actor ? ref.actor(actor) : null, authority: "simulated", precision: "simulated", late: false };
  };

  const indexRefs = (entry: LogEntry): void => {
    const all = entry.actor ? [...entry.refs, entry.actor] : entry.refs;
    for (const r of all) {
      const list = refIndex.get(r);
      if (!list) refIndex.set(r, [entry]);
      else if ((list[list.length - 1] as LogEntry).order < entry.order) list.push(entry);
      else list.splice(upperBoundOrder(list, entry.order), 0, entry);
    }
  };

  const compact = (): void => {
    if (!(entries.length > retain)) return;
    const slack = Math.max(every, Math.floor(retain / 10));
    if (entries.length < retain + slack) return;
    const cut = total() - retain;
    let floor = cut - (cut % every);
    while (floor > dropped && !checkpoints.has(floor)) floor -= every;
    if (floor <= dropped) return;
    const remove = floor - dropped;
    const removed = entries.slice(0, remove);
    entries = entries.slice(remove);
    times = times.slice(remove);
    floorOrder = (removed[removed.length - 1] as LogEntry).order;
    const gone = new Set<LogEntry>(removed);
    for (const entry of removed) byId.delete(entry.id);
    for (const [key, list] of refIndex) {
      let k = 0;
      while (k < list.length && gone.has(list[k] as LogEntry)) k++;
      if (k === list.length) refIndex.delete(key);
      else if (k > 0) refIndex.set(key, list.slice(k));
    }
    for (const key of [...checkpoints.keys()]) if (key < floor) checkpoints.delete(key);
    for (const key of [...cache.keys()]) if (key < floor) cache.delete(key);
    dropped = floor;
    totals.compactions += 1;
  };

  const ingest = (events: readonly EngineEvent[]): IngestResult => {
    let duplicates = 0;
    let conflicts = 0;
    let belowFloor = 0;
    const fresh: LogEntry[] = [];
    const seen = new Map<string, LogEntry>();
    for (const event of events) {
      const id = eventIdOf(event);
      const held = byId.get(id) ?? seen.get(id);
      if (held) {
        if (fingerprint(held.event) === fingerprint(event)) duplicates += 1;
        else conflicts += 1;
        continue;
      }
      const entry = makeEntry(event);
      if (floorOrder !== null && entry.order <= floorOrder) {
        belowFloor += 1;
        continue;
      }
      seen.set(id, entry);
      fresh.push(entry);
    }
    totals.duplicates += duplicates;
    totals.conflicts += conflicts;
    totals.belowFloor += belowFloor;
    if (!fresh.length) return { added: 0, duplicates, conflicts, late: 0, belowFloor, rederived: 0, earliest: null };

    fresh.sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0));
    const lastOrder = entries.length ? (entries[entries.length - 1] as LogEntry).order : null;
    const first = fresh[0] as LogEntry;
    let lateCount = 0;
    let rederived = 0;

    if (lastOrder === null || first.order > lastOrder) {
      // Appends only: reduce onto the head. Intermediate scenes are discarded, so the run is transient
      // (records the run created are updated in place); every scene kept is sealed first.
      beginTransient();
      try {
        for (const entry of fresh) {
          entries.push(entry);
          times.push(entry.t);
          byId.set(entry.id, entry);
          indexRefs(entry);
          head = step(head, entry);
          const index = total();
          if (index % every === 0) {
            endTransient();
            checkpoints.set(index, head);
            beginTransient();
          }
        }
      } finally {
        endTransient();
      }
    } else {
      // At least one late event: merge in order, then re-derive from the checkpoint at or before the first change.
      const lateIds = new Set<string>();
      for (const entry of fresh) if (lastOrder !== null && entry.order < lastOrder) lateIds.add(entry.id);
      // Lateness to this client is a delivery fact: it is on the entry (`isLateEntry`), never in the
      // scene, so the same history gives the same scene in any delivery order. The scene's `late`
      // fields carry the observer's own flag (the event's `late`), which is part of the record.
      const incoming = fresh.map((entry) => (lateIds.has(entry.id) && !entry.late ? { ...entry, late: true } : entry));
      const merged: LogEntry[] = new Array(entries.length + incoming.length);
      let i = 0;
      let j = 0;
      let k = 0;
      let firstChange = -1;
      while (i < entries.length || j < incoming.length) {
        const a = entries[i];
        const b = incoming[j];
        if (b && (!a || b.order < a.order)) {
          if (firstChange < 0) firstChange = k;
          merged[k++] = b;
          j++;
        } else {
          merged[k++] = a as LogEntry;
          i++;
        }
      }
      lateCount = lateIds.size;
      entries = merged;
      times = merged.map((x) => x.t);
      for (const entry of incoming) {
        byId.set(entry.id, entry);
        indexRefs(entry);
      }
      const changedAt = dropped + firstChange;
      for (const key of [...checkpoints.keys()]) if (key > changedAt) checkpoints.delete(key);
      for (const key of [...cache.keys()]) if (key > changedAt) cache.delete(key);
      const start = checkpointAtOrBefore(changedAt);
      let scene = checkpoints.get(start) as Scene;
      const end = total();
      beginTransient();
      try {
        for (let index = start; index < end; index++) {
          scene = step(scene, entries[index - dropped] as LogEntry);
          if ((index + 1) % every === 0) {
            endTransient();
            checkpoints.set(index + 1, scene);
            beginTransient();
          }
        }
      } finally {
        endTransient();
      }
      rederived = end - start;
      const interned = reuse(head, scene);
      if (end % every === 0) checkpoints.set(end, interned);
      head = interned;
    }
    totals.late += lateCount;
    totals.rederived += Math.max(0, rederived);
    version += 1;
    thin();
    compact();
    return { added: fresh.length, duplicates, conflicts, late: lateCount, belowFloor, rederived: Math.max(0, rederived), earliest: first.t };
  };

  const sceneAtCursor = (cursor: number): Scene => {
    const end = total();
    const k = Math.max(dropped, Math.min(Math.floor(cursor), end));
    if (k === end) return head;
    const hit = cache.get(k) ?? checkpoints.get(k);
    if (hit) {
      if (cache.has(k)) remember(k, hit);
      return hit;
    }
    let start = checkpointAtOrBefore(k);
    let scene = checkpoints.get(start) as Scene;
    for (let j = k - 1; j > start; j--) {
      const near = cache.get(j);
      if (near) {
        start = j;
        scene = near;
        break;
      }
    }
    // Long runs are transient (only the scene asked for is kept); a short step keeps every scene it passes, for stepping.
    const long = k - start > 8;
    if (long) beginTransient();
    try {
      for (let index = start; index < k; index++) {
        scene = step(scene, entries[index - dropped] as LogEntry);
        if (!long) remember(index + 1, scene);
      }
    } finally {
      if (long) endTransient();
    }
    remember(k, scene);
    return scene;
  };

  const log: SceneLog = {
    kind: "scene-log",
    provenance,
    definitions,
    get lineage() {
      return options.lineage ?? log;
    },
    version: () => version,
    size: total,
    entries: () => entries,
    times: () => times,
    dropped: () => dropped,
    ingest,
    sceneAtCursor,
    sceneAt: (t) => sceneAtCursor(dropped + upperBound(times, t)),
    head: () => head,
    cursorAt: (t) => dropped + upperBound(times, t),
    entry: (id) => byId.get(id),
    entriesFor: (entity) => refIndex.get(entity) ?? EMPTY_REFS_ENTRIES,
    floorTime: () => (times.length ? (times[0] as number) : null),
    headTime: () => (times.length ? (times[times.length - 1] as number) : null),
    stats: () => ({ events: entries.length, dropped, checkpoints: checkpoints.size, cached: cache.size, ...totals, version }),
  };
  return log;
}

const EMPTY_REFS_ENTRIES: readonly LogEntry[] = Object.freeze([]) as readonly LogEntry[];
