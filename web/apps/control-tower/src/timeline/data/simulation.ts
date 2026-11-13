/**
 * The Timeline's data for the simulation, which has no observer: the same span shape derived from
 * the scene (scene.ts), marks from the scene's recorded moments and gate log, density from the log's
 * entries, concurrency by sweeping the derived spans. Derived once per log version from the log's
 * head; each answer is then cut at the store's `liveAt`, because the simulation's future is already
 * recorded and nothing after the simulated now may be shown (no span not yet begun, no end or
 * outcome not yet reached).
 */
import type { SceneStore } from "../../scene/store";
import type { ConcurrencySeries, MarkKind, SpanPage, TimeWindow, TimelineData, TimelineMark, TimelineSpan } from "../contract";
import { abortError } from "./cache";
import { ALL_AVAILABLE } from "./availability";
import { byStart, closeEndedVisits, concurrencyOf, cutAt, densityOf, honest, spanMatches, type ConcurrencyLimit } from "./derive";
import { marksOfScene, spansOfScene } from "./scene";
import { storeWatcher, THROTTLE_MS, type TimerLike } from "./watch";

export interface SimulationTimelineOptions {
  readonly timers?: TimerLike;
  readonly throttleMs?: number;
  /**
   * The source to report. The simulation's own; a live or replay store with no observer client (it
   * never happens in the app, but a test or a static build can) derives from its scene the same way
   * and says where the scenes came from, never "simulation".
   */
  readonly source?: TimelineData["source"];
}

interface Derived {
  readonly log: unknown;
  readonly version: number;
  readonly spans: readonly TimelineSpan[];
  readonly marks: readonly TimelineMark[];
  readonly limits: ConcurrencySeries["limits"];
}

export function createSimulationTimelineData(store: SceneStore, options: SimulationTimelineOptions = {}): TimelineData {
  let held: Derived | null = null;
  const derived = (): Derived => {
    const { log } = store.getState();
    const version = log.version();
    if (held && held.log === log && held.version === version) return held;
    const head = log.head();
    const spans = honest(spansOfScene(head, log));
    // As the observer says it: max_parallel bounds executions (and the cells they run).
    const limits: ConcurrencyLimit[] = head.factory.limits ? [{ name: "max_parallel", value: head.factory.limits.max_parallel, from: log.floorTime() ?? 0, to: null, appliesTo: ["execution", "cell"] }] : [];
    held = { log, version, spans, marks: marksOfScene(head, spans), limits };
    return held;
  };
  /** The spans as they stood at the simulated now. */
  const heldAt = (liveAt: number): TimelineSpan[] => {
    const out: TimelineSpan[] = [];
    for (const s of derived().spans) {
      const cut = cutAt(s, liveAt);
      if (cut) out.push(cut);
    }
    // The scene closes a visit whose execution ended without its exit (StationVisit.unclosed); the same
    // rule applied to the cut set keeps any other such visit from reading as still running.
    return closeEndedVisits(out);
  };
  const check = (signal?: AbortSignal) => {
    if (signal?.aborted) throw abortError(signal);
  };
  const marksAt = (liveAt: number, kinds?: readonly MarkKind[]): TimelineMark[] =>
    derived()
      .marks.filter((m) => m.at <= liveAt && (!kinds?.length || kinds.includes(m.kind)))
      .map((m) => (m.until !== null && m.until > liveAt ? { ...m, until: null } : m));

  const watcher = storeWatcher(store, {
    timers: options.timers,
    throttleMs: options.throttleMs ?? THROTTLE_MS,
    changed: (prev, next) => prev.logVersion !== next.logVersion || prev.log !== next.log || prev.liveAt !== next.liveAt,
  });

  return {
    source: options.source ?? "simulation",
    extent() {
      const { extent } = store.getState();
      return { from: extent.start, to: Math.max(extent.start, extent.end) };
    },
    async spans(query, signal): Promise<SpanPage> {
      check(signal);
      const { liveAt, log } = store.getState();
      const spans = heldAt(liveAt).filter((s) => spanMatches(s, query)).sort(byStart);
      return { spans, truncated: false, total: spans.length, version: `sim:${log.version()}:${liveAt}` };
    },
    async span(id, signal) {
      check(signal);
      const found = derived().spans.find((s) => s.id === id);
      if (!found) return null;
      const liveAt = store.getState().liveAt;
      // A visit is read with its execution, so the closing rule applies to it as in spans().
      return found.kind === "visit" ? (heldAt(liveAt).find((s) => s.id === id) ?? null) : cutAt(found, liveAt);
    },
    async marks(window: TimeWindow, kinds, signal) {
      check(signal);
      return marksAt(store.getState().liveAt, kinds).filter((m) => m.at <= window.to && (m.until ?? m.at) >= window.from);
    },
    async nextMark(t, direction, kinds, signal) {
      check(signal);
      const marks = marksAt(store.getState().liveAt, kinds);
      if (direction === 1) return marks.find((m) => m.at > t) ?? null;
      for (let i = marks.length - 1; i >= 0; i--) if ((marks[i] as TimelineMark).at < t) return marks[i] as TimelineMark;
      return null;
    },
    async density(window, buckets, filter, signal) {
      check(signal);
      const { log, liveAt } = store.getState();
      let times: number[];
      const filtered = Boolean(filter?.ticket || filter?.execution);
      if (filter?.ticket || filter?.execution) {
        const refs = new Set([filter.ticket ? `cell:${filter.ticket}` : null, filter.execution ? `execution:${filter.execution}` : null].filter((x): x is string => x !== null));
        times = log
          .entries()
          .filter((e) => e.refs.some((r) => refs.has(r) || [...refs].some((x) => x.startsWith("cell:") && r.startsWith(`station:${x.slice(5)}/`))))
          .map((e) => e.t);
      } else times = log.times() as number[];
      return { ...densityOf(times.filter((t) => t <= liveAt), window, buckets, true), filtered };
    },
    async concurrency(window, buckets, signal) {
      check(signal);
      const { liveAt } = store.getState();
      return concurrencyOf(heldAt(liveAt), window, buckets, liveAt, derived().limits, true);
    },
    availability: () => ALL_AVAILABLE,
    subscribe: watcher.subscribe,
  };
}
