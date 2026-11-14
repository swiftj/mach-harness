/**
 * Pure helpers the Timeline's controls and its workspace share: framing a window on a selection,
 * panning to a moment, what the filters can offer, the jump list, and which store ref a span stands
 * for. No React, no store: test/timeline-shell.test.mjs runs them in node.
 */
import {
  extentOf,
  MIN_WINDOW_MS,
  overlaps,
  type DensitySeries,
  type LensDefinition,
  type MarkKind,
  type SpanKind,
  type TimeWindow,
  type TimelineFilters,
  type TimelineMark,
  type TimelineSpan,
  type TimelineViewState,
  type TrackNode,
  type TrackTree,
} from "../contract";
import { clockAt, getTimeBase } from "../../shell/time";

// ---------------------------------------------------------------- windows: chosen, all, and the default

/**
 * The window the person asked to be "all of the history held": stored as unbounded, drawn as the
 * whole history at that moment, so it keeps following the live edge. `null` in the store is the other
 * case: nothing chosen, so the Timeline frames the recorded activity (see `activityWindow`).
 */
export const ALL_WINDOW: TimeWindow = Object.freeze({ from: Number.NEGATIVE_INFINITY, to: Number.POSITIVE_INFINITY });

/**
 * A window of a fixed length that follows the live edge (L1 of the live run: a lens chosen while
 * following froze the tracks). Stored as `{ from: -length, to: +Infinity }`: drawn as the last
 * `length` ms of the history up to the live edge, whatever the edge is now.
 */
export function followWindow(length: number): TimeWindow {
  return { from: -Math.max(MIN_WINDOW_MS, Math.round(length)), to: Number.POSITIVE_INFINITY };
}

/** Whether a stored window follows the live edge at a fixed length (`followWindow`). */
export function isFollow(w: TimeWindow | null): boolean {
  return w !== null && Number.isFinite(w.from) && w.from < 0 && w.to === Number.POSITIVE_INFINITY;
}

/** The length a following window shows. */
export function followLength(w: TimeWindow): number {
  return -w.from;
}

/** Whether a stored window means "all of the history held". */
export function isAll(w: TimeWindow | null): boolean {
  return w !== null && !isFollow(w) && (!Number.isFinite(w.from) || !Number.isFinite(w.to));
}

/**
 * Whether a stored window is pinned to fixed moments (the person's, a lens's): not the default, not
 * "all" and not a following window. A pinned window stays where it is while the live edge moves on.
 */
export function isPinned(w: TimeWindow | null): boolean {
  return w !== null && Number.isFinite(w.from) && Number.isFinite(w.to);
}

/** The window to draw: the person's, the whole history for ALL_WINDOW, the last stretch for a following window, or the default when none is chosen. */
export function resolveWindow(chosen: TimeWindow | null, whole: TimeWindow, fallback: TimeWindow): TimeWindow {
  if (chosen === null) return fallback;
  if (isFollow(chosen)) {
    const length = followLength(chosen);
    if (whole.to - whole.from <= length) return whole;
    return { from: whole.to - length, to: whole.to };
  }
  return isAll(chosen) ? whole : chosen;
}

/**
 * How far the live edge is ahead of a pinned window, in ms, when the edge is outside it (more than a
 * second past its end); null when the window is not pinned or still holds the edge. When not null,
 * the Timeline says so ("Window pinned · live edge is 3 min ahead — Follow") and never claims to follow.
 */
export function pinnedBehind(chosen: TimeWindow | null, drawn: TimeWindow, liveEdge: number): number | null {
  if (!isPinned(chosen)) return null;
  const ahead = liveEdge - drawn.to;
  return ahead > 1000 ? ahead : null;
}

/**
 * A zoom (a new length, not a pan) of a window that holds the live edge while the store follows it:
 * the new length anchored on the live edge, still following (`followWindow`); null when the zoom
 * should stay where it was asked (not following, the window away from the edge, or a pan). Narrowing
 * while following once zoomed about the centre and pinned the window, leaving the live edge hours
 * ahead (round 6, defect 8). A length as wide as the whole history is "all" (ALL_WINDOW). Pure.
 */
export function followingZoom(drawn: TimeWindow, length: number, whole: TimeWindow, following: boolean): TimeWindow | null {
  if (!following || drawn.to < whole.to - 1000) return null;
  const was = drawn.to - drawn.from;
  if (Math.abs(length - was) <= Math.max(1, was * 0.001)) return null;
  if (length >= whole.to - whole.from) return ALL_WINDOW;
  return followWindow(Math.max(MIN_WINDOW_MS, length));
}

/**
 * The window that follows the live edge again after a pinned one ("Return to live", L, "Follow", "No
 * lens"): the length shown kept while a lens is on (its zoom level); otherwise the default (null).
 */
export function followingAgain(drawn: TimeWindow, lensOn: boolean): TimeWindow | null {
  return lensOn ? followWindow(drawn.to - drawn.from) : null;
}

/**
 * A window no narrower than MIN_WINDOW_MS, within `whole` when it fits; ALL_WINDOW when it shows all
 * of `whole` (then it follows the live edge again) or is not a window at all.
 */
