/**
 * What the shell reads from a history besides the scene: its significant moments (for the Line's
 * "What just happened", Theater's caption, the announcer and the inspector's "latest moment") and its
 * landmarks (the simulation's storyboard chapters; for real history, real moments: the Factory
 * enabled or paused, executions starting and ending, verdicts, a person needed or
 * approving).
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
  isV3,
  moments as momentsOf,
  type Fixture,
  type Moment,
  type SceneLog,
} from "../sim";
import { eventQuotesFreeText } from "../text/fields";

export interface Landmark {
  /** The event's id (simulation: the chapter's id). */
  readonly id: string;
  readonly t: number;
  readonly title: string;
  /** What it is: a storyboard chapter, or the kind of real moment. */
  readonly kind: "chapter" | "factory" | "execution" | "verdict" | "person";
  /** Simulation: the chapter's summary; real history: null. */
  readonly summary: string | null;
  /** Real history, when its title quotes prose the observer has not checked for names: the event's kind; otherwise (and the simulation) null. */
  readonly eventType: string | null;
}

export interface HistoryIndex {
  /** Changes whenever anything below changes. */
  readonly version: number;
  /** Major and chapter-significance moments, ascending by t. */
  readonly moments: readonly Moment[];
  readonly landmarks: readonly Landmark[];
  /** True for the simulation's storyboard chapters; false for real moments. */
  readonly storyboard: boolean;
}

/** The kinds that make a real landmark, and what kind of landmark each is. */
const LANDMARK_KINDS: Readonly<Record<string, Landmark["kind"]>> = {
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

const landmarkFold = createLogFold<Landmark>((entry) => {
  const kind = LANDMARK_KINDS[entry.event.type];
  if (!kind || !isV3(entry.event)) return null;
  const title = describeEntry(entry);
  return { id: entry.id, t: entry.t, title, kind, summary: null, eventType: eventQuotesFreeText(entry.event, undefined, title) ? entry.event.type : null };
});

const fixtureHeld = new WeakMap<Fixture, HistoryIndex>();

/** One index object per combination of the folds' states, so React selectors can compare by identity. */
const indexes = new WeakMap<SceneLog, { parts: readonly unknown[]; index: HistoryIndex }>();

/** The index of a log, brought up to date with what it holds now (incrementally: see the header). */
export function historyIndexOf(log: SceneLog): HistoryIndex {
  const moments = momentsOf(log, "major");
  const landmarks = landmarkFold(log);
  const held = indexes.get(log);
  const parts = [moments, landmarks];
  if (held && held.parts.every((p, i) => p === parts[i])) return held.index;
  const index: HistoryIndex = { version: (held?.index.version ?? 0) + 1, moments, landmarks: landmarks.items, storyboard: false };
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
