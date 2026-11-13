/**
 * The structured alternative's model, pure: the rows of the tree-grid for a layout and a window, the
 * window's per-track index, virtualisation, and the WAI-ARIA treegrid keyboard (row focus). Tested in
 * plain node (test/timeline-a11y.test.mjs), including at 60,000 spans.
 *
 * Cost: building the rows is linear in the layout's rows plus the spans of the tracks the table has
 * opened (each capped at SPAN_CAP shown); summaries are computed lazily, per window, for the rows that
 * are drawn. A keystroke is a constant-time step over the built rows (a key-to-index map, no scan).
 */
import { extentOf, type RowLayout, type TimelineSpan, type TimeWindow, type TrackNode } from "../contract";
import { inWindow, ownSpans, summariseTrack, type TrackSummary } from "./describe";

/** The most spans listed under one track; beyond it a row says how many more and to narrow the window. */
export const SPAN_CAP = 200;
/** Every row is this tall: a 24 px target with room, and constant-time virtualisation. */
export const GRID_ROW_HEIGHT = 32;
export const GRID_HEADER_HEIGHT = 32;

interface RowBase {
  /** Stable: `track:<id>`, `span:<id>` or `more:<track id>`. */
  readonly key: string;
  readonly node: TrackNode;
  /** aria-level, from 1. */
  readonly level: number;
  readonly parentKey: string | null;
  posInSet: number;
  setSize: number;
}
export interface TrackGridRow extends RowBase {
  readonly type: "track";
  readonly expandable: boolean;
  readonly expanded: boolean;
}
export interface SpanGridRow extends RowBase {
  readonly type: "span";
  readonly span: TimelineSpan;
}
/** "n more: narrow the window", or (hidden 0) "nothing of this track in this window". */
export interface MoreGridRow extends RowBase {
  readonly type: "more";
  readonly hidden: number;
}
export type GridRow = TrackGridRow | SpanGridRow | MoreGridRow;

export interface GridModel {
  readonly rows: readonly GridRow[];
  /** Row index by key. */
  readonly indexOf: ReadonlyMap<string, number>;
}

/** Per window: a track's own spans in time order and its subtree's summary, each computed once on demand. */
export interface WindowIndex {
  readonly window: TimeWindow;
  readonly liveAt: number;
  spansOf(node: TrackNode): readonly TimelineSpan[];
  summaryOf(node: TrackNode): TrackSummary;
}

const startOf = (s: TimelineSpan): number => extentOf(s)?.from ?? Number.POSITIVE_INFINITY;

