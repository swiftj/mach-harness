/**
 * Pure helpers both providers share: windows and tiles, query filters, concurrency by sweeping spans,
 * density by bucketing event times, cutting a span set at what is held, and the honesty rules every
 * answer passes through (no outcome without an end, no tool span under a count-only agent).
 */
import { extentOf, overlaps } from "../contract";
import type { ConcurrencySeries, DensitySeries, SpanEnd, SpanKind, SpanQuery, TimeWindow, TimelineSpan } from "../contract";

/**
 * A density series with whether the caller's ticket or execution filter was applied. The contract's
 * `density` takes one ticket or execution: a caller with several asks for the unfiltered series, and
 * `filtered: false` lets the legend say it shows every event, not the filter's.
 */
export type FilteredDensity = DensitySeries & { readonly filtered: boolean };

/** A limit with what it limits: `applies_to` from the observer (span kinds), null when it limits none of the counted bands. */
export type ConcurrencyLimit = ConcurrencySeries["limits"][number] & { readonly appliesTo?: readonly string[] | null };

/** Tile sizes, ascending. A window is cut into tiles of the smallest size that holds half of it, so panning reuses tiles. */
export const TILE_STEPS: readonly number[] = [
  10_000, 30_000, 60_000, 300_000, 900_000, 3_600_000, 10_800_000, 21_600_000, 43_200_000, 86_400_000, 259_200_000, 604_800_000, 2_592_000_000, 31_536_000_000,
];

export function tileSizeFor(window: TimeWindow): number {
  const half = Math.max(1, (window.to - window.from) / 2);
  for (const step of TILE_STEPS) if (step >= half) return step;
  return TILE_STEPS[TILE_STEPS.length - 1] as number;
}

/** The tiles covering a window, quantised outward to tile boundaries. */
export function tilesFor(window: TimeWindow): readonly TimeWindow[] {
  const size = tileSizeFor(window);
  const first = Math.floor(window.from / size) * size;
  const last = Math.max(first + size, Math.ceil(window.to / size) * size);
  const out: TimeWindow[] = [];
  for (let from = first; from < last; from += size) out.push({ from, to: from + size });
  return out;
}

export function spanMatches(span: TimelineSpan, query: SpanQuery): boolean {
  if (query.kinds?.length && !query.kinds.includes(span.kind)) return false;
  if (query.ticket && span.ids.ticket_id !== query.ticket) return false;
  if (query.execution && span.ids.execution_id !== query.execution) return false;
  if (query.wave && span.ids.wave_id !== query.wave) return false;
  return overlaps(span, query.window);
}

const startOf = (span: TimelineSpan): number => extentOf(span)?.from ?? Number.POSITIVE_INFINITY;

