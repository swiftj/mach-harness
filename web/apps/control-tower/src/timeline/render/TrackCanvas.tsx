/**
 * The hierarchical tracks: one canvas for every visible row (devicePixelRatio aware), drawn
 * imperatively. React renders this component only when its props or the store's selection and
 * related set change; the playhead, the live edge, the pointer's crosshair, the hover outline and the
 * hover card are written straight to the DOM and to an overlay canvas, never through React state.
 *
 * Interaction: the wheel pans rows; Shift+wheel or a horizontal wheel pans time; Ctrl or Meta+wheel
 * (and a trackpad pinch) zooms about the pointer; dragging pans both; a click selects (the caller
 * puts it in the store); a double-click frames a span, or opens a group from its empty row. Never
 * narrower than MIN_WINDOW_MS. With reduced motion every change cuts.
 *
 * Keyboard (render/keys.ts): the tracks are one tab stop, `role="application"`; the cursor is the
 * caller's (props.cursor / onCursor) and is drawn as a focus bracket on the overlay, distinct from the
 * selection's corner brackets. The hover card opens for it too, and a polite live region says what it
 * is on, at most once a second.
 *
 * Motion: only a span that has just arrived while following the live edge fades in (opacity, over
 * factoryTokens.motion.stateChange), never under reduced motion (the store's flag or the media
 * query). An end that grows simply extends; nothing animates on scrub or pan.
 */
import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { factoryTokens, useTheme } from "@mach/ui";
import { useSceneStore } from "../../scene";
import { usePlayheadEffect } from "../../shell/timeline/playhead";
import { type FlatRow, type TimelineCursor, type TimelineHit, type TimelineMark, type TimeWindow, type TrackCanvasProps } from "../contract";

/** The double-click interval: a second click on the same span or mark within it goes to it. */
const DOUBLE_CLICK_MS = 500;
import { asOfPlayhead } from "../controls";
import { drawTracks, hitBox, outlivesExecution, rowGeom, rowKey, type DrawOutput } from "./draw";
import { cursorRow, keyAction, panToShow, rowSpans } from "./keys";
import { hitRow, spanTimes } from "./lod";
import { readPalette, type Palette } from "./palette";
import { afterPlayheadBand, clampWindow, dateChanges, frameWindow, isWallTime, panBy, scaleOf, tAt, tickLabel, ticksFor, xAt, zoomAbout, type Scale } from "./scale";
import { openContext, rowSummary } from "../a11y/describe";
import { markTrackOf } from "../tracks/build";
import { ATTEMPT_WORDS, AUTHORITY_WORDS, describeSpan, durationText, durationWords, precisionLine, rowWords } from "./words";
import "./render.css";

/** Where a time reads in the hover card: UTC to the tenth for wall time, elapsed for the simulation. */
function when(t: number): string {
  return tickLabel(t, 100, isWallTime(t));
}

function hitKey(h: TimelineHit | null): string {
  if (!h) return "";
  if (h.span) return `s:${h.span.id}`;
  if (h.mark) return `m:${h.mark.id}`;
  return `a:${h.trackId}#${h.lane}:${h.from}:${h.to}:${h.count}`;
}

/** The row under content y (layout coordinates), by the layout's binary search. */
function rowAt(layout: TrackCanvasProps["layout"], y: number): FlatRow | null {
  const rows = layout.slice(y, y + 0.5);
  for (const r of rows) if (y >= r.y && y < r.y + r.height) return r;
  return null;
}

/** What is under (x, y) in canvas px, from what the last draw placed. */
export function hitAt(out: DrawOutput | null, layout: TrackCanvasProps["layout"], scrollTop: number, x: number, y: number, scale: Scale): { row: FlatRow; hit: TimelineHit } | null {
  if (!out) return null;
  const row = rowAt(layout, y + scrollTop);
  if (!row) return null;
  const top = row.y - scrollTop;
  const g = rowGeom(row, top);
  const base = { trackId: row.node.id, lane: row.lane };
  if (g.ribbonY !== null && y >= g.ribbonY - 2 && y <= g.ribbonY + 5) {
    const rp = out.ribbons.get(row.node.id);
    const h = rp ? hitRow(rp, x) : null;
    if (h?.kind === "span") return { row, hit: { ...base, span: h.span, mark: null, count: 1, from: h.from, to: h.to } };
  }
  const plan = out.plans.get(rowKey(row.node.id, row.lane));
  const h = plan ? hitRow(plan, x) : null;
  if (h?.kind === "span") return { row, hit: { ...base, span: h.span, mark: null, count: 1, from: h.from, to: h.to } };
  if (h?.kind === "mark") return { row, hit: { ...base, span: null, mark: h.mark, count: 1, from: h.mark.at, to: h.mark.until ?? h.mark.at } };
  if (h?.kind === "aggregate") return { row, hit: { ...base, span: null, mark: null, count: h.count, from: h.from, to: h.to } };
  const cols = out.summaries.get(row.node.id);
  if (cols) {
    const i = Math.floor(x / cols.bin);
    const n = cols.counts[i] ?? 0;
    if (n > 0) {
      // The run of covered columns around x, as an aggregate of the collapsed subtree.
      let a = i;
      let b = i;
      while (a > 0 && (cols.counts[a - 1] ?? 0) > 0) a--;
      while (b < cols.counts.length - 1 && (cols.counts[b + 1] ?? 0) > 0) b++;
      return { row, hit: { ...base, span: null, mark: null, count: n, from: tAt(scale, a * cols.bin), to: tAt(scale, (b + 1) * cols.bin) } };
    }
  }
  return null;
}