export function indexWindow(window: TimeWindow, liveAt: number): WindowIndex {
  const spans = new Map<string, readonly TimelineSpan[]>();
  const summaries = new Map<string, TrackSummary>();
  return {
    window,
    liveAt,
    spansOf(node) {
      let list = spans.get(node.id);
      if (!list) {
        const out: TimelineSpan[] = [];
        for (const s of ownSpans(node)) if (inWindow(s, window, liveAt)) out.push(s);
        // Time order across lanes; ties by id, so the order never depends on lane packing.
        out.sort((a, b) => startOf(a) - startOf(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        list = out;
        spans.set(node.id, list);
      }
      return list;
    },
    summaryOf(node) {
      return summariseTrack(node, window, liveAt, summaries);
    },
  };
}

/** Whether the table holds a track open: the layout's expansion for a track with children, the table's own for a leaf. */
export function isOpen(node: TrackNode, layoutExpanded: boolean, openLeaves: ReadonlySet<string>): boolean {
  return node.children.length > 0 ? layoutExpanded : openLeaves.has(node.id);
}

const hasOwnSpans = (node: TrackNode): boolean => node.lanes.some((l) => l.spans.length > 0);

/**
 * The grid's rows: the layout's tracks (first lane only: lanes are one track), and under each open
 * track its own spans in the window in time order (at most SPAN_CAP, then a "more" row) before its
 * child tracks. A leaf with spans anywhere is expandable; opened with none in the window it says so.
 */
export function buildGridRows(layout: RowLayout, index: WindowIndex, openLeaves: ReadonlySet<string>): GridModel {
  const rows: GridRow[] = [];
  for (const flat of layout.rows) {
    if (flat.lane !== 0) continue;
    const node = flat.node;
    const parentKey = node.parentId === null ? null : `track:${node.parentId}`;
    const leafWithSpans = node.children.length === 0 && hasOwnSpans(node);
    const expandable = node.children.length > 0 || leafWithSpans;
    const expanded = expandable && isOpen(node, flat.expanded, openLeaves);
    const key = `track:${node.id}`;
    rows.push({ type: "track", key, node, level: node.depth + 1, parentKey, expandable, expanded, posInSet: 0, setSize: 0 });
    if (!expanded) continue;
    const own = index.spansOf(node);
    const level = node.depth + 2;
    const shown = Math.min(own.length, SPAN_CAP);
    for (let i = 0; i < shown; i++) {
      const span = own[i] as TimelineSpan;
      rows.push({ type: "span", key: `span:${span.id}`, node, level, parentKey: key, span, posInSet: 0, setSize: 0 });
    }
    if (own.length > SPAN_CAP || (own.length === 0 && node.children.length === 0)) {
      rows.push({ type: "more", key: `more:${node.id}`, node, level, parentKey: key, hidden: own.length - shown, posInSet: 0, setSize: 0 });
    }
  }
  // aria-posinset and aria-setsize: siblings share a parent key and appear in order.
  const sizes = new Map<string | null, number>();
  for (const r of rows) {
    const n = (sizes.get(r.parentKey) ?? 0) + 1;
    sizes.set(r.parentKey, n);
    r.posInSet = n;
  }
  const indexOf = new Map<string, number>();
  rows.forEach((r, i) => {
    r.setSize = sizes.get(r.parentKey) ?? 1;
    indexOf.set(r.key, i);
  });
  return { rows, indexOf };
}

// ---------------------------------------------------------------- virtualisation

/** The grid's geometry: one row height (constant, for constant-time virtualisation) and the sticky header's. */
export interface GridGeometry {
  readonly row: number;
  readonly header: number;
}
export const WIDE: GridGeometry = { row: GRID_ROW_HEIGHT, header: GRID_HEADER_HEIGHT };
/**
 * Below this width the columns stack (track; what; the times, duration, outcome and authority on a
 * third line), so a row reads without scrolling sideways, at 200% zoom too (WCAG 1.4.10).
 */
export const STACK_BELOW = 1080;
/** Stacked: three 20 px lines and room; the column headers are for screen readers only. */
export const STACKED: GridGeometry = { row: 68, header: 0 };

/** The rows to put in the DOM for a scroll position: those in view plus `overscan` on each side. */
export function visibleRange(scrollTop: number, height: number, count: number, overscan = 8, g: GridGeometry = WIDE): { start: number; end: number } {
  const body = Math.max(0, scrollTop);
  const first = Math.floor(body / g.row);
  const last = Math.ceil((body + Math.max(0, height - g.header)) / g.row);
  return { start: Math.max(0, first - overscan), end: Math.min(count, last + overscan) };
}

/** The scroll position that shows row `index` whole under the sticky header, moving as little as possible. */
export function scrollToShow(index: number, scrollTop: number, height: number, g: GridGeometry = WIDE): number {
  const top = index * g.row;
  const bottom = top + g.row;
  const view = Math.max(g.row, height - g.header);
  if (top < scrollTop) return top;
  if (bottom > scrollTop + view) return bottom - view;
  return scrollTop;
}

// ---------------------------------------------------------------- keyboard (WAI-ARIA treegrid, row focus)

export type GridAction = { readonly type: "focus"; readonly index: number } | { readonly type: "toggle"; readonly index: number } | { readonly type: "select"; readonly index: number };

export interface GridKey {
  readonly key: string;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly altKey?: boolean;
  readonly shiftKey?: boolean;
}

/** The keys the grid owns while it has focus: each prevents its default, so the global map skips it. */
export const GRID_KEYS: readonly string[] = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "Ctrl+Home", "Ctrl+End", "PageUp", "PageDown", "Enter"];

/**
 * What a key does on row `index`. Up and Down move a row; Right opens a closed track, or moves into an
 * open one; Left closes an open track, or moves to the parent; Home and End (with or without Ctrl) go
 * to the first and last row; PageUp and PageDown move by `page` rows; Enter selects a span (and opens
 * or closes a track). Anything else is null: the key is left to the rest of the app.
 */
export function gridKey(model: GridModel, index: number, e: GridKey, page = 10): GridAction | null {
  const { rows, indexOf } = model;
  const n = rows.length;
  if (n === 0 || e.metaKey || e.altKey) return null;
  const i = Math.max(0, Math.min(n - 1, index));
  const row = rows[i] as GridRow;
  const focus = (to: number): GridAction => ({ type: "focus", index: Math.max(0, Math.min(n - 1, to)) });
  if (e.ctrlKey && e.key !== "Home" && e.key !== "End") return null;
  switch (e.key) {
    case "ArrowDown":
      return focus(i + 1);
    case "ArrowUp":
      return focus(i - 1);
    case "Home":
      return focus(0);
    case "End":
      return focus(n - 1);
    case "PageDown":
      return focus(i + Math.max(1, page));
    case "PageUp":
      return focus(i - Math.max(1, page));
    case "ArrowRight":
      if (row.type !== "track" || !row.expandable) return focus(i);
      if (!row.expanded) return { type: "toggle", index: i };
      return rows[i + 1]?.parentKey === row.key ? focus(i + 1) : focus(i);
    case "ArrowLeft": {
      if (row.type === "track" && row.expanded) return { type: "toggle", index: i };
      const parent = row.parentKey === null ? undefined : indexOf.get(row.parentKey);
      return focus(parent ?? i);
    }
    case "Enter":
      if (row.type === "span") return { type: "select", index: i };
      if (row.type === "track" && row.expandable) return { type: "toggle", index: i };
      return null;
    default:
      return null;
  }
}
