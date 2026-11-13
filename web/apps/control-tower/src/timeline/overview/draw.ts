/**
 * The overview's one canvas: gaps, density, activity, recorded limits, landmarks and the time axis,
 * bottom to top. Colours are the design tokens read at draw time, so both themes work. Everything is
 * already aggregated to pixel columns by model.ts: drawing is a few paths whatever the history holds.
 */
import { countText, type DensityColumns, type MarkBar, type MarkPoint, type Step, type Tick } from "./model";

export interface OverviewPalette {
  ink: string;
  inkMuted: string;
  inkSubtle: string;
  line: string;
  lineStrong: string;
  surface: string;
  fInk: string;
  fInkSoft: string;
  live: string;
  fail: string;
  halt: string;
  human: string;
  humanSoft: string;
  sans: string;
  mono: string;
}

export function readOverviewPalette(el: Element): OverviewPalette {
  const cs = getComputedStyle(el);
  const v = (name: string) => cs.getPropertyValue(name).trim();
  const f = (name: string) => v(`--mach-factory-${name}`);
  return {
    ink: v("--mach-ink"),
    inkMuted: v("--mach-ink-muted"),
    inkSubtle: v("--mach-ink-subtle"),
    line: v("--mach-line"),
    lineStrong: v("--mach-line-strong"),
    surface: v("--mach-surface"),
    fInk: f("ink"),
    fInkSoft: f("ink-soft"),
    live: f("live"),
    fail: f("fail"),
    halt: f("halt"),
    human: f("human"),
    humanSoft: f("human-soft"),
    sans: v("--mach-font-sans") || "sans-serif",
    mono: v("--mach-font-mono") || "monospace",
  };
}

/** Vertical bands, CSS px from the top of the overview. */
export interface OverviewLayout {
  /** Landmark glyphs stand on `bandBase`; their tallest reaches `bandTop`. */
  readonly bandTop: number;
  readonly bandBase: number;
  /** Density and activity. */
  readonly plotTop: number;
  readonly plotBottom: number;
  /** Baseline of the time labels. */
  readonly labels: number;
  readonly compact: boolean;
}

export function overviewLayout(height: number): OverviewLayout {
  if (height < 88) return { bandTop: 3, bandBase: 13, plotTop: 16, plotBottom: 53, labels: 66, compact: true };
  return { bandTop: 4, bandBase: 17, plotTop: 21, plotBottom: 74, labels: 89, compact: false };
}

export interface ActivityLayer {
  readonly executions: readonly Step[];
  readonly visits: readonly Step[];
  readonly agents: readonly Step[];
  readonly limits: ReadonlyArray<{ readonly label: string; readonly value: number; readonly x0: number; readonly x1: number }>;
  /** The top of the linear scale (a count). */
  readonly vmax: number;
}

export interface OverviewFrame {
  readonly width: number;
  readonly height: number;
  readonly layout: OverviewLayout;
  readonly density: DensityColumns | null;
  readonly activity: ActivityLayer | null;
  readonly points: readonly MarkPoint[];
  readonly bars: readonly MarkBar[];
  readonly ticks: readonly Tick[];
}

function hatch(ctx: CanvasRenderingContext2D, x0: number, x1: number, top: number, bottom: number, p: OverviewPalette) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x0, top, x1 - x0, bottom - top);
  ctx.clip();
  ctx.fillStyle = p.surface;
  ctx.fillRect(x0, top, x1 - x0, bottom - top);
  ctx.strokeStyle = p.lineStrong;
  ctx.lineWidth = 1;
  ctx.beginPath();
  const h = bottom - top;
  // The `.mach-future` hatch: 135 degrees, every 7 px, anchored to the canvas so neighbours line up.
  for (let x = Math.floor((x0 - h) / 7) * 7; x < x1 + h; x += 7) {
    ctx.moveTo(x, bottom);
    ctx.lineTo(x + h, top);
  }
  ctx.stroke();
  ctx.restore();
}

/** The `ring-query` mark: an open hairline ring with a question mark. Unknown, never zero. */
function queryRing(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, p: OverviewPalette) {
  ctx.beginPath();
  ctx.arc(x, y, r - 0.5, 0, Math.PI * 2);
  ctx.fillStyle = p.surface;
  ctx.fill();
  ctx.strokeStyle = p.fInkSoft;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x - r * 0.03, y - r * 0.2, r * 0.3, Math.PI * 1.05, Math.PI * 2.35);
  ctx.lineTo(x, y + r * 0.2);
  ctx.lineCap = "round";
  ctx.lineWidth = 1.1;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x, y + r * 0.5, 0.75, 0, Math.PI * 2);
  ctx.fillStyle = p.fInkSoft;
  ctx.fill();
  ctx.lineCap = "butt";
}

