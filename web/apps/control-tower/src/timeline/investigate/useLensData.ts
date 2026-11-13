/**
 * The records a lens panel reads beyond the spans it is given: the marks of the window and, for the
 * parallel-execution lens, the concurrency series. Asked for a range a little wider than the window,
 * snapped to a step (`lensRange`), so a window that follows the live edge asks again only when it
 * leaves that range, never per live-edge step; and again when the provider says its cursor moved, at
 * most once per NOTIFY_THROTTLE_MS (L8 of the live run: a lens asked on every notification).
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
/** The fewest milliseconds between two re-reads caused by the provider's notifications. */
export const NOTIFY_THROTTLE_MS = 4000;

/**
 * The range asked for a window: its ends snapped outwards to a step of an eighth of its length (at
 * least 10 s). A window moving within one step asks for the same range.
 */
export function lensRange(window: TimeWindow): TimeWindow {
  const step = Math.max(10_000, (window.to - window.from) / 8);
  return { from: Math.floor(window.from / step) * step, to: Math.ceil(window.to / step) * step + step };
}

export function useLensData(data: TimelineData, window: TimeWindow, withSeries: boolean): LensData {
  const { from, to } = lensRange(window);
  const [state, setState] = useState<LensData>({ marks: [], series: null, status: "loading" });
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let last = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = data.subscribe(() => {
      if (timer !== null) return;
      timer = globalThis.setTimeout(
        () => {
          timer = null;
          last = performance.now();
          setVersion((v) => v + 1);
        },
        Math.max(0, last + NOTIFY_THROTTLE_MS - performance.now()),
      );
    });
    return () => {
      off();
      if (timer !== null) globalThis.clearTimeout(timer);
    };
  }, [data]);
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
