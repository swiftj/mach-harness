/**
 * What the shell reads from a history besides the scene: its significant moments (for the ruler,
 * Theater's caption, the announcer and the inspector's "latest moment"), its landmarks (the
 * simulation's storyboard chapters; for real history, real moments: a wave arriving, the Factory
 * enabled or paused, executions starting and ending, verdicts, a person needed or approving) and the
 * Factory track's marks.
 *
 * For a live log this is built incrementally by the scene model's shared folds (src/sim/fold.ts, the
 * same one `moments(log)` uses): each call reads only the entries added since the last one, so a
 * batch of events costs what it adds, not the whole history. A late insertion or a reset rebuilds it
 * once. Nothing here is invented: every item is one received event, with its id.
 */
import {
  chapters as storyChapters,
  createLogFold,
  describeEntry,
  moments as momentsOf,
  ref,
  type AnyRef,
  type Fixture,
  type LogEntry,
  type Moment,
  type SceneLog,
} from "../sim";
import { codesOnlyWords, eventQuotesFreeText } from "../text/fields";

export interface Landmark {
  /** The event's id (simulation: the chapter's id). */
  readonly id: string;
  readonly t: number;
  readonly title: string;
  /** What it is: a storyboard chapter, or the kind of real moment. */
  readonly kind: "chapter" | "wave" | "factory" | "execution" | "verdict" | "person";
  /** Simulation: the chapter's summary; real history: null. */
  readonly summary: string | null;
  /** Real history, when its title quotes prose the observer has not checked for names: the event's kind; otherwise (and the simulation) null. */
  readonly eventType: string | null;
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

interface V3Like {
  readonly type: string;
  readonly ids: { readonly wave_id: string | null; readonly slice_id: string | null; readonly ticket_id: string | null };
  readonly data: Record<string, unknown>;
}

/** The Factory track's mark for an entry, people by role only ("a person"). */
function factoryMarkOf(entry: LogEntry): FactoryMark | null {
  const event = entry.event as unknown as V3Like;
  if ((entry.event as { schema_version?: number }).schema_version !== 3) return null;
  const { ids } = event;
  // A mark is named in hover cards: an event that carries prose is said by its kind, never quoted (C1).
  const text = (): string => {
    const words = describeEntry(entry);
    return (eventQuotesFreeText(event, undefined, words) ? codesOnlyWords(event.type, ids.ticket_id ?? ids.slice_id ?? ids.wave_id) : null) ?? words;
  };
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

const landmarkFold = createLogFold<Landmark>((entry) => {
  const kind = LANDMARK_KINDS[entry.event.type];
  if (!kind || entry.event.schema_version !== 3) return null;
  const title = describeEntry(entry);
  return { id: entry.id, t: entry.t, title, kind, summary: null, eventType: eventQuotesFreeText(entry.event, undefined, title) ? entry.event.type : null };
});
const markFold = createLogFold<FactoryMark>(factoryMarkOf);

const fixtureHeld = new WeakMap<Fixture, HistoryIndex>();

/** One index object per combination of the folds' states, so React selectors can compare by identity. */
const indexes = new WeakMap<SceneLog, { parts: readonly unknown[]; index: HistoryIndex }>();

/** The index of a log, brought up to date with what it holds now (incrementally: see the header). */
export function historyIndexOf(log: SceneLog): HistoryIndex {
  const moments = momentsOf(log, "major");
  const landmarks = landmarkFold(log);
  const marks = markFold(log);
  const held = indexes.get(log);
  const parts = [moments, landmarks, marks];
  if (held && held.parts.every((p, i) => p === parts[i])) return held.index;
  const index: HistoryIndex = { version: (held?.index.version ?? 0) + 1, moments, landmarks: landmarks.items, factoryMarks: marks.items, storyboard: false };
  indexes.set(log, { parts, index });
  return index;
}

/** The simulation's index: its storyboard chapters and its major moments, computed once. */
export function fixtureIndexOf(fixture: Fixture): HistoryIndex {
  let index = fixtureHeld.get(fixture);
  if (index) return index;
  index = {
    version: 0,
    moments: momentsOf(fixture, "major"),
    landmarks: storyChapters(fixture).map((c) => ({ id: c.id, t: c.t, title: c.title, kind: "chapter" as const, summary: c.summary, eventType: null })),
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

/**
 * A moment's kind when its sentence quotes free text (I-05), else null: the moment's event, looked up in
 * the log, holds a value at one of the policy's prose paths. The simulation's storyboard never does.
 */
export function quotingKindOf(log: { entry(id: string): { readonly event: { readonly type: string } } | undefined }, moment: { readonly id: string; readonly kind: string; readonly text: string }): string | null {
  const e = log.entry(moment.id);
  return e && eventQuotesFreeText(e.event, undefined, moment.text) ? moment.kind : null;
}
