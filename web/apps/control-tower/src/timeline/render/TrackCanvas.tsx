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
 */
import { memo, useEffect, useLayoutEffect, useMemo, useRef, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { useTheme } from "@mach/ui";
import { useSceneStore } from "../../scene";
import { usePlayheadEffect } from "../../shell/timeline/playhead";
import { type FlatRow, type TimelineHit, type TimelineMark, type TimeWindow, type TrackCanvasProps } from "../contract";
import { drawTracks, hitBox, rowGeom, rowKey, type DrawOutput } from "./draw";
import { hitRow, spanTimes } from "./lod";
import { readPalette, type Palette } from "./palette";
import { clampWindow, dateChanges, frameWindow, isWallTime, panBy, scaleOf, tAt, tickLabel, ticksFor, xAt, zoomAbout, type Scale } from "./scale";
import { AUTHORITY_WORDS, describeSpan, durationText, durationWords, precisionLine } from "./words";
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

export const TrackCanvas = memo(function TrackCanvas(props: TrackCanvasProps) {
  const { tree, layout, viewport, marks, height, scrollTop, truncated } = props;
  const { window: win, width, liveAt } = viewport;
  const { resolved: theme } = useTheme();
  const selection = useSceneStore((s) => s.selection);
  const highlighted = useSceneStore((s) => s.highlighted);
  const reducedMotion = useSceneStore((s) => s.reducedMotion);
  const highlightSet = useMemo(() => new Set<string>(highlighted), [highlighted]);

  const mainRef = useRef<HTMLCanvasElement>(null);
  const overRef = useRef<HTMLCanvasElement>(null);
  const playRef = useRef<HTMLDivElement>(null);
  const liveRef = useRef<HTMLDivElement>(null);
  const futureRef = useRef<HTMLDivElement>(null);
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
      const id = tree.tracksOf(mark.entity)[0];
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

  // The frame: redrawn only when what is drawn changes.
  useLayoutEffect(() => {
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
    });
    // The hover outline belongs to the old frame: redraw it on the new one.
    drawOverlay();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tree, layout, win.from, win.to, width, liveAt, height, scrollTop, marksByTrack, selection, highlightSet, theme]);

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

  /** The hover card: written to the DOM directly. */
  function showCard(h: { row: FlatRow; hit: TimelineHit } | null, x: number, y: number) {
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
    if (hit.span) {
      title = describeSpan(hit.span, at);
      dur = durationWords(hit.span, at);
      dur = dur[0] ? dur[0].toUpperCase() + dur.slice(1) : dur;
      how = `${AUTHORITY_WORDS[hit.span.authority]}. ${precisionLine(hit.span, at)}`;
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
    if (cardWhen.current && isWallTime(hit.from) && !cardWhen.current.textContent?.endsWith("UTC")) cardWhen.current.textContent += " UTC";
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
    if (mainRef.current) mainRef.current.style.cursor = found?.hit.span || found?.hit.mark ? "pointer" : "grab";
    showCard(found, pt.x, pt.y);
    drawOverlay();
  }

  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
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
    if (found) P.onSelect(found.hit);
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
      if (futureRef.current) {
        futureRef.current.style.left = `${Math.round(live) + 1}px`;
        futureRef.current.style.visibility = live >= width ? "hidden" : "visible";
      }
    },
    [win.from, win.to, width, liveAt],
  );

  return (
    <div className="relative overflow-hidden" style={{ width, height, background: "var(--mach-factory-ground)" }}>
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
        <div ref={liveRef} className="absolute inset-y-0 left-0 w-0">
          <div className="absolute inset-y-0 left-0 border-l border-dashed" style={{ borderColor: "var(--mach-factory-plate-edge)" }} />
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