export function clampWindow(next: TimeWindow, whole: TimeWindow): TimeWindow {
  let from = Math.min(next.from, next.to);
  let to = Math.max(next.from, next.to);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return ALL_WINDOW;
  if (to - from < MIN_WINDOW_MS) {
    const mid = (from + to) / 2;
    from = mid - MIN_WINDOW_MS / 2;
    to = mid + MIN_WINDOW_MS / 2;
  }
  const span = to - from;
  const wholeSpan = whole.to - whole.from;
  if (span >= wholeSpan) return ALL_WINDOW;
  if (from < whole.from) {
    from = whole.from;
    to = from + span;
  } else if (to > whole.to) {
    to = whole.to;
    from = to - span;
  }
  return { from, to };
}

/** The earliest and latest moments of some spans (an open span runs to `liveAt`); null when none has a time. */
export function extentOfSpans(spans: readonly TimelineSpan[], liveAt: number): TimeWindow | null {
  let from = Number.POSITIVE_INFINITY;
  let to = Number.NEGATIVE_INFINITY;
  for (const span of spans) {
    const x = extentOf(span);
    if (!x) continue;
    from = Math.min(from, x.from);
    to = Math.max(to, Number.isFinite(x.to) ? x.to : Math.max(x.from, liveAt));
  }
  return Number.isFinite(from) && Number.isFinite(to) ? { from, to } : null;
}

/** A window showing `ext` with `pad` of its length on each side, at least MIN_WINDOW_MS. */
export function frameExtent(ext: TimeWindow, pad = 0.1): TimeWindow {
  const len = Math.max(0, ext.to - ext.from);
  const want = Math.max(MIN_WINDOW_MS, len * (1 + 2 * pad));
  const mid = (ext.from + ext.to) / 2;
  return { from: mid - want / 2, to: mid + want / 2 };
}

/** `window` unchanged when it already shows part of `ext`; else the same width centred on `ext` (or framing it when wider). */
export function panToInclude(window: TimeWindow, ext: TimeWindow): TimeWindow {
  if (ext.from <= window.to && ext.to >= window.from) return window;
  const width = window.to - window.from;
  if (ext.to - ext.from > width) return frameExtent(ext);
  const mid = (ext.from + ext.to) / 2;
  return { from: mid - width / 2, to: mid + width / 2 };
}

/** The spans in the tree about `ref` (on the tracks tree.tracksOf names), most specific first. */
export function spansOfRef(tree: TrackTree, ref: string): TimelineSpan[] {
  const out: TimelineSpan[] = [];
  const seen = new Set<string>();
  const tracks = tree.tracksOf(ref);
  for (const id of tracks) {
    const node = tree.byId.get(id);
    if (!node) continue;
    for (const lane of node.lanes) {
      for (const span of lane.spans) {
        if (span.entity === ref && !seen.has(span.id)) {
          seen.add(span.id);
          out.push(span);
        }
      }
    }
  }
  if (out.length) return out;
  // The ref names a track (a group row) rather than a span: its subtree's spans.
  const first = tracks[0] ? tree.byId.get(tracks[0]) : undefined;
  if (first) collect(first, out, seen);
  return out;
}

function collect(node: TrackNode, out: TimelineSpan[], seen: Set<string>): void {
  for (const lane of node.lanes) {
    for (const span of lane.spans) {
      if (!seen.has(span.id)) {
        seen.add(span.id);
        out.push(span);
      }
    }
  }
  for (const child of node.children) collect(child, out, seen);
}

/** The ancestors of a track, root first. */
export function ancestorsOf(tree: TrackTree, trackId: string): string[] {
  const out: string[] = [];
  let at = tree.byId.get(trackId)?.parentId ?? null;
  while (at) {
    out.unshift(at);
    at = tree.byId.get(at)?.parentId ?? null;
  }
  return out;
}

/** The ref a span's entity names, by the store's grammar; null when it is not one. */
const REF = /^[a-z]+:.+/;

/** The span's own id is `<kind>:<entity>`: the entity of a span known only by id. */
export function entityOfSpanId(id: string): string {
  const i = id.indexOf(":");
  return i < 0 ? id : id.slice(i + 1);
}

/** The spans loaded, by entity ref (a span's `parent` is an ENTITY ref) and by span id. */
export function spanLookup(spans: readonly TimelineSpan[]): Map<string, TimelineSpan> {
  const out = new Map<string, TimelineSpan>();
  for (const s of spans) {
    if (!out.has(s.entity)) out.set(s.entity, s);
    out.set(s.id, s);
  }
  return out;
}

/** The station a visit or a build task belongs to, as the store names it (`station:<ticket>/<station>`). */
function stationRefOf(span: TimelineSpan): string | null {
  if (span.kind !== "visit" && span.kind !== "task" && span.kind !== "seat") return null;
  const ticket = span.ids.ticket_id;
  const station = span.ids.station ?? (span.kind === "seat" ? "review" : undefined);
  return ticket && station ? `station:${ticket}/${station}` : null;
}

/**
 * Which store ref a span stands for: its entity when the store knows it (`known`); else, climbing
 * through its parents (entity refs, looked up in `lookup` to keep climbing), the first one the store
 * knows, trying a visit's, task's or seat's station on the way; else its cell from `ids.ticket_id`.
 * Null when none is known. `lookup` is keyed by entity (and may also hold span ids, see `spanLookup`).
 */
