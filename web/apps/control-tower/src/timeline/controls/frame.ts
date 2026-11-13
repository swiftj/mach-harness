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

// ---------------------------------------------------------------- windows: chosen, all, and the default

/**
 * The window the person asked to be "all of the history held": stored as unbounded, drawn as the
 * whole history at that moment, so it keeps following the live edge. `null` in the store is the other
 * case: nothing chosen, so the Timeline frames the recorded activity (see `activityWindow`).
 */
export const ALL_WINDOW: TimeWindow = Object.freeze({ from: Number.NEGATIVE_INFINITY, to: Number.POSITIVE_INFINITY });

/** Whether a stored window means "all of the history held". */
export function isAll(w: TimeWindow | null): boolean {
  return w !== null && (!Number.isFinite(w.from) || !Number.isFinite(w.to));
}

/** The window to draw: the person's, the whole history for ALL_WINDOW, or the default when none is chosen. */
export function resolveWindow(chosen: TimeWindow | null, whole: TimeWindow, fallback: TimeWindow): TimeWindow {
  if (chosen === null) return fallback;
  return isAll(chosen) ? whole : chosen;
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
  if (span.end !== null || !RUNNING_KINDS.has(span.kind)) return false;
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
 *   instead. An open wait, cell, round or wave alone is not running: a cell parked for a person
 *   hours after its last event is framed on its recorded activity, live or not.
 * - 2% of its length is added on each side, never beyond the whole history; never narrower than
 *   MIN_WINDOW_MS. With nothing recorded at all it is the whole history.
 * "Show all" (ALL_WINDOW) still shows the whole history held, and the overview always does.
 */
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
  if (running && input.followingLive) last = whole.to;
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
export function applyLens(lens: Pick<LensDefinition, "id" | "preset">, tree: TrackTree, view: TimelineViewState, drawn: TimeWindow): Partial<TimelineViewState> {
  const preset = lens.preset(tree, { ...view, window: view.window === null ? null : drawn });
  return { ...preset, lens: lens.id };
}

/** What a lens changed, and what was there before it: so the next lens (or none) starts from the person's own view. */
export interface LensMemo {
  readonly base: Pick<TimelineViewState, "filters" | "grouping">;
  readonly applied: Pick<TimelineViewState, "filters" | "grouping">;
}

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
  const out: { filters?: TimelineFilters; grouping?: TimelineViewState["grouping"] } = {};
  if (sameFilters(view.filters, memo.applied.filters)) out.filters = memo.base.filters;
  if (view.grouping === memo.applied.grouping) out.grouping = memo.base.grouping;
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
): { patch: Partial<TimelineViewState>; memo: LensMemo | null } {
  const left = leaveLens(view, memo);
  const start: TimelineViewState = { ...view, ...left };
  if (!lens) return { patch: { ...left, lens: null }, memo: null };
  const preset = applyLens(lens, tree, start, drawn);
  const applied = { filters: preset.filters ?? start.filters, grouping: preset.grouping ?? start.grouping };
  return { patch: { ...left, ...preset }, memo: { base: { filters: start.filters, grouping: start.grouping }, applied } };
}
