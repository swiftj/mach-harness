/**
 * The cursor the workspace's views share, and one view's snapshot, without React (unit-tested with a
 * slow fake provider in test/analytics-wire.test.mjs).
 *
 * Every view after the first reads at the cursor the views before it pinned, so a new period or filter
 * never mixes projection states. A view begun while an earlier one is still pinning the cursor (its
 * first query out, the person already choosing another period) waits for that pin instead of asking
 * the head itself; and a view left while it pins is abandoned only once its first query has answered.
 * Otherwise a view's first query would go out with no cursor while the rest of its queries carry one.
 */
import { loadArea, type LoadInput, type LoadResult } from "./load";
import { beginSnapshot, type AnalyticsSnapshotSession } from "../data/snapshot";
import type { AnalyticsData } from "../data/provider";

type Release = (cursor: string | null) => void;

/** The cursor of the workspace's views (per store), and whether a view is pinning it now. */
export class SharedCursor {
  cursor: string | null = null;
  /** The newest event the observer applied, from a reply's history.sources: the day a preset period ends with. */
  lastEventMs: number | null = null;
  private pinning: Promise<void> | null = null;

  /** Resolves when no view is pinning the cursor. */
  async settled(): Promise<void> {
    while (this.pinning) await this.pinning;
  }

  /**
   * Waits for any view pinning the cursor, then (in the same step, so no two views can both find it
   * free) gives the cursor to read at, or, when none is known yet, makes this view the one that pins it.
   */
  async enter(): Promise<{ readonly cursor: string | null; readonly release: Release | null }> {
    while (this.pinning) await this.pinning;
    if (this.cursor) return { cursor: this.cursor, release: null };
    let done!: () => void;
    const p = new Promise<void>((r) => (done = r));
    this.pinning = p;
    let released = false;
    const release: Release = (cursor) => {
      if (released) return;
      released = true;
      if (cursor) this.cursor = cursor;
      if (this.pinning === p) this.pinning = null;
      done();
    };
    return { cursor: null, release };
  }

  /** The next view reads the head (a refresh, a cursor no longer readable). */
  forget(): void {
    this.cursor = null;
  }
}

/** One view's snapshot, begun when first read: at the shared cursor, after any view still pinning it. */
export class ViewSession {
  private current: AnalyticsSnapshotSession | null = null;
  private starting: Promise<AnalyticsSnapshotSession> | null = null;
  private generation = 0;
  /** Set while this view pins the shared cursor: called with its cursor once known (or null on failure). */
  release: Release | null = null;
  private readonly data: AnalyticsData;
  private readonly asOfMs: number | null;
  private readonly shared: SharedCursor;
  constructor(data: AnalyticsData, asOfMs: number | null, shared: SharedCursor) {
    this.data = data;
    this.asOfMs = asOfMs;
    this.shared = shared;
  }

  async get(): Promise<AnalyticsSnapshotSession> {
    if (this.current) return this.current;
    if (this.starting) return this.starting;
    const gen = this.generation;
    this.starting = (async () => {
      const { cursor, release } = await this.shared.enter();
      const s = beginSnapshot(this.data, { asOfMs: this.asOfMs, at: cursor });
      if (gen !== this.generation) {
        release?.(null);
        s.abort();
      } else {
        this.current = s;
        this.release = release;
      }
      this.starting = null;
      return s;
    })();
    return this.starting;
  }

  /**
   * Leaves the view. A view still pinning the cursor is abandoned only once its first query has
   * answered (or failed), so the views after it read at its cursor.
   */
  abort(): void {
    this.generation++;
    const s = this.current;
    this.current = null;
    this.starting = null;
    if (!s) return;
    if (this.release) void this.shared.settled().then(() => s.abort());
    else s.abort();
  }
}

/** Loads one area of a view; the view that pins the shared cursor releases it as soon as the totals answer. */
export async function loadView(view: ViewSession, shared: SharedCursor, input: Omit<LoadInput, "session" | "onCursor">): Promise<LoadResult> {
  const session = await view.get();
  const done = (c: string | null) => {
    view.release?.(c);
    view.release = null;
  };
  try {
    const r = await loadArea({ ...input, session, onCursor: done });
    if (r.restart) shared.forget();
    else if (r.cursor) shared.cursor = r.cursor;
    if (r.lastEventMs != null) shared.lastEventMs = r.lastEventMs;
    return r;
  } finally {
    done(session.cursor);
  }
}