export function refForSpan(span: TimelineSpan, lookup: ReadonlyMap<string, TimelineSpan>, known: (ref: string) => boolean): string | null {
  const ok = (ref: string | null): ref is string => ref !== null && REF.test(ref) && known(ref);
  let at: TimelineSpan | null = span;
  let entity: string | null = span.entity;
  const seen = new Set<string>();
  for (let depth = 0; depth < 8 && entity !== null && !seen.has(entity); depth++) {
    seen.add(entity);
    if (ok(entity)) return entity;
    const station = at ? stationRefOf(at) : null;
    if (ok(station)) return station;
    const parent: string | null = at ? at.parent : null;
    if (!parent) break;
    at = lookup.get(parent) ?? null;
    entity = at ? at.entity : parent;
  }
  const ticket = span.ids.ticket_id;
  const cell = ticket ? `cell:${ticket}` : null;
  return ok(cell) ? cell : null;
}

/** The span id the observer gives the main span of an entity, by its ref kind (for loading it when it is outside the window). */
export function spanIdForRef(ref: string): string | null {
  const kind = ref.slice(0, ref.indexOf(":"));
  const kinds: Record<string, SpanKind> = { wave: "wave", cell: "cell", execution: "execution", visit: "visit", seat: "seat", workflow: "workflow", agent: "agent", tool: "tool" };
  const spanKind = kinds[kind];
  return spanKind ? `${spanKind}:${ref}` : null;
}

// ---------------------------------------------------------------- jumps

export type JumpKind = "failure" | "retry" | "gate" | "human" | "gap";

export const JUMPS: ReadonlyArray<{ readonly id: JumpKind; readonly label: string; readonly plural: string; readonly kinds: readonly MarkKind[] }> = [
  { id: "failure", label: "failure", plural: "Failures", kinds: ["failure"] },
  { id: "retry", label: "retry", plural: "Retries", kinds: ["retry"] },
  { id: "gate", label: "gate decision", plural: "Gate decisions", kinds: ["gate", "review"] },
  { id: "human", label: "human intervention", plural: "Human interventions", kinds: ["human"] },
  { id: "gap", label: "gap in history", plural: "Gaps in history", kinds: ["gap"] },
];

export function jumpOf(id: JumpKind): (typeof JUMPS)[number] {
  return JUMPS.find((j) => j.id === id) ?? (JUMPS[0] as (typeof JUMPS)[number]);
}

// ---------------------------------------------------------------- filters

export interface FilterOptions {
  readonly tickets: readonly string[];
  readonly executions: readonly string[];
  readonly slices: readonly string[];
  readonly stations: readonly string[];
  readonly kinds: readonly SpanKind[];
}

const after = (ref: string | null, kind: string): string | null => (ref && ref.startsWith(`${kind}:`) ? ref.slice(kind.length + 1) : null);

/**
 * What the filter lists offer: what the tree shows, plus whatever is chosen now (so a choice that
 * hides everything can still be undone).
 */
export function filterOptions(tree: TrackTree, filters: TimelineFilters): FilterOptions {
  const tickets = new Set<string>(filters.tickets);
  const executions = new Set<string>(filters.executions);
  const slices = new Set<string>(filters.slices);
  const stations = new Set<string>(filters.stations);
  const kinds = new Set<SpanKind>(filters.kinds);
  for (const node of tree.byId.values()) {
    const ref = node.ref as string | null;
    if (node.kind === "cell") {
      const t = after(ref, "cell");
      if (t) tickets.add(t);
    } else if (node.kind === "execution") {
      const x = after(ref, "execution");
      if (x) executions.add(x);
    } else if (node.kind === "slice") {
      const s = after(ref, "slice");
      if (s) slices.add(s);
    } else if (node.kind === "station") {
      const id = after(ref ?? node.id, "station");
      const station = id ? id.slice(id.lastIndexOf("/") + 1) : null;
      if (station) stations.add(station);
    }
    for (const lane of node.lanes) for (const span of lane.spans) kinds.add(span.kind);
  }
  const sorted = (s: Set<string>) => [...s].sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  return { tickets: sorted(tickets), executions: sorted(executions), slices: sorted(slices), stations: [...stations], kinds: [...kinds].sort() as SpanKind[] };
}

/** How many filter choices are on (for the button's count). */
export function filterCount(f: TimelineFilters): number {
  return f.tickets.length + f.executions.length + f.slices.length + f.stations.length + f.kinds.length + (f.attentionOnly ? 1 : 0);
}