/** The keys, said once for screen readers (the element's description). */
export const TRACK_KEYS_WORDS =
  "Up and Down move between rows. Left and Right move to the previous or next span on the row. Enter selects the span, or opens or closes a group. Alt+Right or * expands, Alt+Left collapses. Plus and minus zoom in and out; 0 returns to the default window. Shift+Left and Shift+Right pan. Page Up and Page Down move a screen of rows.";

/** The hit the cursor stands for, or null on a row without a span. */
function cursorHit(row: FlatRow, cursor: TimelineCursor | null, liveAt: number): TimelineHit | null {
  if (!cursor?.spanId) return null;
  const span = rowSpans(row, liveAt).find((s) => s.id === cursor.spanId);
  const t = span ? spanTimes(span, liveAt) : null;
  if (!span || !t) return null;
  return { trackId: row.node.id, lane: row.lane, span, mark: null, count: 1, from: t.from, to: t.to };
}

/** A row for the live region: its summary in the window (shared with the table), then open or closed. */
function rowSpoken(row: FlatRow, window: TimeWindow, liveAt: number): string {
  const words = [rowSummary(row.node, window, liveAt)];
  if (row.hasChildren && row.lane === 0) words.push(row.expanded ? "expanded" : "collapsed");
  if (row.lane > 0) words.push(`lane ${row.lane + 1}`);
  return `${words.join(", ")}.`;
}

/** Whether motion should cut: the store's flag or the media query. */
function reducedNow(flag: boolean): boolean {
  return flag || (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches);
}

const FADE_MS = factoryTokens.motion.stateChange;

