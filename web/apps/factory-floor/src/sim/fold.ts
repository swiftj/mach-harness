/**
 * Incremental folds over a scene log: a list derived entry by entry (moments, landmarks, the Factory
 * track's marks...), brought up to date by reading only what was added since the last read.
 *
 * - **Appends** (the common case, live and replay): only the new entries are read, so a batch costs
 *   what it adds, not the whole history.
 * - **A late insertion or a reset** (an entry before the last one read changed): the fold is read
 *   again once, from the first retained entry.
 * - **Compaction**: items below the retained floor are dropped (nothing below it can be replayed).
 * - **Identity**: the same `LogFold` object while nothing it holds changed, so React selectors can
 *   compare by `===`.
 *
 * A fold is keyed by the log (a WeakMap): one per log, whatever reads it. Pure apart from that cache.
 */
import type { LogEntry, SceneLog } from "./log";

export interface LogFold<T> {
  /** Changes whenever `items` changes. */
  readonly version: number;
  /**
   * Ascending by `t` (entries are read in history order). Appends grow this array in place (items
   * already in it never change); a late insertion or compaction gives a new array. Read it through
   * the fold each time, and use `version` (or the fold's identity) for change detection.
   */
  readonly items: readonly T[];
}

interface Held<T> {
  version: number;
  logVersion: number;
  /** Absolute count of entries read (dropped + index). */
  read: number;
  lastId: string | null;
  floor: number;
  items: T[];
  out: LogFold<T>;
}

/** A per-log incremental list: `read` turns one entry into zero or more items. */
export function createLogFold<T extends { readonly t: number }>(read: (entry: LogEntry) => T | null | readonly T[]): (log: SceneLog) => LogFold<T> {
  const held = new WeakMap<SceneLog, Held<T>>();
  const readInto = (h: Held<T>, entries: readonly LogEntry[], from: number): boolean => {
    let changed = false;
    for (let i = from; i < entries.length; i++) {
      const got = read(entries[i] as LogEntry);
      if (got === null) continue;
      if (Array.isArray(got)) {
        if (got.length) {
          h.items.push(...(got as readonly T[]));
          changed = true;
        }
      } else {
        h.items.push(got as T);
        changed = true;
      }
    }
    return changed;
  };
  return (log) => {
    let h = held.get(log);
    const logVersion = log.version();
    if (h && h.logVersion === logVersion) return h.out;
    const entries = log.entries();
    const dropped = log.dropped();
    if (!h) {
      h = { version: 0, logVersion: -1, read: 0, lastId: null, floor: log.floorTime() ?? 0, items: [], out: { version: 0, items: [] } };
      held.set(log, h);
    }
    const lastIndex = h.read - dropped - 1;
    const appendOnly = h.read === 0 || (lastIndex >= 0 && lastIndex < entries.length && entries[lastIndex]?.id === h.lastId);
    let changed: boolean;
    if (appendOnly) {
      // Appended in place: copying would make every batch cost the whole history. A reader holding an
      // earlier fold may see items appended after its own version; items already there never change.
      changed = readInto(h, entries, Math.max(0, lastIndex + 1));
    } else {
      h.items = [];
      readInto(h, entries, 0);
      changed = true;
    }
    const floor = log.floorTime() ?? 0;
    if (floor > h.floor) {
      h.floor = floor;
      if (h.items.length && (h.items[0] as T).t < floor) {
        h.items = h.items.filter((x) => x.t >= floor);
        changed = true;
      }
    }
    h.read = dropped + entries.length;
    h.lastId = entries.at(-1)?.id ?? null;
    h.logVersion = logVersion;
    if (changed) {
      h.version += 1;
      h.out = { version: h.version, items: h.items };
    }
    return h.out;
  };
}

/** How many items have t <= the given time (binary search over an ascending list). */
export function countThrough<T extends { readonly t: number }>(list: readonly T[], t: number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((list[mid] as T).t <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
