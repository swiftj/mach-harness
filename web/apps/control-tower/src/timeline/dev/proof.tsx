/**
 * Development only, never built: the tracks (labels, ruler, canvas) on a hand-built fixture that
 * covers every span family and timing basis, at /src/timeline/dev/proof.html on the dev server.
 * No production code path knows about it (vite builds index.html alone).
 *
 *   ?zoom=wide|mid|close   the window (default wide)
 *   ?theme=light|dark      pins the theme
 *   ?top=<px>              initial vertical scroll
 *   ?sel=none              no selection (default: the resumed build visit, linked to its ribbon)
 *   ?bench=1               draws 5,000 visible spans 60 times and prints the frame time
 *   ?cursor=<track>~<span> the keyboard cursor's start (focus the tracks to see it)
 *
 * window.__proof: { bench(), setWindow(w), setCursor(c), store } for a Playwright script.
 */
import { StrictMode, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider, TooltipProvider, type ThemePreference } from "@mach/ui";
import "../../index.css";
import { browserClock, createSceneStore, SceneStoreProvider } from "../../scene";
import { createSceneLog, provenance, type EntityRef } from "../../sim";
import { LABEL_GUTTER, RULER_HEIGHT, type TimelineCursor, type TimeWindow, type TimelineHit, type TrackNode } from "../contract";
import { TrackCanvas, TrackLabels, WindowRuler } from "../render";
import { drawTracks } from "../render/draw";
import { readPalette } from "../render/palette";
import { dateChanges, ticksFor } from "../render/scale";
import { describeSpan } from "../render/words";
import { benchTree, layoutOf, LIVE_AT, PLAYHEAD, proofFixture, T0 } from "./fixture";

const params = new URLSearchParams(window.location.search);
const theme = params.get("theme");
const M = 60_000;
const ZOOMS: Record<string, TimeWindow> = {
  wide: { from: T0 - 1 * M, to: LIVE_AT + 4 * M },
  mid: { from: T0 + 43 * M, to: T0 + 63 * M },
  close: { from: T0 + 53 * M + 58_000, to: T0 + 54 * M + 52_000 },
};
const zoomName = params.get("zoom") && ZOOMS[params.get("zoom")!] ? params.get("zoom")! : "wide";

const log = createSceneLog({ definitions: { project: { id: "proof", name: "Tracks proof", integrationBranch: "main" }, waves: {}, slices: {} }, provenance: provenance("live", "hand-built fixture") });
// The history starts at T0: a window stub, so the playhead may be sought into the past (the log itself is empty).
const whole = { log, from: T0, to: Number.POSITIVE_INFINITY };
const store = createSceneStore({ source: "live", log, clock: browserClock(), windows: { start: () => T0, peek: () => whole, load: async () => whole } });
store.setLiveEdge(LIVE_AT);
store.seek(PLAYHEAD);
const fx = proofFixture();
if (params.get("sel") !== "none") store.select((params.get("sel") as EntityRef | null) ?? fx.selection, { focus: false });

interface BenchResult {
  dpr: number;
  commandsMedianMs: number;
  spans: number;
  drawn: number;
  frames: number;
  medianMs: number;
  p95Ms: number;
}

