/**
 * Pure helpers the Timeline's controls and its workspace share: framing a window on a selection,
 * panning to a moment, what the filters can offer, the jump list, and which store ref a span stands
 * for. No React, no store: test/timeline-shell.test.mjs runs them in node.
 */
import { extentOf, MIN_WINDOW_MS, overlaps, type MarkKind, type SpanKind, type TimeWindow, type TimelineFilters, type TimelineSpan, type TrackNode, type TrackTree } from "../contract";

/** A window no narrower than MIN_WINDOW_MS, within `whole` when it fits; null when it shows all of `whole` (then it follows the live edge again). */
export function clampWindow(next: TimeWindow, whole: TimeWindow): TimeWindow | null {
  let from = Math.min(next.from, next.to);
  let to = Math.max(next.from, next.to);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  if (to - from < MIN_WINDOW_MS) {
    const mid = (from + to) / 2;
    from = mid - MIN_WINDOW_MS / 2;
    to = mid + MIN_WINDOW_MS / 2;
  }
  const span = to - from;
  const wholeSpan = whole.to - whole.from;
  if (span >= wholeSpan) return null;
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

/**
 * Which store ref a span stands for: its entity when the store knows it (`known`), else the nearest
 * parent span's entity that it knows. Null when none is known.
 */
export function refForSpan(span: TimelineSpan, byId: ReadonlyMap<string, TimelineSpan>, known: (ref: string) => boolean): string | null {
  let entity: string | null = span.entity;
  let parent: string | null = span.parent;
  for (let depth = 0; depth < 8 && entity !== null; depth++) {
    if (REF.test(entity) && known(entity)) return entity;
    if (!parent) return null;
    const p = byId.get(parent);
    entity = p ? p.entity : entityOfSpanId(parent);
    parent = p ? p.parent : null;
  }
  return null;
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
