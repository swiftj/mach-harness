/**
 * The tracks' keyboard model: a pure reducer from (key, where things are) to what should change. The
 * canvas is one tab stop; the caller owns the cursor (TrackCanvasProps.cursor / onCursor).
 *
 *   Up / Down            previous / next row (every row is a stop, a group row too)
 *   Left / Right         previous / next span or instant on the row; nothing at the row's ends
 *   Enter                select the span under the cursor, or open / close a group row
 *   Alt+Right, *         expand the row;  Alt+Left  collapse it
 *   + or =, -, 0         zoom in / out about the cursor; frame the cursor's span (or its row's spans)
 *   Shift+Left / Right   pan by a tenth of the window
 *   PageUp / PageDown    a screen of rows up / down
 *
 * Nothing else is taken: the global playback keys (, . < > [ ] { } Space Home End l f i s t 1 2 3 ?)
 * and the workspace's (g / n p z a) pass through untouched.
 */
import { type FlatRow, type RowLayout, type TimelineCursor, type TimelineSpan, type TimeWindow, type TrackTree } from "../contract";
import { laneIndex, spanTimes } from "./lod";
import { clampWindow, frameWindow, panBy, zoomAbout } from "./scale";

export interface KeyInput {
  readonly key: string;
  readonly altKey?: boolean;
  readonly shiftKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
}

export interface KeyModel {
  readonly tree: TrackTree;
  readonly layout: RowLayout;
  readonly cursor: TimelineCursor | null;
  readonly window: TimeWindow;
  readonly liveAt: number;
  readonly scrollTop: number;
  /** The tracks' visible height, CSS px. */
  readonly height: number;
}

export interface KeyResult {
  /** False: not this model's key; let it reach the global map. */
  readonly handled: boolean;
  readonly cursor?: TimelineCursor;
  readonly window?: TimeWindow;
  readonly scrollTop?: number;
  readonly select?: TimelineSpan;
  readonly toggle?: string;
}

const NOT_MINE: KeyResult = { handled: false };
const NOTHING: KeyResult = { handled: true };

export const ZOOM_STEP = 1.5;

/** The row the cursor stands on; when its row is gone (a parent was collapsed), the nearest shown ancestor. */
export function cursorRow(model: Pick<KeyModel, "tree" | "layout" | "cursor">): FlatRow | null {
  const c = model.cursor;
  if (!c) return null;
  const row = model.layout.rowOf(c.trackId, c.lane) ?? model.layout.rowOf(c.trackId, 0);
  if (row) return row;
  let id = model.tree.byId.get(c.trackId)?.parentId ?? null;
  while (id) {
    const r = model.layout.rowOf(id, 0);
    if (r) return r;
    id = model.tree.byId.get(id)?.parentId ?? null;
  }
  return null;
}

/** The spans of a row the cursor can stand on: known by `liveAt`, in start order. */
export function rowSpans(row: FlatRow, liveAt: number): TimelineSpan[] {
  const lane = row.node.lanes[row.lane];
  if (!lane) return [];
  return laneIndex(lane.spans).spans.filter((s) => spanTimes(s, liveAt) !== null);
}

function times(span: TimelineSpan, liveAt: number): { from: number; to: number } {
  const t = spanTimes(span, liveAt);
  return t ? { from: t.from, to: t.to } : { from: liveAt, to: liveAt };
}

/** The time the cursor is about: its span's middle (clamped to the window), else the window's middle. */
export function cursorTime(model: KeyModel, span: TimelineSpan | null): number {
  const mid = (model.window.from + model.window.to) / 2;
  if (!span) return mid;
  const t = times(span, model.liveAt);
  const m = (t.from + t.to) / 2;
  return Math.max(model.window.from, Math.min(model.window.to, Math.max(t.from, Math.min(t.to, m))));
}

/** The window moved the least to show [from, to] (its start when longer than the window). Unchanged when already shown. */
export function panToShow(win: TimeWindow, from: number, to: number): TimeWindow {
  const w = win.to - win.from;
  const pad = w * 0.05;
  if (from >= win.from && to <= win.to) return win;
  if (to - from > w - 2 * pad || from < win.from) return { from: from - pad, to: from - pad + w };
  return { from: to + pad - w, to: to + pad };
}

/** The scroll position that shows the row whole, moved the least. */
export function scrollToShow(row: FlatRow, scrollTop: number, height: number, total: number): number {
  let top = scrollTop;
  if (row.y < top) top = row.y;
  else if (row.y + row.height > top + height) top = row.y + row.height - height;
  return Math.max(0, Math.min(Math.max(0, total - height), top));
}

function spanOf(row: FlatRow | null, id: string | null, liveAt: number): TimelineSpan | null {
  if (!row || !id) return null;
  return rowSpans(row, liveAt).find((s) => s.id === id) ?? null;
}

/** Move to `row`, keeping the time: the span there under the current time, if one. */
function onRow(model: KeyModel, row: FlatRow, t: number): TimelineCursor {
  const spans = rowSpans(row, model.liveAt);
  const under = spans.filter((s) => {
    const x = times(s, model.liveAt);
    return x.from <= t && x.to >= t;
  });
  const pick = under.length ? under.reduce((a, b) => (times(a, model.liveAt).to - times(a, model.liveAt).from <= times(b, model.liveAt).to - times(b, model.liveAt).from ? a : b)) : null;
  return { trackId: row.node.id, lane: row.lane, spanId: pick?.id ?? null };
}

