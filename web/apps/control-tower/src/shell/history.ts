/**
 * What the shell reads from a history besides the scene: its significant moments (for the ruler,
 * Theater's caption, the announcer and the inspector's "latest moment"), its landmarks (the
 * simulation's storyboard chapters; for real history, real moments: a wave arriving, the Factory
 * enabled or paused, executions starting and ending, verdicts, a person needed or approving) and the
 * Factory track's marks.
 *
 * For a live log this is built incrementally: each call reads only the entries added since the last
 * one, so a batch of events costs what it adds, not the whole history (200,000 events stay
 * responsive). A late insertion or a reset (the entries before the last one read changed) rebuilds
 * it once. Nothing here is invented: every item is one received event, with its id.
 */
import {
  chapters as storyChapters,
  describeEntry,
  moments as momentsOf,
  ref,
  significanceOf,
  type AnyRef,
  type Fixture,
  type LogEntry,
  type Moment,
  type SceneLog,
} from "../sim";

export interface Landmark {
  /** The event's id (simulation: the chapter's id). */
  readonly id: string;
  readonly t: number;
  readonly title: string;
  /** What it is: a storyboard chapter, or the kind of real moment. */
  readonly kind: "chapter" | "wave" | "factory" | "execution" | "verdict" | "person";
  /** Simulation: the chapter's summary; real history: null. */
  readonly summary: string | null;
}

export interface FactoryMark {
  readonly ref: AnyRef | null;
  readonly t: number;
  readonly kind: "fail" | "person" | "attention" | "merge" | "decision" | "integrated" | "wave";
  readonly text: string;
  /** The event behind it (live and replay), for "Go to event". */
  readonly eventId: string | null;
}

export interface HistoryIndex {
  /** Changes whenever anything below changes. */
  readonly version: number;
  /** Major and chapter-significance moments, ascending by t. */
  readonly moments: readonly Moment[];
  readonly landmarks: readonly Landmark[];
  readonly factoryMarks: readonly FactoryMark[];
  /** True for the simulation's storyboard chapters; false for real moments. */
  readonly storyboard: boolean;
}

const RANKED = new Set(["major", "chapter"]);

/** The kinds that make a real landmark, and what kind of landmark each is. */
const LANDMARK_KINDS: Readonly<Record<string, Landmark["kind"]>> = {
  "wave.discovered": "wave",
  "factory.activated": "factory",
  "factory.paused": "factory",
  "factory.resumed": "factory",
  "factory.disabled": "factory",
  "execution.started": "execution",
  "execution.completed": "execution",
  "execution.failed": "execution",
  "review.decided": "verdict",
  "human.required": "person",
  "human.approval_recorded": "person",
};

function momentOf(entry: LogEntry): Moment | null {
  const event = entry.event;
  if (event.schema_version !== 3) return null;
  const significance = significanceOf(event.type);
  if (!RANKED.has(significance)) return null;
  const ids = (event as { ids?: { ticket_id?: string | null } }).ids;
  return { id: entry.id, seq: (event as { pos?: number }).pos ?? 0, t: entry.t, kind: event.type as Moment["kind"], significance, ticketId: ids?.ticket_id ?? null, text: describeEntry(entry), refs: entry.refs };
}

interface V3Like {
  readonly type: string;
  readonly ids: { readonly wave_id: string | null; readonly slice_id: string | null; readonly ticket_id: string | null };
  readonly data: Record<string, unknown>;
}

/** The Factory track's mark for an entry, people by role only ("a person"). */
function factoryMarkOf(entry: LogEntry, text: () => string): FactoryMark | null {
  const event = entry.event as unknown as V3Like;
  if ((entry.event as { schema_version?: number }).schema_version !== 3) return null;
  const { ids } = event;
  switch (event.type) {
    case "factory.activated":
    case "factory.paused":
    case "factory.resumed":
    case "factory.disabled":
      return { ref: null, t: entry.t, kind: "person", text: text(), eventId: entry.id };
    case "wave.discovered":
      return { ref: ids.wave_id ? ref.wave(ids.wave_id) : null, t: entry.t, kind: "wave", text: text(), eventId: entry.id };
    case "scheduling.decided":
      return { ref: ref.actor("supervisor"), t: entry.t, kind: "decision", text: text(), eventId: entry.id };
    case "slice.integrated":
      return { ref: ids.slice_id ? ref.slice(ids.slice_id) : null, t: entry.t, kind: "integrated", text: text(), eventId: entry.id };
    case "human.required":
      return { ref: ids.ticket_id ? ref.cell(ids.ticket_id) : ids.slice_id ? ref.slice(ids.slice_id) : null, t: entry.t, kind: "attention", text: text(), eventId: entry.id };
    case "human.approval_recorded":
      return { ref: ids.ticket_id ? ref.cell(ids.ticket_id) : null, t: entry.t, kind: "person", text: text(), eventId: entry.id };
    default:
      return null;
  }
}