/** Toggle one value in a list. */
export function toggled<T>(list: readonly T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

/** Whether any span in the tree lies in the window. */
export function anyInWindow(tree: TrackTree, window: TimeWindow): boolean {
  for (const node of tree.byId.values()) for (const lane of node.lanes) for (const span of lane.spans) if (overlaps(span, window)) return true;
  return false;
}

// ---------------------------------------------------------------- the default window

/** What the default window is framed from. */
export interface ActivityInput {
  /** The whole history held (the store's extent, reaching back as far as the data knows). */
  readonly whole: TimeWindow;
  /** `data.extent()?.from`: where the recorded history starts, when the data source knows. */
  readonly dataFrom: number | null;
  /** Events recorded per bucket over `whole` (sparse), when served. */
  readonly density: DensitySeries | null;
  /** From the first to the last thing recorded, as the data layer measures it (`recordedExtent(data)`), when known. */
  readonly recorded?: TimeWindow | null;
  /** The spans loaded now. */
  readonly spans: readonly TimelineSpan[];
  /** The latest mark recorded, when known. */
  readonly lastMark: TimelineMark | null;
  /** True when the source is live and the playhead follows the live edge. */
  readonly followingLive: boolean;
}

/** Each side of the default window is padded by this share of its length. */
export const ACTIVITY_PAD = 0.02;

/** The span kinds whose being open means work is under way (a visit only when it is not a wait on a person). */
const RUNNING_KINDS: ReadonlySet<SpanKind> = new Set<SpanKind>(["execution", "workflow", "agent", "visit"]);

/**
 * Whether an open span means something is running: an open execution, workflow or agent, or an open
 * station visit other than human approval (that one is a wait on a person). Open waits, cells,
 * rounds, waves, claims and eligibility do not count: a cell parked for a person is not running.
 */
export function isRunning(span: TimelineSpan): boolean {
  // A history that is no longer live with no end recorded for it (attrs.historyEndsAt): not running.
  if (span.end !== null || !RUNNING_KINDS.has(span.kind) || span.attrs.historyEndsAt !== undefined) return false;
  if (span.kind !== "visit") return true;
  const station = span.ids.station ?? span.entity.slice(span.entity.lastIndexOf("/") + 1).replace(/#.*$/, "");
  return station !== "human-approval";
}

/**
 * The default window, when the person has not chosen one (finding 1 of the real run: 73 minutes of
 * activity were squeezed into the left tenth of the tracks because the window ran to the wall clock).
 *
 * The rule:
 * - It starts where the recorded history starts (`data.extent()`), else at the first non-empty density
 *   bucket or the first span, whichever is earlier.
 * - It ends at the last thing recorded: the latest of the data layer's recorded extent
 *   (`recordedExtent(data)`: density, else marks and span bounds), the last non-empty density
 *   bucket's end, the last recorded span end, and the last mark (its `until` when it is an interval).
 * - While something is running (`isRunning`: an open execution, workflow, agent, or station visit
 *   other than human approval) and the source is live and following, it ends at the live edge
 *   instead, unless the silence since the last record is long (`silentTail`): the open tail would
 *   squeeze what was recorded into the left of the stage. An open wait, cell, round or wave alone is not running: a cell parked for a person
 *   hours after its last event is framed on its recorded activity, live or not.
 * - 2% of its length is added on each side, never beyond the whole history; never narrower than
 *   MIN_WINDOW_MS. With nothing recorded at all it is the whole history.
 * "Show all" (ALL_WINDOW) still shows the whole history held, and the overview always does.
 */
/**
 * Whether the time since the last record is so long that open work is not worth following: more than
 * three times the recorded activity and over half an hour. A run that pauses briefly keeps following;
 * a history whose open work fell silent hours ago is framed on what was recorded (round 6, defect 17).
 */
export function silentTail(first: number, last: number, edge: number): boolean {
  const tail = edge - last;
  return tail > SILENT_TAIL_MIN_MS && tail > 3 * Math.max(0, last - first);
}
const SILENT_TAIL_MIN_MS = 30 * 60_000;

export function activityWindow(input: ActivityInput): TimeWindow {
  const { whole } = input;
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  let running = false;
  const d = input.density;
  if (d) {
    for (const b of d.buckets) {
      if (b.count <= 0) continue;
      first = Math.min(first, b.from);
      last = Math.max(last, b.from + d.bucketMs);
    }
  }
  for (const span of input.spans) {
    const x = extentOf(span);
    if (!x) continue;
    first = Math.min(first, x.from);
    if (isRunning(span)) running = true;
    if (Number.isFinite(x.to)) last = Math.max(last, x.to);
    else last = Math.max(last, x.from);
  }
  if (input.recorded) {
    first = Math.min(first, input.recorded.from);
    last = Math.max(last, input.recorded.to);
  }
  const m = input.lastMark;
  if (m) {
    first = Math.min(first, m.at);
    last = Math.max(last, m.until ?? m.at);
  }
  if (input.dataFrom !== null && Number.isFinite(input.dataFrom)) first = input.dataFrom;
  // Running, live and following: to the live edge, unless the work has been silent so long that its
  // open tail would take most of the stage. Then nothing is moving to follow, and the recorded activity
  // is framed (round 6, defect 17: 6 h of history squeezed into the left 13% by a 39 h open tail).
  if (running && input.followingLive && Number.isFinite(first) && Number.isFinite(last) && !silentTail(first, last, whole.to)) last = whole.to;
  if (!Number.isFinite(first) || !Number.isFinite(last)) return whole;
  let from = Math.max(whole.from, first);
  let to = Math.min(whole.to, Math.max(last, from));
  const pad = (to - from) * ACTIVITY_PAD;
  from = Math.max(whole.from, from - pad);
  to = Math.min(whole.to, to + pad);
  if (to - from < MIN_WINDOW_MS) {
    const mid = (from + to) / 2;
    from = Math.max(whole.from, mid - MIN_WINDOW_MS / 2);
    to = Math.min(whole.to, from + MIN_WINDOW_MS);
  }
  if (from <= whole.from && to >= whole.to) return whole;
  return { from, to };
}

/** A window's length in words, for the zoom controls: "45 s", "12 min", "1 h 13 min", "2 d 4 h". */
export function windowLengthWords(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0 s";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const min = Math.round(ms / 60_000);
  if (min < 60) {
    const sec = s - Math.floor(s / 60) * 60;
    return min < 10 && sec > 0 ? `${Math.floor(s / 60)} min ${sec} s` : `${min} min`;
  }
  const h = Math.floor(min / 60);
  if (h < 24) {
    const rest = min - h * 60;
    return rest ? `${h} h ${rest} min` : `${h} h`;
  }
  const days = Math.floor(h / 24);
  const hours = h - days * 24;
  return hours ? `${days} d ${hours} h` : `${days} d`;
}

// ---------------------------------------------------------------- filter options from the spans

/**
 * What the filter lists offer, built from the spans in the window rather than the (filtered) tree, so
 * every value present stays on offer while a filter is on; plus whatever is chosen now.
 */
export function filterOptionsOfSpans(spans: readonly TimelineSpan[], filters: TimelineFilters): FilterOptions {
  const tickets = new Set<string>(filters.tickets);
  const executions = new Set<string>(filters.executions);
  const slices = new Set<string>(filters.slices);
  const stations = new Set<string>(filters.stations);
  const kinds = new Set<SpanKind>(filters.kinds);
  for (const span of spans) {
    kinds.add(span.kind);
    const t = span.ids.ticket_id;
    if (t) tickets.add(t);
    const x = span.ids.execution_id;
    if (x) executions.add(x);
    const sl = span.ids.slice_id;
    if (sl) slices.add(sl);
    const st = span.ids.station ?? (span.kind === "seat" ? "review" : undefined);
    if (st) stations.add(st);
  }
  const sorted = (s: Set<string>) => [...s].sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  return { tickets: sorted(tickets), executions: sorted(executions), slices: sorted(slices), stations: sorted(stations), kinds: [...kinds].sort() as SpanKind[] };
}

/** One chip per active filter choice, with what removing it leaves. */
export interface FilterChip {
  readonly key: string;
  readonly label: string;
  readonly without: Partial<TimelineFilters>;
}

export function filterChips(f: TimelineFilters, kindWords: (k: SpanKind) => string = (k) => k): FilterChip[] {
  const out: FilterChip[] = [];
  if (f.attentionOnly) out.push({ key: "attention", label: "Needs attention", without: { attentionOnly: false } });
  for (const v of f.tickets) out.push({ key: `t:${v}`, label: v, without: { tickets: f.tickets.filter((x) => x !== v) } });
  for (const v of f.slices) out.push({ key: `s:${v}`, label: v, without: { slices: f.slices.filter((x) => x !== v) } });
  for (const v of f.executions) out.push({ key: `x:${v}`, label: v, without: { executions: f.executions.filter((x) => x !== v) } });
  for (const v of f.stations) out.push({ key: `st:${v}`, label: v, without: { stations: f.stations.filter((x) => x !== v) } });
  for (const v of f.kinds) out.push({ key: `k:${v}`, label: kindWords(v), without: { kinds: f.kinds.filter((x) => x !== v) } });
  return out;
}

// ---------------------------------------------------------------- an interval on the floor

/**
 * The cells active in a time interval: every cell (`cell:<ticket>`) with a span overlapping it, in
 * first-seen order. What the floor highlights when the person chose a window and selected nothing.
 */
export function cellsInInterval(spans: readonly TimelineSpan[], window: TimeWindow): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const span of spans) {
    const ticket = span.ids.ticket_id ?? (span.entity.startsWith("cell:") ? span.entity.slice(5) : undefined);
    if (!ticket) continue;
    const ref = `cell:${ticket}`;
    if (seen.has(ref) || !overlaps(span, window)) continue;
    seen.add(ref);
    out.push(ref);
  }
  return out;
}

