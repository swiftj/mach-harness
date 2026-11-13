/**
 * `recordedExtent(data)`: from the first to the last thing RECORDED, for the workspace's default
 * window. `data.extent()` is the whole history held, which in live runs to the wall clock: a run of
 * an hour viewed seven hours later is then a sliver at the left of seven idle hours. This frames the
 * activity instead.
 *
 * It never iterates events: it reads the density series over the held extent (the first and the last
 * non-empty bucket), and, where density is not served, the last mark and the spans' bounds. The
 * answer is as coarse as one density bucket (the held extent / RESOLUTION) and never reaches past
 * what is held. Null when nothing is held or nothing recorded is found.
 */
import { extentOf, type MarkKind, type TimeWindow, type TimelineData } from "../contract";
import { MARK_KINDS } from "./parse";

/** Density buckets asked for over the held extent. */
const RESOLUTION = 1000;

export async function recordedExtent(data: TimelineData, signal?: AbortSignal): Promise<TimeWindow | null> {
  const whole = data.extent();
  if (!whole || !(whole.to >= whole.from)) return null;
  let from = Number.POSITIVE_INFINITY;
  let to = Number.NEGATIVE_INFINITY;
  const take = (a: number, b: number) => {
    if (a < from) from = a;
    if (b > to) to = b;
  };

  const density = await data.density({ from: whole.from, to: Math.max(whole.to, whole.from + 1) }, RESOLUTION, undefined, signal);
  const first = density.buckets[0];
  const last = density.buckets[density.buckets.length - 1];
  if (first && last) take(first.from, last.from + density.bucketMs);

  // The last mark (a mark is a recorded moment; one may be an interval that ends later).
  const mark = await data.nextMark(whole.to + 1, -1, MARK_KINDS as readonly MarkKind[], signal);
  if (mark) take(mark.at, mark.until ?? mark.at);

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
  return { from: Math.max(whole.from, from), to: Math.min(whole.to, Math.max(to, from)) };
}
