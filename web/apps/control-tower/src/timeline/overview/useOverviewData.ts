/**
 * What the overview draws, fetched from the Timeline's data provider: density, concurrency and marks
 * for the whole extent. Asked for on mount, when the filters or the width change, when the provider
 * says something changed (its cursor moved: at most once per NOTIFY_THROTTLE_MS), and when the live
 * edge passes the end of what was asked for. Each answer reaches AHEAD past the edge (nothing is
 * recorded there yet, so it is empty), so a live edge stepping forward with nothing new never asks
 * again on its own (L8 of the live run: the overview asked on every live-edge step, about 100 requests
 * a minute with nothing happening). A superseded request is aborted; the last good answer stays drawn
 * while the next is in flight.
 */
import { useEffect, useState } from "react";
import type { ConcurrencySeries, DensitySeries, TimelineData, TimelineFilters, TimelineMark, TimeWindow } from "../contract";
import { OVERVIEW_MARK_KINDS } from "./model";

/** The fewest milliseconds between two re-queries caused by the provider's notifications. */
export const NOTIFY_THROTTLE_MS = 5000;

/** How far past the live edge an answer reaches: a tenth of the history, at least a minute. */
export function aheadOf(extent: TimeWindow): number {
  return Math.max(60_000, (extent.to - extent.from) * 0.1);
}

/**
 * The extent to ask for, given the one asked for last: unchanged while it still covers `extent` (the
 * live edge moving inside it asks nothing), else `extent` reaching AHEAD past its end.
 */
export function askedExtent(prev: TimeWindow | null, extent: TimeWindow): TimeWindow {
  if (prev && prev.from === extent.from && extent.to <= prev.to && extent.to >= prev.to - 2 * aheadOf(extent)) return prev;
  return { from: extent.from, to: extent.to + aheadOf(extent) };
}

export interface OverviewData {
  readonly density: DensitySeries | null;
  readonly concurrency: ConcurrencySeries | null;
  readonly marks: readonly TimelineMark[];
  /** Nothing has answered yet (the first load). */
  readonly loading: boolean;
  /** A newer request is in flight; what is drawn is the previous answer. */
  readonly pending: boolean;
  /** The last request failed and nothing earlier answered either. */
  readonly failed: boolean;
  /** Filters the density cannot follow (more than one ticket or execution): it is drawn for all. */
  readonly unfiltered: boolean;
  /** The marks answer was cut or partial (the data layer's `complete: false` / `truncated` on the array, T8). */
  readonly marksIncomplete: boolean;
}

interface Answer {
  readonly key: string;
  readonly density: DensitySeries | null;
  readonly concurrency: ConcurrencySeries | null;
  readonly marks: readonly TimelineMark[];
  readonly answered: boolean;
}

const NONE: Answer = { key: "", density: null, concurrency: null, marks: [], answered: false };

export function useOverviewData(data: TimelineData, extent: TimeWindow, width: number, filters: TimelineFilters): OverviewData {
  // Re-query when the provider says so, throttled.
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let last = 0;
    let timer: number | null = null;
    const off = data.subscribe(() => {
      if (timer !== null) return;
      const wait = Math.max(0, last + NOTIFY_THROTTLE_MS - performance.now());
      timer = window.setTimeout(() => {
        timer = null;
        last = performance.now();
        setNonce((n) => n + 1);
      }, wait);
    });
    return () => {
      off();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [data]);

  // The extent asked for: moved only when the real one passes its end (or changed start, or shrank far).
  const [asked, setAsked] = useState<TimeWindow>(() => askedExtent(null, extent));
  const nextAsked = askedExtent(asked, extent);
  if (nextAsked !== asked) setAsked(nextAsked);

  const ticket = filters.tickets.length === 1 ? filters.tickets[0] : undefined;
  const execution = filters.executions.length === 1 ? filters.executions[0] : undefined;
  const unfiltered = filters.tickets.length > 1 || filters.executions.length > 1;
  const columns = Math.max(0, Math.floor(width));
  const key = `${asked.from}|${asked.to}|${columns}|${ticket ?? ""}|${execution ?? ""}|${nonce}`;

  const [answer, setAnswer] = useState<Answer>(NONE);
  useEffect(() => {
    if (columns <= 0 || asked.to <= asked.from) return;
    const ac = new AbortController();
    const filter = ticket || execution ? { ticket, execution } : undefined;
    const window = { from: asked.from, to: asked.to };
    void Promise.allSettled([
      data.density(window, columns, filter, ac.signal),
      // Two pixels a bucket: steps stay legible and the observer's answer stays small.
      data.concurrency(window, Math.max(1, Math.floor(columns / 2)), ac.signal),
      data.marks(window, OVERVIEW_MARK_KINDS, ac.signal),
    ]).then(([d, c, m]) => {
      if (ac.signal.aborted) return;
      setAnswer((prev) => ({
        key,
        density: d.status === "fulfilled" ? d.value : prev.density,
        concurrency: c.status === "fulfilled" ? c.value : prev.concurrency,
        marks: m.status === "fulfilled" ? m.value : prev.marks,
        answered: prev.answered || d.status === "fulfilled" || c.status === "fulfilled" || m.status === "fulfilled",
      }));
    });
    return () => ac.abort();
    // `key` stands for every input above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, key]);

  const settled = answer.key !== "";
  return {
    density: answer.density,
    concurrency: answer.concurrency,
    marks: answer.marks,
    loading: !settled,
    pending: settled && answer.key !== key,
    failed: settled && !answer.answered,
    unfiltered,
    marksIncomplete: (answer.marks as { complete?: boolean }).complete === false || (answer.marks as { truncated?: boolean }).truncated === true,
  };
}