interface Held {
  version: number;
  logVersion: number;
  /** Absolute count of entries read (dropped + index). */
  read: number;
  lastId: string | null;
  floor: number;
  moments: Moment[];
  landmarks: Landmark[];
  factoryMarks: FactoryMark[];
}

const held = new WeakMap<SceneLog, Held>();
const fixtureHeld = new WeakMap<Fixture, HistoryIndex>();

function readInto(h: Held, entries: readonly LogEntry[], from: number): boolean {
  let changed = false;
  for (let i = from; i < entries.length; i++) {
    const entry = entries[i] as LogEntry;
    let text: string | null = null;
    const say = () => (text ??= describeEntry(entry));
    const m = momentOf(entry);
    if (m) {
      h.moments.push(m);
      text = m.text;
      changed = true;
    }
    const kind = LANDMARK_KINDS[entry.event.type];
    if (kind) {
      h.landmarks.push({ id: entry.id, t: entry.t, title: say(), kind, summary: null });
      changed = true;
    }
    const mark = factoryMarkOf(entry, say);
    if (mark) {
      h.factoryMarks.push(mark);
      changed = true;
    }
  }
  return changed;
}

/** The index of a log, brought up to date with what it holds now. */
export function historyIndexOf(log: SceneLog): HistoryIndex {
  let h = held.get(log);
  const logVersion = log.version();
  if (h && h.logVersion === logVersion) return snapshot(h);
  const entries = log.entries();
  const dropped = log.dropped();
  if (!h) {
    h = { version: 0, logVersion: -1, read: 0, lastId: null, floor: log.floorTime() ?? 0, moments: [], landmarks: [], factoryMarks: [] };
    held.set(log, h);
  }
  const lastIndex = h.read - dropped - 1;
  const appendOnly = h.read === 0 || (lastIndex >= 0 && lastIndex < entries.length && entries[lastIndex]?.id === h.lastId);
  let changed: boolean;
  if (appendOnly) {
    changed = readInto(h, entries, Math.max(0, lastIndex + 1));
  } else {
    // A late event was inserted before what was read, or the oldest were compacted past it: read again once.
    h.moments = [];
    h.landmarks = [];
    h.factoryMarks = [];
    readInto(h, entries, 0);
    changed = true;
  }
  // Compaction: nothing below the floor can be replayed, so it is not offered.
  const floor = log.floorTime() ?? 0;
  if (floor > h.floor) {
    h.floor = floor;
    const keep = <T extends { t: number }>(list: T[]) => (list.length && (list[0] as T).t < floor ? list.filter((x) => x.t >= floor) : list);
    h.moments = keep(h.moments);
    h.landmarks = keep(h.landmarks);
    h.factoryMarks = keep(h.factoryMarks);
    changed = true;
  }
  h.read = dropped + entries.length;
  h.lastId = entries.at(-1)?.id ?? null;
  h.logVersion = logVersion;
  if (changed) h.version += 1;
  return snapshot(h);
}

// One object per version, so React selectors can compare by identity.
const snapshots = new WeakMap<Held, HistoryIndex>();
function snapshot(h: Held): HistoryIndex {
  const prior = snapshots.get(h);
  if (prior && prior.version === h.version) return prior;
  const next: HistoryIndex = { version: h.version, moments: h.moments, landmarks: h.landmarks, factoryMarks: h.factoryMarks, storyboard: false };
  snapshots.set(h, next);
  return next;
}

/** The simulation's index: its storyboard chapters and its major moments, computed once. */
export function fixtureIndexOf(fixture: Fixture): HistoryIndex {
  let index = fixtureHeld.get(fixture);
  if (index) return index;
  index = {
    version: 0,
    moments: momentsOf(fixture, "major"),
    landmarks: storyChapters(fixture).map((c) => ({ id: c.id, t: c.t, title: c.title, kind: "chapter" as const, summary: c.summary })),
    factoryMarks: [],
    storyboard: true,
  };
  fixtureHeld.set(fixture, index);
  return index;
}

/** The index for a store's state: the fixture's for the simulation, the log's otherwise. */
export function indexFor(state: { readonly source: string; readonly fixture: Fixture; readonly log: SceneLog }): HistoryIndex {
  return state.source === "simulation" ? fixtureIndexOf(state.fixture) : historyIndexOf(state.log);
}

/** The last item at or before t, by binary search over an ascending list. */
export function lastAtOrBefore<T extends { t: number }>(list: readonly T[], t: number): T | null {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((list[mid] as T).t <= t) lo = mid + 1;
    else hi = mid;
  }
  return list[lo - 1] ?? null;
}

/** How many items have t <= the given time. */
export function countAtOrBefore<T extends { t: number }>(list: readonly T[], t: number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((list[mid] as T).t <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