/** Draws 60 rows of 90 spans (5,400 visible, each at least 2 px wide) 60 times into a canvas the size of a large screen. */
function bench(): BenchResult {
  const width = 1300;
  const rows = 60;
  const perRow = 90;
  const from = T0;
  const to = T0 + 60 * M;
  const tree = benchTree(rows, perRow, from, to);
  const layout = layoutOf(tree, new Set());
  const height = layout.totalHeight;
  const dpr = window.devicePixelRatio || 1;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  document.body.appendChild(canvas);
  canvas.style.cssText = "position:fixed;left:-99999px;top:0";
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const palette = readPalette(document.documentElement);
  const win = { from, to };
  const ticks = ticksFor(win, width);
  const times: number[] = [];
  const script: number[] = [];
  let drawn = 0;
  for (let i = 0; i < 64; i++) {
    // Vary the window a little each frame (a pan), so nothing is served from a per-window cache.
    const w = { from: win.from + i * 1000, to: win.to + i * 1000 };
    const t0 = performance.now();
    const out = drawTracks({ ctx, width, height, scrollTop: 0, rows: layout.slice(0, height), window: w, liveAt: to + 120 * M, palette, marks: new Map(), selection: null, highlighted: new Set(), grid: ticks.majors, dateLines: dateChanges(w) });
    const t1 = performance.now();
    // Force the canvas to finish its work (and read a pixel back) before the clock stops: an upper bound, a
    // real frame never reads back.
    ctx.getImageData(0, 0, 1, 1);
    const dt = performance.now() - t0;
    if (i >= 4) {
      times.push(dt);
      script.push(t1 - t0);
    }
    drawn = out.drawn;
  }
  canvas.remove();
  times.sort((a, b) => a - b);
  script.sort((a, b) => a - b);
  const result = { spans: rows * perRow, drawn, frames: times.length, dpr, medianMs: +times[Math.floor(times.length / 2)]!.toFixed(2), p95Ms: +times[Math.floor(times.length * 0.95)]!.toFixed(2), commandsMedianMs: +script[Math.floor(script.length / 2)]!.toFixed(2) };
  console.log("[proof bench]", JSON.stringify(result));
  return result;
}

/**
 * The same 5,400 spans drawn once per animation frame into an on-screen canvas for 120 frames (a
 * pan): the main thread's drawing time per frame, and the frame interval the browser achieved (the
 * GPU's rasterisation included, without forcing a read-back).
 */
async function benchFrames(): Promise<{ commandsMedianMs: number; commandsP95Ms: number; frameMedianMs: number; frameP95Ms: number }> {
  const width = 1300;
  const from = T0;
  const to = T0 + 60 * M;
  const tree = benchTree(60, 90, from, to);
  const layout = layoutOf(tree, new Set());
  const height = layout.totalHeight;
  const dpr = window.devicePixelRatio || 1;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  canvas.style.cssText = `position:fixed;left:0;top:0;width:${width}px;height:${height}px;z-index:50`;
  document.body.appendChild(canvas);
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const palette = readPalette(document.documentElement);
  const ticks = ticksFor({ from, to }, width);
  const commands: number[] = [];
  const intervals: number[] = [];
  let last = 0;
  await new Promise<void>((done) => {
    let i = 0;
    const frame = (now: number) => {
      if (last) intervals.push(now - last);
      last = now;
      const w = { from: from + i * 1000, to: to + i * 1000 };
      const t0 = performance.now();
      drawTracks({ ctx, width, height, scrollTop: 0, rows: layout.slice(0, height), window: w, liveAt: to + 120 * M, palette, marks: new Map(), selection: null, highlighted: new Set(), grid: ticks.majors, dateLines: dateChanges(w) });
      commands.push(performance.now() - t0);
      if (++i < 120) requestAnimationFrame(frame);
      else done();
    };
    requestAnimationFrame(frame);
  });
  canvas.remove();
  const q = (xs: number[], f: number) => +[...xs].sort((a, b) => a - b)[Math.floor(xs.length * f)]!.toFixed(2);
  const r = { commandsMedianMs: q(commands, 0.5), commandsP95Ms: q(commands, 0.95), frameMedianMs: q(intervals, 0.5), frameP95Ms: q(intervals, 0.95) };
  console.log("[proof frames]", JSON.stringify(r));
  return r;
}

