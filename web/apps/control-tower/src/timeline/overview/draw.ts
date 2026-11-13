/**
 * The overview's one canvas: gaps, density, activity, recorded limits, landmarks and the time axis,
 * bottom to top. Colours are the design tokens read at draw time, so both themes work. Everything is
 * already aggregated to pixel columns by model.ts: drawing is a few paths whatever the history holds.
 */
import { countText, type DensityColumns, type LimitSegment, type MarkBar, type MarkPoint, type PlacedLabel, type Step, type Tick } from "./model";

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
  /**
   * Where some of the cells in a station ended without an exit record (the end inferred or bounded):
   * a lighter band from the recorded count (`visits` is then the recorded part) up to the total (T9).
   */
  readonly visitsInferred?: ReadonlyArray<{ readonly x0: number; readonly x1: number; readonly lo: number; readonly hi: number }>;
  readonly agents: readonly Step[];
  /** Recorded limits that bound something counted here, each interval at its own level. */
  readonly limits: readonly LimitSegment[];
  /** Their labels, already placed (model.placeLimitLabels). */
  readonly limitLabels: readonly PlacedLabel[];
  /** The top of the linear scale (a count). */
  readonly vmax: number;
}

/** The activity band's y for a count: shared by drawing and label placement. */
export function activityY(L: OverviewLayout, vmax: number): (v: number) => number {
  const plotH = L.plotBottom - L.plotTop;
  return (v: number) => Math.round(L.plotBottom - (v / vmax) * (plotH - 4)) + 0.5;
}