// ---------------------------------------------------------------- lenses

/**
 * Choosing a lens: its preset (grouping, filters, expansion, window) and the lens itself. The preset
 * sees the window as drawn (never the stored ALL_WINDOW sentinel). The person may change any of it after.
 */
export function applyLens(lens: Pick<LensDefinition, "id" | "preset">, tree: TrackTree, view: TimelineViewState, drawn: TimeWindow, following = false): Partial<TimelineViewState> {
  const preset = lens.preset(tree, { ...view, window: view.window === null ? null : drawn });
  // L1: chosen while following the live edge, the lens's framing sets the zoom level only: the window
  // keeps following, at the length of the lens's frame. Chosen while not following, it pins as framed.
  if (following && preset.window && isPinned(preset.window)) return { ...preset, window: followWindow(preset.window.to - preset.window.from), lens: lens.id };
  return { ...preset, lens: lens.id };
}

/** Whether the stored window follows the live edge (the default, "all", or a following window): a lens chosen then keeps following. */
export function windowFollows(w: TimeWindow | null): boolean {
  return !isPinned(w);
}

/** What a lens changed, and what was there before it: so the next lens (or none) starts from the person's own view. */
export interface LensMemo {
  readonly base: Pick<TimelineViewState, "filters" | "grouping"> & { readonly window?: TimeWindow | null };
  readonly applied: Pick<TimelineViewState, "filters" | "grouping"> & { readonly window?: TimeWindow | null };
}