/** Bring the cursor into view: scroll its row and pan its span in. */
function reveal(model: KeyModel, cursor: TimelineCursor, extra: Partial<KeyResult> = {}): KeyResult {
  const row = model.layout.rowOf(cursor.trackId, cursor.lane);
  const out: { -readonly [K in keyof KeyResult]: KeyResult[K] } = { handled: true, cursor, ...extra };
  if (row) {
    const top = scrollToShow(row, extra.scrollTop ?? model.scrollTop, model.height, model.layout.totalHeight);
    if (top !== model.scrollTop) out.scrollTop = top;
    else delete out.scrollTop;
  }
  const span = spanOf(row, cursor.spanId, model.liveAt);
  if (span) {
    const t = times(span, model.liveAt);
    const base = extra.window ?? model.window;
    const next = panToShow(base, t.from, t.to);
    if (next !== model.window) out.window = next;
  }
  return out;
}

export function keyAction(input: KeyInput, model: KeyModel): KeyResult {
  if (input.ctrlKey || input.metaKey) return NOT_MINE;
  const rows = model.layout.rows;
  if (rows.length === 0) return NOT_MINE;
  const row = cursorRow(model) ?? rows[0]!;
  const at = rows.indexOf(row);
  const span = spanOf(row, model.cursor?.spanId ?? null, model.liveAt);
  const here: TimelineCursor = { trackId: row.node.id, lane: row.lane, spanId: span?.id ?? null };
  const win = model.window;
  const width = win.to - win.from;

  switch (input.key) {
    case "ArrowUp":
    case "ArrowDown": {
      if (input.altKey || input.shiftKey) return NOTHING;
      const i = at + (input.key === "ArrowUp" ? -1 : 1);
      if (!model.cursor) return reveal(model, onRow(model, row, cursorTime(model, null)));
      const next = rows[i];
      if (!next) return NOTHING;
      return reveal(model, onRow(model, next, cursorTime(model, span)));
    }
    case "ArrowLeft":
    case "ArrowRight": {
      const dir = input.key === "ArrowLeft" ? -1 : 1;
      if (input.shiftKey) return { handled: true, window: panBy(win, (dir * width) / 10) };
      if (input.altKey) {
        if (!row.hasChildren || row.lane !== 0 || row.expanded === (dir > 0)) return { handled: true, cursor: here };
        return { handled: true, cursor: { ...here, spanId: null }, toggle: row.node.id };
      }
      const spans = rowSpans(row, model.liveAt);
      if (!spans.length) return { handled: true, cursor: here };
      let target: TimelineSpan | undefined;
      if (span) {
        const i = spans.indexOf(span) + dir;
        target = spans[i];
      } else if (dir > 0) {
        // From the row itself: the first span that reaches into the window (or the first after it).
        target = spans.find((s) => times(s, model.liveAt).to >= win.from);
      } else {
        target = [...spans].reverse().find((s) => times(s, model.liveAt).from <= win.to);
      }
      if (!target) return { handled: true, cursor: here };
      return reveal(model, { ...here, spanId: target.id });
    }
    case "Enter": {
      if (span) return { handled: true, cursor: here, select: span };
      if (row.hasChildren && row.lane === 0) return { handled: true, cursor: here, toggle: row.node.id };
      return { handled: true, cursor: here };
    }
    case "*": {
      if (row.hasChildren && row.lane === 0 && !row.expanded) return { handled: true, cursor: { ...here, spanId: null }, toggle: row.node.id };
      return { handled: true, cursor: here };
    }
    case "+":
    case "=":
    case "-":
    case "_": {
      const factor = input.key === "-" || input.key === "_" ? ZOOM_STEP : 1 / ZOOM_STEP;
      return { handled: true, cursor: here, window: clampWindow(zoomAbout(win, factor, cursorTime(model, span))) };
    }
    case "0": {
      // Frame the cursor's span, or every span on its row up to the live edge.
      let from = Infinity;
      let to = -Infinity;
      for (const s of span ? [span] : row.node.lanes.flatMap((l) => l.spans)) {
        const t = spanTimes(s, model.liveAt);
        if (!t) continue;
        from = Math.min(from, t.from);
        to = Math.max(to, t.to);
      }
      if (from === Infinity) return { handled: true, cursor: here };
      return { handled: true, cursor: here, window: frameWindow(from, to) };
    }
    case "PageUp":
    case "PageDown": {
      const dir = input.key === "PageUp" ? -1 : 1;
      const max = Math.max(0, model.layout.totalHeight - model.height);
      const top = Math.max(0, Math.min(max, model.scrollTop + dir * model.height));
      // The cursor keeps its place on the screen: the row a screen away.
      const y = Math.max(0, Math.min(model.layout.totalHeight - 1, row.y + dir * model.height));
      const target = model.layout.slice(y, y + 0.5).find((r) => y >= r.y && y < r.y + r.height) ?? (dir > 0 ? rows[rows.length - 1]! : rows[0]!);
      return reveal(model, onRow(model, target, cursorTime(model, span)), top !== model.scrollTop ? { scrollTop: top } : {});
    }
    default:
      return NOT_MINE;
  }
}