function Proof() {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(fx.expanded));
  const layout = useMemo(() => layoutOf(fx.tree, expanded), [expanded]);
  const [win, setWin] = useState<TimeWindow>(ZOOMS[zoomName]!);
  const [top, setTop] = useState(Number(params.get("top") ?? 0));
  const [gutter, setGutter] = useState(LABEL_GUTTER);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [cursor, setCursor] = useState<TimelineCursor | null>(() => {
    const c = params.get("cursor");
    if (!c) return null;
    const [trackId, spanId] = c.split("~");
    return trackId ? { trackId, lane: 0, spanId: spanId || null } : null;
  });
  const [benchOut, setBenchOut] = useState<BenchResult | null>(null);
  const [said, setSaid] = useState("Hover a span: the card says what it is, how long, and how that is known.");
  const body = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = body.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  useLayoutEffect(() => {
    Object.defineProperty(window, "__proof", {
      value: { bench: () => { const r = bench(); setBenchOut(r); return r; }, benchFrames, setWindow: setWin, setCursor, store, layout },
      configurable: true,
    });
  }, [layout]);
  useLayoutEffect(() => {
    if (params.get("bench") !== "1") return;
    const id = window.setTimeout(() => setBenchOut(bench()), 300);
    return () => window.clearTimeout(id);
  }, []);

  const toggle = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const onSelect = useCallback((hit: TimelineHit) => {
    if (hit.span) store.select(hit.span.entity as EntityRef, { focus: false });
    else if (hit.mark?.entity) store.select(hit.mark.entity as EntityRef, { focus: false });
  }, []);
  const onHover = useCallback((hit: TimelineHit | null) => {
    if (hit?.span) setSaid(describeSpan(hit.span, LIVE_AT));
  }, []);
  const onLabel = useCallback((node: TrackNode) => {
    if (node.ref) store.select(node.ref, { focus: false });
  }, []);

  const trackW = Math.max(0, size.w - gutter);
  const trackH = Math.max(0, size.h - RULER_HEIGHT);
  const viewport = useMemo(() => ({ window: win, width: trackW, liveAt: LIVE_AT }), [win, trackW]);
  const zoomTo = (name: string) => setWin(ZOOMS[name]!);

  return (
    <div className="fixed inset-0 flex flex-col text-ink" style={{ background: "var(--mach-factory-ground)" }}>
      <header className="flex h-10 shrink-0 items-center gap-3 border-b px-4" style={{ borderColor: "var(--mach-factory-plate-edge)" }}>
        <span className="text-[13px] font-semibold">Execution Timeline</span>
        <span className="text-caption text-ink-subtle">Tracks proof · hand-built fixture · development only</span>
        <span className="min-w-0 flex-1 truncate text-[11.5px] text-ink-muted" aria-live="polite">
          {said}
        </span>
        {benchOut ? (
          <span className="font-mono text-[11px] text-ink-subtle tabular">
            {benchOut.spans.toLocaleString("en-GB")} spans: median {benchOut.medianMs} ms, p95 {benchOut.p95Ms} ms
          </span>
        ) : null}
        <span className="flex gap-1">
          {Object.keys(ZOOMS).map((z) => (
            <button key={z} type="button" onClick={() => zoomTo(z)} className="h-6 rounded-xs border border-line px-2 text-[11px] text-ink-muted hover:bg-surface-sunken">
              {z}
            </button>
          ))}
        </span>
      </header>
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0" style={{ borderBottom: "1px solid var(--mach-factory-plate-edge)" }}>
          <div className="flex shrink-0 items-end px-3 pb-1 text-[11px] text-ink-subtle" style={{ width: gutter, height: RULER_HEIGHT, borderRight: "1px solid var(--mach-factory-plate-edge)" }}>
            Tracks · UTC
          </div>
          {trackW > 0 ? <WindowRuler viewport={viewport} onWindow={setWin} /> : null}
        </div>
        <div ref={body} className="flex min-h-0 flex-1">
          {size.h > 0 ? (
            <>
              <TrackLabels layout={layout} height={trackH} scrollTop={top} width={gutter} onToggle={toggle} onSelect={onLabel} onResize={setGutter} onScroll={setTop} />
              {trackW > 0 ? (
                <TrackCanvas tree={fx.tree} layout={layout} viewport={viewport} marks={fx.marks} height={trackH} scrollTop={top} truncated={false} cursor={cursor} onCursor={setCursor} onScroll={setTop} onWindow={setWin} onHover={onHover} onSelect={onSelect} onToggle={toggle} />
              ) : null}
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("No #root element");
createRoot(root).render(
  <StrictMode>
    <ThemeProvider product="control-tower" persist={false} defaultPreference={theme === "light" || theme === "dark" ? (theme as ThemePreference) : "system"}>
      <TooltipProvider>
        <SceneStoreProvider store={store}>
          <Proof />
        </SceneStoreProvider>
      </TooltipProvider>
    </ThemeProvider>
  </StrictMode>,
);