/** The idle stretch after the last recorded event. */
export interface TailLayer {
  readonly x: number;
  readonly liveX: number;
  /** "last recorded 06:42:10", placed at `labelX` when there was room. */
  readonly label: string;
  readonly labelX: number | null;
  /** "nothing recorded for 7 h 1 min", centred in the tail when there is room. */
  readonly idle: string;
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
  readonly tail: TailLayer | null;
  /** Compressed idle stretches (X10), in pixels, with their length in words for the label under the axis. */
  readonly breaks?: ReadonlyArray<{ readonly x0: number; readonly x1: number; readonly label: string }>;
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

/**
 * Fills [x0, x1] x [y, y + h] with `color` at `alpha`, fading to nothing over the last third (at most
 * 48 px): an interval still open has no end to draw. Strips, not a gradient, so no colour is mixed in.
 */
function fadeRect(ctx: CanvasRenderingContext2D, x0: number, x1: number, y: number, h: number, color: string, alpha: number) {
  const len = Math.min(48, Math.max(4, (x1 - x0) / 3));
  const solidEnd = x1 - len;
  ctx.fillStyle = color;
  ctx.globalAlpha = alpha;
  if (solidEnd > x0) ctx.fillRect(x0, y, solidEnd - x0, h);
  const n = 12;
  for (let i = 0; i < n; i++) {
    ctx.globalAlpha = alpha * (1 - (i + 0.5) / n);
    ctx.fillRect(solidEnd + (i * len) / n, y, len / n + 0.01, h);
  }
  ctx.globalAlpha = 1;
}

/** Fewer pixels than this per landmark column on average, and the band draws strips instead of glyphs. */
export const DENSE_EVERY_PX = 6;

/** Clears the canvas (already scaled for the device pixel ratio) and draws one frame. */
export function drawOverview(ctx: CanvasRenderingContext2D, frame: OverviewFrame, p: OverviewPalette): void {
  const { width, height, layout: L } = frame;
  ctx.clearRect(0, 0, width, height);

  // Gaps first: what is not held is hatched through the plot and the landmark band. A wait on a person
  // stays in the landmark row (a thin line with its start mark, below): an open one can last hours, and
  // a wash over the whole plot would hide what ran meanwhile.
  for (const b of frame.bars) {
    if (b.family !== "gap") continue;
    const x0 = Math.floor(b.x0);
    hatch(ctx, x0, Math.max(x0 + 3, Math.ceil(b.x1)), L.bandTop, L.plotBottom, p);
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
    const y = activityY(L, a.vmax);
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
    // Cells in a station whose end was inferred: a lighter band above the recorded line (T9).
    if (a.visitsInferred?.length) {
      ctx.fillStyle = p.fInkSoft;
      ctx.globalAlpha = 0.18;
      for (const b of a.visitsInferred) ctx.fillRect(b.x0, y(b.hi), Math.max(1, b.x1 - b.x0), Math.max(1, y(b.lo) - y(b.hi)));
      ctx.globalAlpha = 1;
    }
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
    for (const l of a.limitLabels) {
      ctx.fillStyle = p.surface;
      ctx.globalAlpha = 0.85;
      ctx.fillRect(l.box.x, l.box.y, l.box.w, l.box.h);
      ctx.globalAlpha = 1;
      ctx.fillStyle = p.inkMuted;
      ctx.fillText(l.text, l.x, l.y);
    }
  }

  // 3. Landmarks, standing on the band's base.
  const base = L.bandBase;
  const top = L.bandTop;
  for (const b of frame.bars) {
    if (b.family === "human") {
      const x0 = Math.floor(b.x0);
      const x1 = Math.max(x0 + 2, Math.ceil(b.x1));
      // The wait as a bar on the base; one still open fades out towards the live edge.
      if (b.open) fadeRect(ctx, x0, x1, base - 3, 3, p.human, 1);
      else {
        ctx.fillStyle = p.human;
        ctx.fillRect(x0, base - 3, x1 - x0, 3);
      }
      // Down-triangle at the start: a person was needed.
      ctx.fillStyle = p.human;
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
  // Too many landmarks for glyphs to stay apart: each family becomes a thin strip whose strength
  // follows the count in each column (the tooltip still names what is there).
  if (frame.points.length > width / DENSE_EVERY_PX) {
    const rows: Record<"failure" | "halt" | "gate" | "human", { y: number; color: string }> = {
      failure: { y: top, color: p.fail },
      halt: { y: top + 4, color: p.halt },
      gate: { y: top + 8, color: p.fInk },
      human: { y: base - 3, color: p.human },
    };
    const peak = new Map<string, number>();
    for (const m of frame.points) peak.set(m.family, Math.max(peak.get(m.family) ?? 0, m.count));
    for (const m of frame.points) {
      if (m.family === "gap") {
        queryRing(ctx, m.x + 0.5, (top + base) / 2, 5.5, p);
        continue;
      }
      const r = rows[m.family];
      ctx.fillStyle = r.color;
      ctx.globalAlpha = 0.3 + 0.7 * (Math.log1p(m.count) / Math.log1p(peak.get(m.family) ?? 1));
      ctx.fillRect(m.x, r.y, 1, 3);
    }
    ctx.globalAlpha = 1;
  }
  for (const m of frame.points.length > width / DENSE_EVERY_PX ? [] : frame.points) {
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

  // 5. The idle tail: a small tick at the last record, its time, and how long nothing was recorded.
  const tail = frame.tail;
  if (tail) {
    const tx = Math.round(tail.x);
    ctx.fillStyle = p.inkMuted;
    ctx.fillRect(tx, L.plotBottom - 7, 1, 11);
    ctx.font = `500 10px ${p.mono}`;
    ctx.textBaseline = "alphabetic";
    let end = tx;
    if (tail.labelX !== null) {
      ctx.fillText(tail.label, tail.labelX, L.plotBottom - 3);
      end = tail.labelX + ctx.measureText(tail.label).width;
    }
    ctx.font = `11px ${p.sans}`;
    const iw = ctx.measureText(tail.idle).width;
    const room = tail.liveX - 8 - (end + 12);
    if (room >= iw) {
      ctx.fillStyle = p.inkSubtle;
      ctx.fillText(tail.idle, Math.round(end + 12 + (room - iw) / 2), Math.round((L.plotTop + L.plotBottom) / 2) + 4);
    }
  }

  // 5b. Breaks in the axis (X10): the plot cleared over the compressed stretch, a double slash across
  // the baseline (the Blueprint's ExecRuler mark), and how long it was under the axis.
  for (const b of frame.breaks ?? []) {
    const x0 = Math.floor(b.x0);
    const x1 = Math.ceil(b.x1);
    ctx.fillStyle = p.surface;
    ctx.fillRect(x0 + 2, L.plotTop, Math.max(0, x1 - x0 - 4), L.plotBottom - L.plotTop);
    const cx = (x0 + x1) / 2;
    const base = L.plotBottom;
    ctx.fillStyle = p.surface;
    ctx.fillRect(cx - 6, base - 5, 12, 10);
    ctx.strokeStyle = p.fInkSoft;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx - 4.5, base + 4);
    ctx.lineTo(cx - 0.5, base - 4);
    ctx.moveTo(cx + 0.5, base + 4);
    ctx.lineTo(cx + 4.5, base - 4);
    ctx.stroke();
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
  // The length of each break, on a ground-coloured box over its middle: how much idle time it stands for.
  ctx.font = `${L.compact ? 9 : 10}px ${p.mono}`;
  for (const b of frame.breaks ?? []) {
    const tw = ctx.measureText(b.label).width;
    const cx = (b.x0 + b.x1) / 2;
    // A break too narrow for its label (the idle tail at the live edge): the label ends before the
    // break instead of running under the live edge's "now" (X20).
    const inside = b.x1 - b.x0 >= tw + 8 && cx + tw / 2 <= width - 30;
    const lx = Math.round(inside ? Math.max(0, cx - tw / 2) : Math.max(0, b.x0 - 6 - tw));
    const ly = Math.round((L.plotTop + L.plotBottom) / 2);
    ctx.fillStyle = p.surface;
    ctx.fillRect(lx - 3, ly - 9, tw + 6, 13);
    ctx.fillStyle = p.inkMuted;
    ctx.fillText(b.label, lx, ly + 1);
  }
}