const sameWindow = (a: TimeWindow | null | undefined, b: TimeWindow | null | undefined): boolean => a === b || (!!a && !!b && a.from === b.from && a.to === b.to);

const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((v, i) => v === b[i]);
export function sameFilters(a: TimelineFilters, b: TimelineFilters): boolean {
  return a.attentionOnly === b.attentionOnly && sameList(a.tickets, b.tickets) && sameList(a.executions, b.executions) && sameList(a.slices, b.slices) && sameList(a.stations, b.stations) && sameList(a.kinds, b.kinds);
}

/**
 * Leaving a lens: the filters and grouping it set go back to what they were before it, unless the
 * person has changed them since (then theirs stay). Expansion stays (a preset only adds to it).
 */
export function leaveLens(view: TimelineViewState, memo: LensMemo | null | undefined): Partial<TimelineViewState> {
  if (!memo || view.lens === null) return {};
  const out: { filters?: TimelineFilters; grouping?: TimelineViewState["grouping"]; window?: TimeWindow | null } = {};
  if (sameFilters(view.filters, memo.applied.filters)) out.filters = memo.base.filters;
  if (view.grouping === memo.applied.grouping) out.grouping = memo.base.grouping;
  // The window the lens framed goes back to the one before it (the following default, L1), unless the
  // person has moved it since.
  if (memo.applied.window !== undefined && sameWindow(view.window, memo.applied.window)) out.window = memo.base.window ?? null;
  return out;
}

/**
 * Choosing a lens (or none) from the current view: the previous lens is left first (`leaveLens`), then
 * the new one's preset applies. Returns the patch and the memo to keep for the next change.
 */
export function switchLens(
  lens: Pick<LensDefinition, "id" | "preset"> | null,
  tree: TrackTree,
  view: TimelineViewState,
  drawn: TimeWindow,
  memo: LensMemo | null | undefined,
  following = false,
): { patch: Partial<TimelineViewState>; memo: LensMemo | null } {
  const left = leaveLens(view, memo);
  const start: TimelineViewState = { ...view, ...left };
  if (!lens) return { patch: { ...left, lens: null }, memo: null };
  const preset = applyLens(lens, tree, start, drawn, following && windowFollows(start.window));
  const applied = { filters: preset.filters ?? start.filters, grouping: preset.grouping ?? start.grouping, ...(preset.window !== undefined ? { window: preset.window } : {}) };
  return { patch: { ...left, ...preset }, memo: { base: { filters: start.filters, grouping: start.grouping, window: start.window }, applied } };
}

// ---------------------------------------------------------------- as of the playhead (T6, M6.6 I-04)

/**
 * What "as of" the tracks, the table and the lenses speak. M6.3 (T6) drew what is held up to the live
 * edge whatever the playhead; M6.6 (I-04) holds them at the playhead, like the inspector: scrubbed back,
 * nothing after the playhead is drawn or named unless the person asks for it ("Show what happened after
 * this moment", `revealAfter`), and then it is tinted.
 */
export interface AsOf {
  /** True when the playhead is behind the live edge. */
  readonly behind: boolean;
  readonly playhead: number;
  readonly liveAt: number;
  /** Behind, and what happened after the playhead is shown (on request): the tracks show more than the inspector does. */
  readonly revealed: boolean;
}

/** Below this the playhead is "at" the live edge (a frame's worth of rounding). */
const AS_OF_SLACK_MS = 1000;

/**
 * Whether the playhead is behind the live edge (not following, and behind it by more than the slack:
 * scrubbed back, a jump, a seek, a replay paused before its end), and whether what happened after it
 * is revealed.
 */
export function asOfPlayhead(s: { readonly following: boolean; readonly playhead: number; readonly liveAt: number; readonly timeline?: { readonly revealAfter?: boolean } }): AsOf {
  const behind = !s.following && s.playhead < s.liveAt - AS_OF_SLACK_MS;
  return { behind, playhead: s.playhead, liveAt: s.liveAt, revealed: behind && s.timeline?.revealAfter === true };
}

/**
 * The moment the tracks are cut at, or null when they show what is held up to the live edge (following,
 * at the edge, or revealed). Paused, the playhead itself; while playing, rounded DOWN to the live edge's step (`quantizedLiveAt`'s), so the tracks are
 * rebuilt a few times a second at most while a replay plays and never show a moment past the playhead.
 */
export function heldAtOf(s: { readonly following: boolean; readonly playhead: number; readonly liveAt: number; readonly playing?: boolean; readonly extent: { readonly start: number; readonly end: number }; readonly timeline?: { readonly revealAfter?: boolean } }): number | null {
  const a = asOfPlayhead(s);
  if (!a.behind || a.revealed) return null;
  // Paused (a jump, a seek, a link): the playhead itself, so a mark jumped to is drawn at it.
  if (!s.playing) return s.playhead;
  const step = Math.max(250, Math.round((Math.max(s.extent.end, s.liveAt) - s.extent.start) / 1000));
  return Math.floor(s.playhead / step) * step;
}

