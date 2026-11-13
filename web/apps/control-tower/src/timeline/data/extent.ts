/**
 * `recordedExtent(data)`: from the first to the last thing RECORDED, for the workspace's default
 * window. `data.extent()` is the whole history held, which in live runs to the wall clock: a run of
 * an hour viewed seven hours later is then a sliver at the left of seven idle hours. This frames the
 * activity instead.
 *
 * It never iterates events: it reads the density series over the held extent (the first and the last
 * non-empty bucket), and, where density is not served, the last mark and the spans' bounds. It never
 * reaches past what is held. Null when nothing is held or nothing recorded is found.
 *
 * The end (X11) is the real last recorded time whenever a source gives one: the provider's newest
 * event (`lastRecordedAt`, not in the contract), the last mark, the structural spans' recorded ends.
 * Only when the density series shows events after every exact time is the end known to a bucket; then
 * `lastIsBucket` is true, `lastBucket` holds that bucket, and the words must say "between".
 */
import { extentOf, type MarkKind, type TimeWindow, type TimelineData } from "../contract";

/** Density buckets asked for over the held extent. */
const RESOLUTION = 1000;

/** The recorded extent, with how its end is known (X11). */
export interface RecordedExtent extends TimeWindow {
  /** True when the last recorded time is known only to a density bucket (`lastBucket`). */
  readonly lastIsBucket: boolean;
  readonly lastBucket?: TimeWindow;
}

type WithLast = TimelineData & { lastRecordedAt?: () => number | null };

export async function recordedExtent(data: TimelineData, signal?: AbortSignal): Promise<RecordedExtent | null> {
  const whole = data.extent();
  if (!whole || !(whole.to >= whole.from)) return null;
  let from = Number.POSITIVE_INFINITY;
  let to = Number.NEGATIVE_INFINITY;
  const take = (a: number, b: number) => {
    if (a < from) from = a;
    if (b > to) to = b;
  };

  /** The latest exact recorded time found. */
  let exact = Number.NEGATIVE_INFINITY;
  const exactly = (t: number | null | undefined) => {
    if (typeof t === "number" && Number.isFinite(t) && t > exact) exact = t;
  };

  const density = await data.density({ from: whole.from, to: Math.max(whole.to, whole.from + 1) }, RESOLUTION, undefined, signal);
  const first = density.buckets[0];
  const last = density.buckets[density.buckets.length - 1];
  if (first) from = first.from;

  // The provider's newest event, exactly.
  exactly((data as WithLast).lastRecordedAt?.() ?? null);
  // The last mark (a mark is a recorded moment; one may be an interval that ends later). Every kind.
  const mark = await data.nextMark(whole.to + 1, -1, [] as readonly MarkKind[], signal);
  if (mark) {
    take(mark.at, mark.at);
    exactly(mark.until ?? mark.at);
  }
  // The structural spans' recorded starts and ends (exact), when the provider serves them.
  if (typeof data.structure === "function") {
    const page = await data.structure(signal);
    for (const s of page.spans) {
      const start = s.start?.at;
      if (typeof start === "number") {
        take(start, start);
        exactly(start);
      }
      exactly(s.end?.at);
    }
  }
  let lastIsBucket = false;
  let lastBucket: TimeWindow | undefined;
  if (last) {
    const bucket = { from: last.from, to: Math.min(whole.to, last.from + density.bucketMs) };
    if (exact >= bucket.from) take(exact, exact);
    else {
      // Events after every exact time: only their bucket is known.
      lastIsBucket = true;
      lastBucket = bucket;
      take(bucket.from, bucket.to);
    }
  } else if (Number.isFinite(exact)) take(exact, exact);

  // Without density, the spans' own bounds: first start, last recorded end (an open span's end is not recorded).
  if (!first) {
    const page = await data.spans({ window: whole }, signal);
    for (const s of page.spans) {
      const x = extentOf(s);
      if (!x) continue;
      take(x.from, Number.isFinite(x.to) ? x.to : x.from);
    }
  }
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  const out = { from: Math.max(whole.from, from), to: Math.min(whole.to, Math.max(to, from)) };
  return lastIsBucket && lastBucket ? { ...out, lastIsBucket, lastBucket } : { ...out, lastIsBucket };
}

interface Shared {
  from: number | null;
  promise: Promise<RecordedExtent | null> | null;
}
const shared = new WeakMap<TimelineData, Shared>();

/**
 * `recordedExtent`, one read for every caller (the default window and the overview ask the same thing):
 * the answer is kept until the provider says its cursor moved (`subscribe`) or the held history's
 * start changes; callers asking meanwhile share it, in flight or answered. A caller's `signal` only
 * stops it waiting; the read itself goes on for the others. A failed read is not kept.
 */
export function sharedRecordedExtent(data: TimelineData, signal?: AbortSignal): Promise<RecordedExtent | null> {
  const from = data.extent()?.from ?? null;
  let entry = shared.get(data);
  if (!entry) {
    const made: Shared = { from, promise: null };
    entry = made;
    shared.set(data, made);
    // Kept for the provider's life (one per provider): any change of what is held drops the answer.
    data.subscribe(() => {
      made.promise = null;
    });
  }
  if (entry.from !== from) {
    entry.from = from;
    entry.promise = null;
  }
  const held = entry;
  if (!held.promise) {
    const p = recordedExtent(data);
    held.promise = p;
    p.catch(() => {
      if (held.promise === p) held.promise = null;
    });
  }
  const p = held.promise;
  if (!signal) return p;
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new DOMException("The request was superseded.", "AbortError"));
      return;
    }
    const onAbort = () => reject(signal.reason ?? new DOMException("The request was superseded.", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}