function stepPath(steps: readonly Step[], y: (v: number) => number, close: number | null): Path2D {
  const path = new Path2D();
  let open = false;
  let lastX = 0;
  for (const s of steps) {
    if (!open) {
      path.moveTo(s.x0, close ?? y(s.value));
      if (close !== null) path.lineTo(s.x0, y(s.value));
      open = true;
    } else path.lineTo(s.x0, y(s.value));
    path.lineTo(s.x1, y(s.value));
    lastX = s.x1;
  }
  if (open && close !== null) {
    path.lineTo(lastX, close);
    path.closePath();
  }
  return path;
}

/** Clears the canvas (already scaled for the device pixel ratio) and draws one frame. */
export function drawOverview(ctx: CanvasRenderingContext2D, frame: OverviewFrame, p: OverviewPalette): void {
  const { width, height, layout: L } = frame;
  ctx.clearRect(0, 0, width, height);

  // Gaps first: what is not held is hatched through the plot and the landmark band.
  // A person wait shows quietly through the plot, so what ran meanwhile reads against it.
  for (const b of frame.bars) {
    const x0 = Math.floor(b.x0);
    if (b.family === "gap") hatch(ctx, x0, Math.max(x0 + 3, Math.ceil(b.x1)), L.bandTop, L.plotBottom, p);
    else {
      ctx.fillStyle = p.humanSoft;
      ctx.globalAlpha = 0.4;
      ctx.fillRect(x0, L.plotTop, Math.max(2, Math.ceil(b.x1) - x0), L.plotBottom - L.plotTop);
      ctx.globalAlpha = 1;
    }
  }

  // Baseline.
  ctx.fillStyle = p.lineStrong;
  ctx.fillRect(0, L.plotBottom, width, 1);

  // 1. Density: one 1 px column per pixel, log scale, ink-subtle.
  const plotH = L.plotBottom - L.plotTop;
  if (frame.density && frame.density.peak > 0) {
    const { values, peak } = frame.density;
    const path = new Path2D();
    for (let x = 0; x < values.length; x++) {
      const v = values[x]!;
      if (v <= 0) continue;
      const h = Math.max(1, (Math.log1p(v) / Math.log1p(peak)) * plotH);
      path.rect(x, L.plotBottom - h, 1, h);
    }
    ctx.globalAlpha = 0.22;
    ctx.fillStyle = p.inkSubtle;
    ctx.fill(path);
    ctx.globalAlpha = 1;
  }

  // 2. Activity: counts of recorded spans, linear, stepped.
  const a = frame.activity;
  if (a) {
    const y = (v: number) => Math.round(L.plotBottom - (v / a.vmax) * (plotH - 4)) + 0.5;
    // Recorded limits: dashed reference lines, behind the series they bound.
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = p.inkMuted;
    ctx.lineWidth = 1;
    for (const l of a.limits) {
      ctx.beginPath();
      ctx.moveTo(l.x0, y(l.value));
      ctx.lineTo(l.x1, y(l.value));
      ctx.stroke();
    }
    ctx.setLineDash([]);
    // Cells in a station: a stepped outline.
    if (a.visits.length) {
      ctx.strokeStyle = p.fInkSoft;
      ctx.lineWidth = 1;
      ctx.stroke(stepPath(a.visits, y, null));
    }
    // Agents: a thin line.
    if (a.agents.length) {
      ctx.strokeStyle = p.fInk;
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = 1;
      ctx.stroke(stepPath(a.agents, y, null));
      ctx.globalAlpha = 1;
    }
    // Executions running: a stepped area with its edge.
    if (a.executions.length) {
      ctx.fillStyle = p.live;
      ctx.globalAlpha = 0.14;
      ctx.fill(stepPath(a.executions, y, L.plotBottom));
      ctx.globalAlpha = 1;
      ctx.strokeStyle = p.live;
      ctx.lineWidth = 1.5;
      ctx.stroke(stepPath(a.executions, y, null));
    }
    // Limit labels last, on the ground colour, so a series never runs through them.
    ctx.font = `500 10px ${p.mono}`;
    ctx.textBaseline = "alphabetic";
    for (const l of a.limits) {
      const text = `${l.label} ${l.value}`;
      const tw = ctx.measureText(text).width;
      // At the left end: the right is where the newest history and the connection's state are.
      const lx = Math.min(l.x0 + 6, Math.max(0, l.x1 - tw - 6));
      const ly = y(l.value) - 3;
      ctx.fillStyle = p.surface;
      ctx.globalAlpha = 0.85;
      ctx.fillRect(lx - 3, ly - 9, tw + 6, 11);
      ctx.globalAlpha = 1;
      ctx.fillStyle = p.inkMuted;
      ctx.fillText(text, lx, ly);
    }
  }

  // 3. Landmarks, standing on the band's base.
  const base = L.bandBase;
  const top = L.bandTop;
  for (const b of frame.bars) {
    if (b.family === "human") {
      const x0 = Math.floor(b.x0);
      const x1 = Math.max(x0 + 2, Math.ceil(b.x1));
      // The wait as a bar on the base.
      ctx.fillStyle = p.human;
      ctx.fillRect(x0, base - 3, x1 - x0, 3);
      // Down-triangle at the start: a person was needed.
      ctx.beginPath();
      ctx.moveTo(x0 - 4, base - 9);
      ctx.lineTo(x0 + 4, base - 9);
      ctx.lineTo(x0, base - 3);
      ctx.closePath();
      ctx.fill();
      // An end cap where the wait ended; still waiting has none.
      if (!b.open) ctx.fillRect(x1 - 1, base - 7, 1.5, 7);
    } else {
      queryRing(ctx, (b.x0 + Math.max(b.x0 + 3, b.x1)) / 2, (top + base) / 2, 5.5, p);
    }
  }
  const counted: Array<{ x: number; y: number; n: number; color: string }> = [];
  for (const m of frame.points) {
    const x = m.x + 0.5;
    switch (m.family) {
      case "failure":
        // A tick up with a closed head.
        ctx.fillStyle = p.fail;
        ctx.fillRect(m.x, top + 3, 1.5, base - top - 3);
        ctx.beginPath();
        ctx.moveTo(x - 2.5, top + 4);
        ctx.lineTo(x + 2.5, top + 4);
        ctx.lineTo(x + 0.25, top);
        ctx.closePath();
        ctx.fill();
        break;
      case "halt": {
        // The grammar's halt: an octagon with a bar through it, on a short stem.
        ctx.fillStyle = p.halt;
        ctx.fillRect(m.x, base - 4, 1.5, 4);
        const cy = base - 8;
        const r = 4.5;
        const k = r * 0.414;
        ctx.beginPath();
        ctx.moveTo(x - k, cy - r);
        ctx.lineTo(x + k, cy - r);
        ctx.lineTo(x + r, cy - k);
        ctx.lineTo(x + r, cy + k);
        ctx.lineTo(x + k, cy + r);
        ctx.lineTo(x - k, cy + r);
        ctx.lineTo(x - r, cy + k);
        ctx.lineTo(x - r, cy - k);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = p.surface;
        ctx.fillRect(x - 2.25, cy - 0.6, 4.5, 1.2);
        break;
      }
      case "gate": {
        // Diamond: filled for a refusal, open for an override.
        const cy = base - 4.5;
        ctx.beginPath();
        ctx.moveTo(x, cy - 4);
        ctx.lineTo(x + 4, cy);
        ctx.lineTo(x, cy + 4);
        ctx.lineTo(x - 4, cy);
        ctx.closePath();
        if (m.refused) {
          ctx.fillStyle = p.fInk;
          ctx.fill();
        } else {
          ctx.fillStyle = p.surface;
          ctx.fill();
          ctx.strokeStyle = p.fInk;
          ctx.lineWidth = 1.25;
          ctx.stroke();
        }
        break;
      }
      case "human":
        ctx.fillStyle = p.human;
        ctx.beginPath();
        ctx.moveTo(x - 4, base - 9);
        ctx.lineTo(x + 4, base - 9);
        ctx.lineTo(x, base - 3);
        ctx.closePath();
        ctx.fill();
        break;
      case "gap":
        queryRing(ctx, x, (top + base) / 2, 5.5, p);
        break;
    }
    if (m.count > 1) counted.push({ x: m.x, y: top + 6, n: m.count, color: m.family === "failure" ? p.fail : m.family === "halt" ? p.halt : m.family === "human" ? p.human : p.fInk });
  }
  // Counts beside dense glyphs, only where they do not run into the next count.
  ctx.font = `600 9px ${p.mono}`;
  let lastEnd = -Infinity;
  for (const c of counted.sort((q, r) => q.x - r.x)) {
    const text = countText(c.n);
    const tw = ctx.measureText(text).width;
    if (c.x + 4 < lastEnd + 2 || c.x + 4 + tw > width) continue;
    ctx.fillStyle = c.color;
    ctx.fillText(text, c.x + 4, c.y + 3);
    lastEnd = c.x + 4 + tw;
  }

  // 6. Time labels: ticks on the baseline, mono, tabular.
  ctx.font = `${L.compact ? 10 : 11}px ${p.mono}`;
  ctx.textBaseline = "alphabetic";
  let labelEnd = -Infinity;
  for (const t of frame.ticks) {
    ctx.fillStyle = t.major ? p.inkMuted : p.lineStrong;
    ctx.fillRect(Math.round(t.x), L.plotBottom + 1, 1, t.major ? 5 : 3);
    const tw = ctx.measureText(t.label).width;
    const lx = Math.round(Math.min(width - tw, Math.max(0, t.x - tw / 2)));
    if (lx < labelEnd + 8) continue;
    ctx.fillStyle = t.major ? p.inkMuted : p.inkSubtle;
    ctx.fillText(t.label, lx, L.labels);
    labelEnd = lx + tw;
  }
}