/** The time in the caption: the source's clock (simulated time for the simulation, UTC for real history). */
export function asOfClock(t: number): string {
  return getTimeBase() === "wall" ? `${clockAt(t)} UTC` : clockAt(t);
}

/** The toolbar's quiet line while the playhead is behind: null at the live edge. */
export function asOfCaption(a: AsOf): string | null {
  if (!a.behind) return null;
  return a.revealed
    ? `Showing what happened after the playhead at ${asOfClock(a.playhead)}, tinted, up to the live edge`
    : `Tracks show what had happened by the playhead at ${asOfClock(a.playhead)}; nothing later is drawn`;
}

/** The table's and each lens's caption while the playhead is behind: null at the live edge. */
export function asOfShort(a: AsOf): string | null {
  if (!a.behind) return null;
  return a.revealed ? `Including what happened after the playhead at ${asOfClock(a.playhead)}` : `As of the playhead at ${asOfClock(a.playhead)}`;
}

// ---------------------------------------------------------------- selecting and seeking (X3, X13)

/** What clicking a span (or Enter on it) selects: the span's own entity when the store resolves it, else the nearest ref with the span kept as the detail. */
export interface SpanSelection {
  readonly ref: string | null;
  /** The span's entity when it is not the ref itself (the inspector's subject within the ref). */
  readonly detail: string | null;
}

export function selectionForSpan(span: TimelineSpan, lookup: ReadonlyMap<string, TimelineSpan>, known: (ref: string) => boolean): SpanSelection {
  if (REF.test(span.entity) && known(span.entity)) return { ref: span.entity, detail: null };
  const ref = refForSpan(span, lookup, known);
  return { ref, detail: ref && ref !== span.entity ? span.entity : null };
}

/** The last span or mark selected from the tracks or the table (its hit key), and the store selection that made. */
export interface Activated {
  readonly key: string;
  readonly selection: string | null;
}

/**
 * X13: what selecting a span or mark does. Selecting never moves the playhead; a second select of the
 * same span or mark while it is still the selection is "go to" (the playhead seeks there) only when it
 * is Enter again or a real double-click's second click. A later single click only keeps the selection
 * (recheck R4: clicking the same span again seconds later must not seek and leave the live edge).
 */
export function activation(last: Activated | null, key: string, selection: string | null, how: "click" | "double-click" | "key" = "key"): "select" | "seek" {
  if (how === "click") return "select";
  return last !== null && key !== "" && last.key === key && last.selection === selection ? "seek" : "select";
}

/**
 * The live edge in steps (about 1/1000 of what is held, at least 250 ms): the workspace re-renders a
 * few times a second at most. Rounded DOWN (T11): an open span is never drawn past what is held.
 */
export function quantizedLiveAt(s: { readonly extent: { readonly start: number; readonly end: number }; readonly liveAt: number }): number {
  const step = Math.max(250, Math.round((Math.max(s.extent.end, s.liveAt) - s.extent.start) / 1000));
  return Math.floor(s.liveAt / step) * step;
}

/** Where "go to" a span or mark seeks: its recorded event when the history holds it, else its time. */
export function seekTargetOf(hit: { readonly span?: TimelineSpan | null; readonly mark?: TimelineMark | null }): { eventId: string | null; at: number } | null {
  if (hit.mark) return { eventId: hit.mark.eventId, at: hit.mark.at };
  const s = hit.span;
  if (!s?.start || s.start.at === null) return null;
  return { eventId: s.start.eventId, at: s.start.at };
}

// ---------------------------------------------------------------- the simulation's default window (X9)

/** While following, the default window ends this share of its length past the live edge. */
export const LIVE_LEAD = 0.05;

/**
 * The simulation's default window: from its start to just past what is revealed (5% lead), never a
 * large hatched future; the whole run once it is all revealed.
 */
export function leadWindow(whole: TimeWindow, liveAt: number): TimeWindow {
  const shown = Math.max(MIN_WINDOW_MS, liveAt - whole.from);
  const to = Math.min(whole.to, whole.from + shown * (1 + LIVE_LEAD));
  return to >= whole.to ? whole : { from: whole.from, to };
}

// ---------------------------------------------------------------- the default expansion (X9)

/** Track kinds opened by default, level by level, while the rows still fit: down to cells' station rows (product) or executions' parts (execution). */
const OPENED_BY_DEFAULT: ReadonlySet<TrackNode["kind"]> = new Set<TrackNode["kind"]>(["wave", "slice", "cell", "executions", "execution"]);

/**
 * The expansion the tracks start with: `base` (the tracks' own defaults) plus, one tree level at a
 * time, the waves, slices and cells (or executions) beneath, as long as every row then fits in
 * `height`. `heightOf` measures the rows of an expansion (the layout's totalHeight).
 */