export function byStart(a: TimelineSpan, b: TimelineSpan): number {
  return startOf(a) - startOf(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * The honesty rules, applied to every answer: an outcome only with a recorded end; and no `tool`
 * span whose agent is count-only (its calls are not observable one by one, so a tick would be
 * invented). Tool spans are dropped when their parent agent in the same set says count-only.
 */
export function honest(spans: readonly TimelineSpan[]): TimelineSpan[] {
  const countOnly = new Set<string>();
  for (const s of spans) if (s.kind === "agent" && s.attrs.toolsCountOnly === true) countOnly.add(s.entity);
  const out: TimelineSpan[] = [];
  for (const s of spans) {
    if (s.kind === "tool" && s.parent !== null && countOnly.has(s.parent)) continue;
    out.push(s.end === null && s.outcome !== null ? { ...s, outcome: null } : s);
  }
  return out;
}

/**
 * The span as it stood at `liveAt` (the simulation, whose future is recorded): null when it had not
 * begun; open, without an outcome, when its end lies after `liveAt`.
 */
export function cutAt(span: TimelineSpan, liveAt: number): TimelineSpan | null {
  const x = extentOf(span);
  if (x === null || x.from > liveAt) return null;
  const end = span.end;
  if (end === null) return span;
  const endAt = end.at ?? end.notAfter ?? end.notBefore;
  if (endAt === null || endAt <= liveAt) return span;
  if (span.start === null) return null; // only its end was known, and that has not happened yet
  return { ...span, end: null, outcome: null, duration: { ms: null, minMs: null, maxMs: null, basis: "open" } };
}

/** Bucket boundaries for `buckets` buckets over a window (at least 1 ms each). */
export function bucketSize(window: TimeWindow, buckets: number): number {
  return Math.max(1, Math.ceil((window.to - window.from) / Math.max(1, Math.floor(buckets))));
}

/** Events per bucket from ascending event times (sparse). */
export function densityOf(times: readonly number[], window: TimeWindow, buckets: number, complete: boolean): DensitySeries {
  const size = bucketSize(window, buckets);
  const counts = new Map<number, number>();
  for (const t of times) {
    if (t < window.from || t >= window.to) continue;
    const k = window.from + Math.floor((t - window.from) / size) * size;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return { from: window.from, to: window.to, bucketMs: size, buckets: [...counts].sort((a, b) => a[0] - b[0]).map(([from, count]) => ({ from, count })), complete };
}

/**
 * Concurrency by sweeping spans: per bucket and kind, the most active at once and the time-weighted
 * mean. An open span is active up to `liveAt`; a span with no known start is not counted (its length
 * is not known, so it is never stretched to fill the bucket).
 */
export function concurrencyOf(spans: readonly TimelineSpan[], window: TimeWindow, buckets: number, liveAt: number, limits: ConcurrencySeries["limits"], complete: boolean): ConcurrencySeries {
  const size = bucketSize(window, buckets);
  const n = Math.max(1, Math.ceil((window.to - window.from) / size));
  const byKind = new Map<SpanKind, { t: number; d: number }[]>();
  for (const s of spans) {
    const from = s.start?.at ?? s.start?.notBefore ?? null;
    if (from === null) continue;
    const to = s.end ? (s.end.at ?? s.end.notAfter ?? null) : Math.min(liveAt, window.to);
    if (to === null || to < from || to < window.from || from > window.to) continue;
    const list = byKind.get(s.kind) ?? [];
    list.push({ t: from, d: 1 }, { t: Math.max(to, from), d: -1 });
    byKind.set(s.kind, list);
  }
  const out = Array.from({ length: n }, (_, i) => ({ from: window.from + i * size, active: {} as Partial<Record<SpanKind, { max: number; mean: number }>> }));
  for (const [kind, edges] of byKind) {
    // Starts before ends at the same instant, so back-to-back spans count as touching, not overlapping twice.
    edges.sort((a, b) => a.t - b.t || a.d - b.d);
    let active = 0;
    let i = 0;
    for (; i < edges.length && (edges[i] as { t: number }).t <= window.from; i++) active += (edges[i] as { d: number }).d;
    for (let b = 0; b < n; b++) {
      const bucket = out[b] as (typeof out)[number];
      const bFrom = bucket.from;
      const bTo = Math.min(window.to, bFrom + size);
      let max = active;
      let weighted = 0;
      let at = bFrom;
      while (i < edges.length && (edges[i] as { t: number }).t < bTo) {
        const e = edges[i] as { t: number; d: number };
        weighted += active * (e.t - at);
        at = e.t;
        active += e.d;
        max = Math.max(max, active);
        i++;
      }
      weighted += active * (bTo - at);
      if (max > 0) bucket.active[kind] = { max, mean: bTo > bFrom ? weighted / (bTo - bFrom) : active };
    }
  }
  return { from: window.from, to: window.to, bucketMs: size, buckets: out.filter((b) => Object.keys(b.active).length > 0), limits, complete };
}

/** The execution a visit ran in: its `execution_id`, else its parent when that is an execution. */
function executionRefOf(span: TimelineSpan): string | null {
  const id = span.ids.execution_id;
  if (id) return `execution:${id}`;
  return span.parent?.startsWith("execution:") ? span.parent : null;
}

/**
 * The documented rule for a visit that never recorded an exit (M6_1_SHARED_CONTRACTS, D4): it is
 * closed at its execution's end, inferred by rule `execution-ended`, reason `interrupted`, no
 * outcome, reconstructed. An M6.3 observer already sends visits closed this way. This is the CLIENT
 * applying the same rule, as a safety net for an older observer: a visit is never presented as open
 * (still running) when the execution it ran in has ended in the same answer. Only spans in the same
 * answer are compared; a visit whose execution is not in the answer is left as it is. The duration is
 * bounded, not measured: at most entry to the execution's end (`maxMs`), never "took".
 */
export function closeEndedVisits(spans: readonly TimelineSpan[]): TimelineSpan[] {
  let ended: Map<string, SpanEnd> | null = null;
  for (const s of spans) {
    if (s.kind !== "execution" || !s.end || s.end.at === null) continue;
    (ended ??= new Map()).set(s.entity, s.end);
  }
  if (!ended) return spans as TimelineSpan[];
  const out: TimelineSpan[] = [];
  for (const s of spans) {
    const exec = s.kind === "visit" && s.end === null ? executionRefOf(s) : null;
    const end = exec ? ended.get(exec) : undefined;
    const startAt = s.start ? (s.start.at ?? s.start.notBefore) : null;
    if (!end || end.at === null || (startAt !== null && startAt > end.at)) {
      out.push(s);
      continue;
    }
    out.push({
      ...s,
      end: { eventId: end.eventId, at: end.at, precision: end.precision, notBefore: null, notAfter: null, basis: "inferred", rule: "execution-ended", reason: "interrupted" },
      duration: { ms: null, minMs: null, maxMs: startAt === null ? null : Math.max(0, end.at - startAt), basis: "inferred" },
      outcome: null,
      authority: s.authority === "simulated" ? "simulated" : "reconstructed",
    });
  }
  return out;
}
