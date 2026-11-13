/**
 * The records a lens panel reads beyond the spans it is given: the marks of the window and, for the
 * parallel-execution lens, the concurrency series. Re-read when the window or the provider changes.
 */
import { useEffect, useState } from "react";
import type { ConcurrencySeries, TimelineData, TimelineMark, TimeWindow } from "../contract";

export interface LensData {
  readonly marks: readonly TimelineMark[];
  readonly series: ConcurrencySeries | null;
  /** "loading" until the first answer; "unavailable" when the provider does not serve it. */
  readonly status: "loading" | "ready" | "unavailable";
}

const BUCKETS = 240;

export function useLensData(data: TimelineData, window: TimeWindow, withSeries: boolean): LensData {
  const { from, to } = window;
  const [state, setState] = useState<LensData>({ marks: [], series: null, status: "loading" });
  const [version, setVersion] = useState(0);
  useEffect(() => data.subscribe(() => setVersion((v) => v + 1)), [data]);
  useEffect(() => {
    const ctl = new AbortController();
    const w = { from, to };
    const marks = data.marks(w, undefined, ctl.signal).catch(() => null);
    const series = withSeries ? data.concurrency(w, BUCKETS, ctl.signal).catch(() => null) : Promise.resolve(null);
    void Promise.all([marks, series]).then(([m, s]) => {
      if (ctl.signal.aborted) return;
      setState({ marks: m ?? [], series: s, status: m === null ? "unavailable" : "ready" });
    });
    return () => ctl.abort();
  }, [data, from, to, withSeries, version]);
  return state;
}