export const TrackCanvas = memo(function TrackCanvas(props: TrackCanvasProps) {
  const { tree, layout, viewport, marks, height, scrollTop, truncated, cursor } = props;
  const { window: win, width, liveAt } = viewport;
  const { resolved: theme } = useTheme();
  const selection = useSceneStore((s) => s.selection);
  const highlighted = useSceneStore((s) => s.highlighted);
  const reducedMotion = useSceneStore((s) => s.reducedMotion);
  const following = useSceneStore((s) => s.following);
  const keysId = useId();
  const boxRef = useRef<HTMLDivElement>(null);
  const sayRef = useRef<HTMLParagraphElement>(null);
  const spoke = useRef<{ at: number; timer: number | null; text: string }>({ at: 0, timer: null, text: "" });
  const keyboard = useRef(false);
  // New spans fade in: ids seen so far, and when each new one arrived.
  const seen = useRef<Set<string> | null>(null);
  const arrivals = useRef(new Map<string, number>());
  const fadeFrame = useRef<number | null>(null);
  const highlightSet = useMemo(() => new Set<string>(highlighted), [highlighted]);

  const mainRef = useRef<HTMLCanvasElement>(null);
  const overRef = useRef<HTMLCanvasElement>(null);
  const playRef = useRef<HTMLDivElement>(null);
  const liveRef = useRef<HTMLDivElement>(null);
  const liveOffRef = useRef<HTMLDivElement>(null);
  const futureRef = useRef<HTMLDivElement>(null);
  const afterRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const cardTitle = useRef<HTMLParagraphElement>(null);
  const cardDur = useRef<HTMLParagraphElement>(null);
  const cardWhen = useRef<HTMLParagraphElement>(null);
  const cardHow = useRef<HTMLParagraphElement>(null);
  const out = useRef<DrawOutput | null>(null);
  const palette = useRef<Palette | null>(null);
  const hoverKey = useRef("");
  const hovered = useRef<{ row: FlatRow; hit: TimelineHit } | null>(null);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const drag = useRef<{ x: number; y: number; win: TimeWindow; top: number; moved: boolean; id: number } | null>(null);
  /** The last single click on a span or mark, for telling a double-click's second click (X13). */
  const lastClick = useRef<{ id: string; at: number } | null>(null);
  const anim = useRef<number | null>(null);
  // Wheel and drag events can arrive faster than the caller re-renders: build on what was last asked for.
  const pendingWin = useRef<TimeWindow | null>(null);
  const pendingTop = useRef<number | null>(null);
  const latest = useRef(props);

  // Marks by the track that shows their entity (its most specific track).
  const marksByTrack = useMemo(() => {
    const m = new Map<string, TimelineMark[]>();
    for (const mark of marks) {
      if (!mark.entity) continue;
      const id = markTrackOf(tree, mark.entity);
      if (!id) continue;
      const list = m.get(id);
      if (list) list.push(mark);
      else m.set(id, [mark]);
    }
    for (const list of m.values()) list.sort((a, b) => a.at - b.at);
    return m;
  }, [marks, tree]);

  useLayoutEffect(() => {
    latest.current = props;
    pendingWin.current = null;
    pendingTop.current = null;
  });

  // Spans new to the tree: fade in only while following the live edge, never under reduced motion.
  useLayoutEffect(() => {
    const ids = new Set(tree.ofSpan.keys());
    const before = seen.current;
    seen.current = ids;
    if (!before || !following || reducedNow(reducedMotionRef.current)) {
      arrivals.current.clear();
      return;
    }
    const now = performance.now();
    for (const id of ids) if (!before.has(id)) arrivals.current.set(id, now);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tree]);

  /** The opacity of each span still fading in; schedules the next frame while any is. */
  function freshAlphas(): Map<string, number> | undefined {
    if (!arrivals.current.size) return undefined;
    const now = performance.now();
    const out = new Map<string, number>();
    for (const [id, t] of arrivals.current) {
      const k = (now - t) / FADE_MS;
      if (k >= 1) arrivals.current.delete(id);
      else out.set(id, Math.max(0.02, k));
    }
    if (out.size && fadeFrame.current === null) {
      fadeFrame.current = requestAnimationFrame(() => {
        fadeFrame.current = null;
        drawMain();
      });
    }
    return out.size ? out : undefined;
  }

  const frame = useRef<{ marksByTrack: typeof marksByTrack; selection: typeof selection; highlightSet: typeof highlightSet }>({ marksByTrack, selection, highlightSet });
  useLayoutEffect(() => {
    frame.current = { marksByTrack, selection, highlightSet };
  });

  /** The frame, from the latest props. */
  function drawMain() {
    const P = latest.current;
    const { width, height, scrollTop, layout, viewport } = { width: P.viewport.width, height: P.height, scrollTop: P.scrollTop, layout: P.layout, viewport: P.viewport };
    const win = viewport.window;
    const liveAt = viewport.liveAt;
    const { marksByTrack, selection, highlightSet } = frame.current;
    const canvas = mainRef.current;
    const over = overRef.current;
    if (!canvas || !over || width <= 0 || height <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    const p = readPalette(canvas);
    palette.current = p;
    for (const c of [canvas, over]) {
      const w = Math.round(width * dpr);
      const h = Math.round(height * dpr);
      if (c.width !== w) c.width = w;
      if (c.height !== h) c.height = h;
      c.style.width = `${width}px`;
      c.style.height = `${height}px`;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const ticks = ticksFor(win, width);
    out.current = drawTracks({
      ctx,
      width,
      height,
      scrollTop,
      rows: layout.slice(scrollTop, scrollTop + height),
      window: win,
      liveAt,
      palette: p,
      marks: marksByTrack,
      selection,
      highlighted: highlightSet,
      grid: ticks.majors,
      dateLines: dateChanges(win),
      fresh: freshAlphas(),
    });
    // The hover outline belongs to the old frame: redraw it on the new one.
    drawOverlay();
  }

  // The frame: redrawn only when what is drawn changes.
  useLayoutEffect(() => {
    latest.current = props;
    drawMain();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tree, layout, win.from, win.to, width, liveAt, height, scrollTop, marksByTrack, selection, highlightSet, theme]);
  useEffect(
    () => () => {
      if (fadeFrame.current !== null) cancelAnimationFrame(fadeFrame.current);
    },
    [],
  );

  /** The overlay: the pointer's time hairline and the hover outline. Cheap; written on every pointer move. */
  function drawOverlay() {
    const over = overRef.current;
    const p = palette.current;
    if (!over || !p) return;
    const ctx = over.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const P = latest.current;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, P.viewport.width, P.height);
    drawCursor(ctx, P, p);
    const pt = pointer.current;
    if (!pt || drag.current?.moved) return;
    const xLive = xAt(scaleOf(P.viewport.window, P.viewport.width), P.viewport.liveAt);
    if (pt.x <= xLive) {
      ctx.fillStyle = p.inkSubtle;
      ctx.globalAlpha = 0.35;
      ctx.fillRect(Math.round(pt.x), 0, 1, P.height);
      ctx.globalAlpha = 1;
    }
    const h = hovered.current;
    if (!h) return;
    const [x0, y0, x1, y1] = hitBox(h.row, h.row.y - P.scrollTop, h.hit.from, h.hit.to, h.hit.span?.kind ?? null, P.viewport.window, P.viewport.width);
    ctx.strokeStyle = p.ink;
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(x0) - 0.5, Math.round(y0) - 0.5, Math.round(x1 - x0) + 1, Math.round(y1 - y0) + 1);
    ctx.globalAlpha = 1;
  }

  /** Whether the cursor is shown: the tracks hold the keyboard's focus. */
  function cursorShown(): boolean {
    const el = boxRef.current;
    return Boolean(el && document.activeElement === el && keyboard.current);
  }

  /** The cursor's box in canvas px: its span's, or its whole row's. */
  function cursorBox(P: TrackCanvasProps): { row: FlatRow; hit: TimelineHit | null; box: readonly [number, number, number, number] } | null {
    const row = cursorRow(P);
    if (!row) return null;
    const hit = cursorHit(row, P.cursor, P.viewport.liveAt);
    const y = row.y - P.scrollTop;
    if (hit) {
      const [x0, y0, x1, y1] = hitBox(row, y, hit.from, hit.to, hit.span?.kind ?? null, P.viewport.window, P.viewport.width);
      // Rows with their labels above the body: the bracket holds the label too.
      const top = rowGeom(row, y).labelTop ? Math.min(y0, y + 2) : y0;
      return { row, hit, box: [Math.max(3, x0), top, Math.min(P.viewport.width - 3, x1), y1] };
    }
    return { row, hit: null, box: [1, y + 1, P.viewport.width - 1, y + row.height - 1] };
  }

  /** The focus bracket: a full outline in the focus ink (the selection keeps its corner brackets). */
  function drawCursor(ctx: CanvasRenderingContext2D, P: TrackCanvasProps, p: Palette) {
    if (!cursorShown()) return;
    const c = cursorBox(P);
    if (!c) return;
    const [x0, y0, x1, y1] = c.box;
    ctx.strokeStyle = p.focus;
    ctx.lineWidth = 2;
    if (c.hit) {
      const a = Math.max(1, Math.round(x0) - 3);
      const b = Math.min(P.viewport.width - 1, Math.round(x1) + 3);
      ctx.strokeRect(a, Math.round(y0) - 2, b - a, Math.round(y1 - y0) + 4);
    } else {
      // A row: a bar at its left edge and a quiet outline of the row.
      ctx.fillStyle = p.focus;
      ctx.fillRect(0, y0, 3, y1 - y0);
      ctx.globalAlpha = 0.5;
      ctx.lineWidth = 1;
      ctx.strokeRect(x0 + 0.5, y0 + 0.5, x1 - x0 - 1, y1 - y0 - 1);
      ctx.globalAlpha = 1;
    }
  }

  /** The hover card: written to the DOM directly. */
  function showCard(h: { row: FlatRow; hit: TimelineHit | null } | null, x: number, y: number) {
    const card = cardRef.current;
    if (!card) return;
    if (!h) {
      card.style.visibility = "hidden";
      return;
    }
    const P = latest.current;
    const at = P.viewport.liveAt;
    const { hit } = h;
    let title: string;
    let dur: string;
    let how: string;
    if (!hit) {
      // The keyboard cursor on a row: what the row holds, as the label column says it.
      const r = rowWords(h.row, P.viewport.liveAt);
      title = r.title;
      dur = r.detail;
      how = h.row.node.note ?? "";
      if (cardWhen.current) cardWhen.current.textContent = "";
    } else if (hit.span) {
      const context = openContext(P.tree, hit.span, at);
      title = describeSpan(hit.span, at, context);
      dur = durationWords(hit.span, at, context);
      dur = dur[0] ? dur[0].toUpperCase() + dur.slice(1) : dur;
      how = `${AUTHORITY_WORDS[hit.span.authority]}. ${precisionLine(hit.span, at)}`;
      if (hit.span.kind === "execution" && hit.span.attrs.attempt !== undefined) how = `${ATTEMPT_WORDS} ${how}`;
      // A ribbon is the other hierarchy's span, linked here: said so, apart from the row's own spans.
      if (P.tree.ofSpan.get(hit.span.id)?.trackId !== h.row.node.id && h.row.node.ribbons.includes(hit.span)) {
        if (hit.span.kind === "visit") {
          title = `Station visit made during this execution${outlivesExecution(h.row.node, hit.span, at) ? "; continued under a later execution" : ""}. ${title}`;
        } else title = `Linked: ${title}`;
      }
      const t = spanTimes(hit.span, at);
      if (cardWhen.current) {
        cardWhen.current.textContent = !t
          ? "Times not known"
          : t.startUnknown
            ? `start not known – ${when(t.to)}`
            : t.endUnknown
              ? `${when(t.from)} – end not known`
              : t.open
                ? `${when(t.from)} – now (${when(at)})`
                : `${when(t.from)} – ${when(t.to)}`;
      }
    } else if (hit.mark) {
      title = hit.mark.label;
      dur = hit.mark.verdict ? `Verdict: ${hit.mark.verdict}` : `${hit.mark.kind[0]?.toUpperCase() ?? ""}${hit.mark.kind.slice(1)}`;
      how = AUTHORITY_WORDS[hit.mark.authority];
      if (cardWhen.current) cardWhen.current.textContent = hit.mark.until ? `${when(hit.mark.at)} – ${when(hit.mark.until)}` : when(hit.mark.at);
    } else {
      const summary = Boolean(out.current?.summaries.has(hit.trackId)) && !out.current?.plans.get(rowKey(hit.trackId, hit.lane))?.runs.length;
      title = summary ? `${hit.count} span${hit.count === 1 ? "" : "s"} below this group at this time` : `${hit.count} span${hit.count === 1 ? "" : "s"} too small to draw one by one at this zoom`;
      dur = summary ? "Open the group to see them" : "Zoom in to see each one";
      how = "";
      const { from, to } = hit;
      if (cardWhen.current) cardWhen.current.textContent = `${when(from)} – ${when(to)}, ${durationText(to - from)}`;
    }
    if (cardWhen.current && hit && isWallTime(hit.from) && !cardWhen.current.textContent?.endsWith("UTC")) cardWhen.current.textContent += " UTC";
    if (cardWhen.current) cardWhen.current.style.display = cardWhen.current.textContent ? "" : "none";
    if (cardTitle.current) cardTitle.current.textContent = title;
    if (cardDur.current) cardDur.current.textContent = dur;
    if (cardHow.current) {
      cardHow.current.textContent = how;
      cardHow.current.style.display = how ? "" : "none";
    }
    card.style.visibility = "visible";
    const cw = card.offsetWidth;
    const ch = card.offsetHeight;
    const left = x + 16 + cw > P.viewport.width ? Math.max(4, x - 16 - cw) : x + 16;
    const top = y + 16 + ch > P.height ? Math.max(4, y - 12 - ch) : y + 16;
    card.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }

  function point(e: { clientX: number; clientY: number }) {
    const c = mainRef.current;
    if (!c) return null;
    const r = c.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function currentWin(): TimeWindow {
    return pendingWin.current ?? latest.current.viewport.window;
  }
  function currentTop(): number {
    return pendingTop.current ?? latest.current.scrollTop;
  }
  function setWin(next: TimeWindow) {
    const w = clampWindow(next);
    pendingWin.current = w;
    latest.current.onWindow(w);
  }
  function setTop(top: number) {
    const P = latest.current;
    const max = Math.max(0, P.layout.totalHeight - P.height);
    const t = Math.max(0, Math.min(max, top));
    if (t === currentTop()) return;
    pendingTop.current = t;
    P.onScroll(t);
  }
  function stopAnim() {
    if (anim.current !== null) cancelAnimationFrame(anim.current);
    anim.current = null;
  }
  /** Frame a window: eased over 260 ms, or cut with reduced motion. */
  function goTo(target: TimeWindow) {
    stopAnim();
    const reduce = (reducedMotionRef.current || (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches));
    if (reduce) {
      setWin(target);
      return;
    }
    const from = currentWin();
    const t0 = performance.now();
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / 260);
      const e = 1 - Math.pow(1 - k, 3);
      setWin({ from: from.from + (target.from - from.from) * e, to: from.to + (target.to - from.to) * e });
      anim.current = k < 1 ? requestAnimationFrame(step) : null;
    };
    anim.current = requestAnimationFrame(step);
  }
  const reducedMotionRef = useRef(reducedMotion);
  useEffect(() => {
    reducedMotionRef.current = reducedMotion;
  }, [reducedMotion]);
  useEffect(() => () => stopAnim(), []);

  function hover(e: { clientX: number; clientY: number }) {
    const pt = point(e);
    if (!pt) return;
    pointer.current = pt;
    const P = latest.current;
    const xLive = xAt(scaleOf(P.viewport.window, P.viewport.width), P.viewport.liveAt);
    // Nothing is known past the live edge: no hover there.
    const found = pt.x <= xLive + 4 ? hitAt(out.current, P.layout, P.scrollTop, pt.x, pt.y, scaleOf(P.viewport.window, P.viewport.width)) : null;
    hovered.current = found;
    const key = hitKey(found?.hit ?? null);
    if (key !== hoverKey.current) {
      hoverKey.current = key;
      P.onHover(found?.hit ?? null);
    }
    const row = found ? null : rowAt(P.layout, pt.y + P.scrollTop);
    const ch = row ? out.current?.chevrons.get(rowKey(row.node.id, row.lane)) : undefined;
    const onChevron = Boolean(ch && Math.abs(pt.x - ch.x) <= 10);
    if (mainRef.current) mainRef.current.style.cursor = found?.hit.span || found?.hit.mark || onChevron ? "pointer" : "grab";
    showCard(found, pt.x, pt.y);
    drawOverlay();
  }

  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    keyboard.current = false;
    stopAnim();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, win: currentWin(), top: currentTop(), moved: false, id: e.pointerId };
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    if (d) {
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      if (!d.moved && Math.abs(dx) + Math.abs(dy) > 3) {
        d.moved = true;
        showCard(null, 0, 0);
        if (mainRef.current) mainRef.current.style.cursor = "grabbing";
      }
      if (d.moved) {
        const k = scaleOf(d.win, latest.current.viewport.width).k;
        setWin(panBy(d.win, -dx / k));
        setTop(d.top - dy);
        drawOverlay();
      }
      return;
    }
    hover(e);
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.moved) {
      hover(e);
      return;
    }
    const pt = point(e);
    if (!pt) return;
    const P = latest.current;
    const found = hitAt(out.current, P.layout, P.scrollTop, pt.x, pt.y, scaleOf(P.viewport.window, P.viewport.width));
    if (found) {
      P.onCursor({ trackId: found.row.node.id, lane: found.row.lane, spanId: found.hit.span?.id ?? null });
      // A pointerup carries no click count: the second click of a double-click is one on the same thing
      // within the double-click interval (X13). A later single click only selects.
      const id = found.hit.span?.id ?? found.hit.mark?.id ?? "";
      const t = e.timeStamp;
      const dbl = e.detail >= 2 || (lastClick.current !== null && lastClick.current.id === id && t - lastClick.current.at < DOUBLE_CLICK_MS);
      lastClick.current = dbl ? null : { id, at: t };
      P.onSelect(found.hit, dbl ? "double-click" : "click");
      return;
    }
    // An empty row's edge chevron: pan to the nearest span it points at.
    const row = rowAt(P.layout, pt.y + P.scrollTop);
    const ch = row ? out.current?.chevrons.get(rowKey(row.node.id, row.lane)) : undefined;
    if (row && ch && Math.abs(pt.x - ch.x) <= 10) {
      setWin(panToShow(currentWin(), ch.from, ch.to));
      P.onCursor({ trackId: row.node.id, lane: row.lane, spanId: ch.spanId });
    }
  };
  const onDoubleClick = (e: ReactMouseEvent<HTMLCanvasElement>) => {
    const pt = point(e);
    if (!pt) return;
    const P = latest.current;
    const found = hitAt(out.current, P.layout, P.scrollTop, pt.x, pt.y, scaleOf(P.viewport.window, P.viewport.width));
    if (found?.hit.span || (found && found.hit.count > 1 && !found.hit.mark)) {
      goTo(frameWindow(found.hit.from, found.hit.to));
      return;
    }
    const row = rowAt(P.layout, pt.y + P.scrollTop);
    if (row && row.hasChildren && !found) P.onToggle(row.node.id);
  };
  const onPointerLeave = () => {
    if (drag.current) return;
    pointer.current = null;
    hovered.current = null;
    if (hoverKey.current) {
      hoverKey.current = "";
      latest.current.onHover(null);
    }
    showCard(null, 0, 0);
    drawOverlay();
  };

  /** Say what the cursor is on, politely, at most once a second (the latest wins). */
  function say(text: string) {
    const s = spoke.current;
    s.text = text;
    const write = () => {
      s.timer = null;
      s.at = performance.now();
      if (sayRef.current) sayRef.current.textContent = s.text;
    };
    const wait = 1000 - (performance.now() - s.at);
    if (wait <= 0 && s.timer === null) write();
    else if (s.timer === null) s.timer = window.setTimeout(write, Math.max(0, wait));
  }
  useEffect(
    () => () => {
      if (spoke.current.timer !== null) window.clearTimeout(spoke.current.timer);
    },
    [],
  );

  /** After the cursor moves: the bracket, the card beside it, and the words. */
  function showCursor() {
    drawOverlay();
    if (!cursorShown() || pointer.current) return;
    const P = latest.current;
    const c = cursorBox(P);
    if (!c) {
      showCard(null, 0, 0);
      return;
    }
    const [x0, , x1, y1] = c.box;
    showCard({ row: c.row, hit: c.hit }, c.hit ? Math.max(0, Math.min(P.viewport.width - 8, (Math.max(0, x0) + Math.min(P.viewport.width, x1)) / 2)) : 24, y1 - 8);
    // A row: the same summary of it in the window as the table gives, and whether it is open.
    say(c.hit?.span ? describeSpan(c.hit.span, P.viewport.liveAt, openContext(P.tree, c.hit.span, P.viewport.liveAt)) : rowSpoken(c.row, P.viewport.window, P.viewport.liveAt));
  }
  useLayoutEffect(() => {
    showCursor();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursor?.trackId, cursor?.lane, cursor?.spanId, layout, win.from, win.to, scrollTop]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const P = latest.current;
    const result = keyAction(e, { tree: P.tree, layout: P.layout, cursor: P.cursor, window: currentWin(), liveAt: P.viewport.liveAt, scrollTop: currentTop(), height: P.height, defaultWindow: P.defaultWindow });
    if (!result.handled) return;
    e.preventDefault();
    e.stopPropagation();
    keyboard.current = true;
    stopAnim();
    // Keys cut: the window and the rows move at once, never eased.
    if (result.window) setWin(result.window);
    if (result.scrollTop !== undefined) setTop(result.scrollTop);
    if (result.cursor) P.onCursor(result.cursor);
    if (result.toggle) P.onToggle(result.toggle);
    if (result.select) {
      const row = cursorRow({ tree: P.tree, layout: P.layout, cursor: result.cursor ?? P.cursor });
      const hit = row ? cursorHit(row, result.cursor ?? P.cursor, P.viewport.liveAt) : null;
      if (hit) P.onSelect(hit, "key");
    }
    showCursor();
  };
  const onFocus = () => {
    const el = boxRef.current;
    keyboard.current = Boolean(el?.matches(":focus-visible"));
    const P = latest.current;
    // The first time in: the cursor starts on the first row in view.
    if (!P.cursor && keyboard.current) {
      const first = P.layout.slice(P.scrollTop, P.scrollTop + 1)[0] ?? P.layout.rows[0];
      if (first) P.onCursor({ trackId: first.node.id, lane: first.lane, spanId: null });
    }
    showCursor();
  };
  const onBlur = () => {
    keyboard.current = false;
    drawOverlay();
    if (!pointer.current) showCard(null, 0, 0);
  };

  // The wheel must be cancellable (Ctrl+wheel would zoom the page): React's listener is passive.
  useEffect(() => {
    const el = mainRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      stopAnim();
      const P = latest.current;
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? P.height : 1;
      const dx = e.deltaX * unit;
      const dy = e.deltaY * unit;
      const pt = point(e);
      const win0 = currentWin();
      const scale = scaleOf(win0, P.viewport.width);
      if (e.ctrlKey || e.metaKey) {
        const anchor = tAt(scale, pt ? pt.x : P.viewport.width / 2);
        setWin(zoomAbout(win0, Math.exp(dy * 0.0022), anchor));
      } else if (e.shiftKey || Math.abs(dx) > Math.abs(dy)) {
        const d = Math.abs(dx) > Math.abs(dy) ? dx : dy;
        setWin(panBy(win0, d / scale.k));
      } else setTop(currentTop() + dy);
      showCard(null, 0, 0);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The playhead and the live edge: direct DOM writes on every store tick, no render.
  usePlayheadEffect(
    (s) => {
      const scale = scaleOf(win, width);
      const x = xAt(scale, s.playhead);
      const live = Math.max(0, Math.min(width, xAt(scale, Math.max(s.liveAt, liveAt))));
      if (playRef.current) {
        playRef.current.style.transform = `translateX(${Math.round(x)}px)`;
        playRef.current.style.visibility = x < -1 || x > width + 1 ? "hidden" : "visible";
      }
      if (liveRef.current) {
        liveRef.current.style.transform = `translateX(${Math.round(live)}px)`;
        liveRef.current.style.visibility = live >= width ? "hidden" : "visible";
      }
      // The live edge past the window's right end (a pinned window it has left, L1): said at that edge.
      if (liveOffRef.current) liveOffRef.current.style.visibility = xAt(scale, Math.max(s.liveAt, liveAt)) > width + 1 ? "visible" : "hidden";
      if (futureRef.current) {
        futureRef.current.style.left = `${Math.round(live) + 1}px`;
        futureRef.current.style.visibility = live >= width ? "hidden" : "visible";
      }
      // Scrubbed back (T6): the tracks speak as of the live edge, so the stretch after the playhead is
      // tinted, and labelled once, while the inspector speaks as of the playhead.
      const after = afterRef.current;
      if (after) {
        const behind = asOfPlayhead({ following: s.following, playhead: s.playhead, liveAt: Math.max(s.liveAt, liveAt) }).behind;
        const band = afterPlayheadBand(behind, x, live, width);
        const label = after.firstElementChild as HTMLElement | null;
        // The label inherits the band's visibility when shown (""), never "visible" of its own: that
        // would keep it on screen once the band is hidden.
        if (label) label.style.visibility = band?.label ? "" : "hidden";
        if (!band) after.style.visibility = "hidden";
        else {
          after.style.visibility = "visible";
          after.style.transform = `translateX(${Math.round(band.left)}px)`;
          after.style.width = `${Math.round(band.width)}px`;
        }
      }
    },
    [win.from, win.to, width, liveAt, following],
  );

  return (
    // A canvas widget (WAI-ARIA application): the keys are its own and described for screen readers.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <div
      ref={boxRef}
      role="application"
      aria-label="Tracks"
      aria-roledescription="timeline tracks"
      aria-describedby={keysId}
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={0}
      onKeyDown={onKeyDown}
      onFocus={onFocus}
      onBlur={onBlur}
      className="mach-tl-tracks relative overflow-hidden outline-none"
      style={{ width, height, background: "var(--mach-factory-ground)" }}
    >
      <p id={keysId} className="sr-only">
        {TRACK_KEYS_WORDS}
      </p>
      <p ref={sayRef} className="sr-only" aria-live="polite" aria-atomic="true" />
      <canvas
        ref={mainRef}
        aria-hidden="true"
        className="absolute inset-0 block touch-none select-none"
        style={{ cursor: "grab" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          drag.current = null;
        }}
        onPointerLeave={onPointerLeave}
        onDoubleClick={onDoubleClick}
      />
      <canvas ref={overRef} aria-hidden="true" className="pointer-events-none absolute inset-0 block" />
      <div aria-hidden="true" className="pointer-events-none absolute inset-0">
        <div ref={futureRef} className="mach-tl-future absolute inset-y-0 right-0" style={{ left: width, opacity: 0.9 }} />
        <div ref={afterRef} data-after-playhead="" className="mach-tl-after absolute inset-y-0 left-0" style={{ visibility: "hidden", width: 0 }}>
          <span className="absolute left-1.5 top-1 whitespace-nowrap rounded-xs px-1 text-[10.5px] text-ink-muted" style={{ background: "var(--mach-factory-ground)" }}>
            After the playhead
          </span>
        </div>
        <div ref={liveRef} className="absolute inset-y-0 left-0 w-0">
          <div className="absolute inset-y-0 left-0 border-l border-dashed" style={{ borderColor: "var(--mach-factory-plate-edge)" }} />
        </div>
        <div ref={liveOffRef} data-live-off-window="" className="absolute inset-y-0 right-0 flex items-start border-r-2 border-dashed" style={{ visibility: "hidden", borderColor: "var(--mach-factory-plate-edge)" }}>
          <span className="mr-1 mt-1 whitespace-nowrap rounded-xs px-1 text-[10.5px] text-ink-muted" style={{ background: "var(--mach-factory-ground)" }}>
            Live edge later →
          </span>
        </div>
        <div ref={playRef} className="absolute inset-y-0 left-0 w-0">
          <div className="absolute inset-y-0 -left-px w-0.5 bg-ink" />
        </div>
      </div>
      {truncated ? (
        <p className="pointer-events-none absolute right-2 top-1.5 rounded-xs border border-warning-line bg-warning-soft px-2 py-0.5 text-[11px] text-warning-ink">
          Not every span in this window is shown. Zoom in to see the rest.
        </p>
      ) : null}
      <div
        ref={cardRef}
        role="presentation"
        className="mach-tl-card pointer-events-none absolute left-0 top-0 z-10 w-max max-w-80 rounded-sm border border-line bg-surface-raised px-2.5 py-2 shadow-2"
        style={{ visibility: "hidden" }}
      >
        <p ref={cardTitle} className="text-caption font-semibold leading-snug text-ink" />
        <p ref={cardDur} className="mt-0.5 text-caption text-ink-muted" />
        <p ref={cardWhen} className="mt-1 font-mono text-[11px] text-ink-subtle tabular" />
        <p ref={cardHow} className="mt-1 border-t border-line pt-1 text-[11px] leading-snug text-ink-subtle" />
      </div>
    </div>
  );
});