export function fittingExpansion(tree: TrackTree, base: readonly string[], height: number, heightOf: (expanded: ReadonlySet<string>) => number): string[] {
  const open = new Set(base);
  if (height <= 0) return [...open];
  let level: TrackNode[] = [...tree.roots];
  while (level.length) {
    const add = level.filter((n) => OPENED_BY_DEFAULT.has(n.kind) && n.children.length > 0 && !open.has(n.id));
    if (add.length) {
      const next = new Set(open);
      for (const n of add) next.add(n.id);
      if (heightOf(next) > height) break;
      for (const n of add) open.add(n.id);
    }
    level = level.filter((n) => open.has(n.id)).flatMap((n) => n.children);
  }
  return [...open];
}

// ---------------------------------------------------------------- the tree's spans (X4)

/**
 * The spans the tree is built from: the structural spans of the whole history plus the window's
 * detailed spans (a window's copy of a span wins: it is as new or newer). Hierarchy and identity
 * therefore do not depend on which window was loaded first.
 */
export function unionSpans(structural: readonly TimelineSpan[], windowed: readonly TimelineSpan[]): readonly TimelineSpan[] {
  if (!structural.length) return windowed;
  if (!windowed.length) return structural;
  const ids = new Set(windowed.map((s) => s.id));
  const out = windowed.slice();
  for (const s of structural) if (!ids.has(s.id)) out.push(s);
  return out;
}

// ---------------------------------------------------------------- the end of a jump (X18)

/** Said when a jump finds nothing further: how many lie the other way, and the key that reaches them. */
export function jumpEndWords(label: string, direction: 1 | -1, otherWay: number): string {
  const none = `No ${direction > 0 ? "later" : "earlier"} ${label} in what is held`;
  if (otherWay <= 0) return `${none}.`;
  return `${none}; ${otherWay} ${direction > 0 ? "earlier" : "later"}: press ${direction > 0 ? "P" : "N"}.`;
}

/**
 * When nothing has been running since (L1 iv): null while something runs (`isRunning`); else when the
 * last work that runs ended (an execution, workflow, agent, or a station visit other than human
 * approval); with no such work recorded, the recorded activity's end. Null when none is known.
 */
export function idleSinceOf(spans: readonly TimelineSpan[], recorded: TimeWindow | null): number | null {
  let last = Number.NEGATIVE_INFINITY;
  for (const s of spans) {
    if (isRunning(s)) return null;
    if (!RUNNING_KINDS.has(s.kind) || (s.kind === "visit" && s.ids.station === "human-approval")) continue;
    const end = s.end?.at ?? null;
    if (end !== null && end > last) last = end;
  }
  if (!Number.isFinite(last) && recorded) last = recorded.to;
  return Number.isFinite(last) ? last : null;
}

// ---------------------------------------------------------------- fitting the chrome, framing rows

/**
 * What the toolbar's fit depends on (X8): when any of it changes, the row is measured again from no
 * squeeze. Everything that changes the row's content width belongs here, not only its own width: the
 * pinned control arriving or its words changing ("live edge is 3 min ahead"), the window's length in
 * words, the chips, the lens and the jump kind. A missing input is a row measured once and left
 * clipped (the pinned control and Follow pushed out of reach).
 */
export function toolbarFitKey(p: {
  readonly rowWidth: number;
  readonly lens: string | null;
  readonly filters: number;
  readonly jump: string;
  /** Whether the as-of caption is shown, and with which reveal control (I-04): its words change the row's width. */
  readonly caption: boolean | "held" | "revealed";
  readonly table: boolean;
  readonly pinnedAhead: number | null;
  readonly length: string;
}): string {
  const pinned = p.pinnedAhead === null ? "" : windowLengthWords(p.pinnedAhead);
  return [p.rowWidth, p.lens ?? "", p.filters, p.jump, p.caption === true ? 1 : p.caption === false ? 0 : p.caption, p.table ? 1 : 0, pinned, p.length].join("|");
}

/**
 * Below this width of the Timeline's own column (not the window: an inspector column beside it takes
 * its share), the shared transport drops its secondary words (since when nothing runs, how far back),
 * so its speed control is never clipped. M6.6: 1160, so a 1100 px window reviewing an earlier moment
 * ("Reviewing … back", new events, Return to live, Follow at live) no longer clips the speeds.
 */
export const TRANSPORT_FULL_WIDTH = 1160;

export function transportCompact(columnWidth: number): boolean {
  return columnWidth > 0 && columnWidth < TRANSPORT_FULL_WIDTH;
}

/**
 * Which of the refs a lens's Frame concerns the tracks should bring into view: the first that has a
 * track in the tree (so the stage is never left scrolled to rows outside the framed interval), else the
 * first given (the workspace then finds its span); null when none is given.
 */
export function frameRevealRef(refs: readonly string[], hasTrack: (ref: string) => boolean): string | null {
  for (const r of refs) if (hasTrack(r)) return r;
  return refs[0] ?? null;
}

/**
 * The Timeline workspace's chrome above its stage: the shared transport (40 px) and the toolbar row
 * (40 px and its 1 px rule). Below 1280 px the inspector is a drawer; over the Timeline it starts
 * under this chrome, so the transport, the toolbar and its Follow stay in reach while it is open (as
 * on the floor, where the drawer stops at the timeline).
 */
export const TIMELINE_CHROME_HEIGHT = 81;
