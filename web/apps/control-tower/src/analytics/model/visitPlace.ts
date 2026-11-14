/**
 * Where one station visit sits among the measured visits of its station (I-12, journey 3): how many
 * were shorter and how many longer, read from the observer's log buckets. The bucket the visit falls in
 * is said as a range, never as an exact rank, because a bucket only bounds its visits (the Timeline's
 * bounded grammar: "between A and B").
 */
import type { HistBin } from "./charts";

export interface VisitPlace {
  readonly shorter: number;
  readonly longer: number;
  /** Visits in the same bucket as this one (it may be among them): neither shorter nor longer is known. */
  readonly same: number;
  readonly total: number;
  readonly bin: { readonly fromMs: number; readonly toMs: number } | null;
}

export function visitPlace(bins: readonly HistBin[], ms: number): VisitPlace {
  let shorter = 0;
  let longer = 0;
  let same = 0;
  let bin: VisitPlace["bin"] = null;
  for (const b of bins) {
    if (ms >= b.toMs) shorter += b.count;
    else if (ms < b.fromMs) longer += b.count;
    else {
      same += b.count;
      bin = { fromMs: b.fromMs, toMs: b.toMs };
    }
  }
  return { shorter, longer, same, total: shorter + longer + same, bin };
}

/** The sentence: "4 min 12 s, measured. Of 38 measured visits in this period, 20 were shorter and 9 longer; 9 were between 4 min and 8 min, as this one was." */
export function visitPlaceWords(place: VisitPlace, ms: number, duration: (ms: number) => string): string {
  const head = `${duration(ms)}, measured.`;
  if (!place.total) return `${head} No measured visit of this station is in this period to compare it with.`;
  const plural = (n: number) => `${n.toLocaleString("en-GB")} measured visit${n === 1 ? "" : "s"}`;
  const between = place.bin ? `; ${place.same.toLocaleString("en-GB")} ${place.same === 1 ? "was" : "were"} between ${duration(place.bin.fromMs)} and ${duration(place.bin.toMs)}, as this one was` : "";
  return `${head} Of ${plural(place.total)} in this period, ${place.shorter.toLocaleString("en-GB")} ${place.shorter === 1 ? "was" : "were"} shorter and ${place.longer.toLocaleString("en-GB")} longer${between}.`;
}
