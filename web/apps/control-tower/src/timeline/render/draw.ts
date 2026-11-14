/**
 * The tracks' canvas drawing: every visible row in one pass, imperatively. Colours come from the
 * palette (CSS variables), geometry from the timing grammar of design section 5:
 *
 *   measured     solid body, square caps (2 px) or the family's own ends (tick, bracket)
 *   bounded      solid between the certain parts; the uncertain end a bracket pair over
 *                not_before..not_after, hatched inside
 *   inferred     the inferred end unfilled with a dashed 3/2 outline and an open arrowhead cap; "≈"
 *   open         runs to the live edge, its right end fading in steps, no cap, never an outcome
 *   unknown      a ring-query mark at the known end and a dotted 24 px stub away from it
 *   interrupted  a halt cut mark at the recorded stop and a dotted bridge to where work was taken up
 *
 * Families differ by shape: visits are 8 px bars; executions 5 px hollow rails with tick ends;
 * workflows a bracketed rail; agents a tier-shaped head and a 3 px line; waits dashed bands with a
 * stop bar; a person's wait a terracotta band under a down-triangle; tools 1 x 6 ticks; ribbons
 * 3 px strips under the row's own spans. Nothing is drawn after the live edge.
 */
import { outcomeKnownAt, type FlatRow, type SpanAuthority, type SpanKind, type TimelineMark, type TimelineSpan, type TimeWindow } from "../contract";
import { EMPTY_PLAN, laneIndex, LOD, planRow, runAlpha, spanTimes, subtreeColumns, type PlacedMark, type PlacedSpan, type RowPlan, type SubtreeColumns } from "./lod";
import { toneInk, toneOf, type Palette, type Tone } from "./palette";
import { scaleOf, xAt, type Scale } from "./scale";
import { elapsedWords } from "../../shell/inspector/words";
import { containedWords } from "../../text/fields";
import { capacityWords, countsTone, countsWords, durationText, shownCounts, endedWithoutExit, personApproved } from "./words";

export type Family = "lifetime" | "bracket" | "bar" | "task" | "rail" | "claim" | "workflow" | "agent" | "tool" | "wait" | "person";

export function familyOf(kind: SpanKind): Family {
  switch (kind) {
    case "wave":
    case "cell":
      return "lifetime";
    case "round":
      return "bracket";
    case "visit":
      return "bar";
    case "task":
      return "task";
    case "execution":
      return "rail";
    case "claim":
      return "claim";
    case "workflow":
      return "workflow";
    case "agent":
    case "seat":
      return "agent";
    case "tool":
      return "tool";
    case "person-wait":
    case "gate-wait":
      return "person";
    default:
      return "wait";
  }
}

/**
 * A span's family: its kind's, except a human-approval visit, which is a wait on a person (the open
 * rule, words.ts): drawn in the person-wait grammar on its station row, never as a work bar.
 */
export function familyOfSpan(span: Pick<TimelineSpan, "kind" | "ids">): Family {
  return isPersonVisit(span) ? "person" : familyOf(span.kind);
}

/** A station visit that is a wait on a person (the human-approval station). */
export function isPersonVisit(span: Pick<TimelineSpan, "kind" | "ids">): boolean {
  return span.kind === "visit" && span.ids.station === "human-approval";
}

/** Body thickness per family, CSS px. */
export const THICKNESS: Readonly<Record<Family, number>> = { lifetime: 1, bracket: 1, bar: 8, task: 5, rail: 5, claim: 1, workflow: 2, agent: 3, tool: 6, wait: 6, person: 6 };

// ---------------------------------------------------------------- row geometry

export interface RowGeom {
  readonly y: number;
  readonly h: number;
  /** The body's centre line. */
  readonly cy: number;
  /** Labels above the body (rows 24 px and taller) or inline after its start (thin rows). */
  readonly labelTop: boolean;
  readonly labelY: number;
  /** Top of the 3 px ribbon strip, when the row carries ribbons. */
  readonly ribbonY: number | null;
}

export function rowGeom(row: FlatRow, y: number): RowGeom {
  const h = row.height;
  const ribbons = row.lane === 0 && row.node.ribbons.length > 0;
  const labelTop = h >= 24;
  const top = y + (labelTop ? 12 : 0);
  const bottom = y + h - (ribbons ? 6 : 0);
  const cy = Math.round((top + bottom) / 2) + (labelTop ? 0 : 0.5);
  return { y, h, cy, labelTop, labelY: y + 10, ribbonY: ribbons ? y + h - 5 : null };
}

// ---------------------------------------------------------------- text

const widths = new Map<string, number>();
function measure(ctx: CanvasRenderingContext2D, font: string, text: string): number {
  const key = `${font}|${text}`;
  const w = widths.get(key);
  if (w !== undefined) return w;
  // Measured in the font asked for, whatever the context holds now (measuring a mono duration in the
  // sans label's font under-measured it, and the label ran into it: "Verify5 min 39 s").
  const before = ctx.font;
  ctx.font = font;
  const m = ctx.measureText(text).width;
  ctx.font = before;
  if (widths.size > 4000) widths.clear();
  widths.set(key, m);
  return m;
}

/** The text, or as much of it as fits followed by an ellipsis, or null when not even three characters fit. */
function fit(ctx: CanvasRenderingContext2D, font: string, text: string, max: number): string | null {
  if (max <= 6) return null;
  if (measure(ctx, font, text) <= max) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (measure(ctx, font, `${text.slice(0, mid)}…`) <= max) lo = mid;
    else hi = mid - 1;
  }
  return lo >= 3 ? `${text.slice(0, lo).trimEnd()}…` : null;
}

const STATION_SHORT: Readonly<Record<string, string>> = { "human-approval": "Approval" };

function cap(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

/** The short label drawn on a span (the sentence is the hover card's). */
export function shortLabel(span: TimelineSpan): string {
  const a = span.attrs;
  switch (span.kind) {
    case "visit": {
      if (isPersonVisit(span)) return "Waiting for a person";
      const st = span.ids.station === "merge" ? span.ids.station : (a.action ?? span.ids.station ?? "visit");
      return STATION_SHORT[st] ?? cap(st.replace(/-/g, " "));
    }
    case "round":
      return a.round ? `Round ${a.round}` : "Round";
    case "execution":
      // The row says which run it is; the supervisor's attempt number is the detail and the hover's.
      return "Execution";
    case "claim":
      return "Claim";
    case "workflow":
      return a.label ?? "Workflow";
    case "agent":
      // I-05: an agent's label is free text from its record: bounded by the session's display policy.
      return containedWords("agentLabel", a.label) || a.agentType || "Agent";
    case "seat":
      return cap(a.label ?? span.ids.seat ?? "Seat");
    case "task":
      return a.label ?? "Task";
    case "slice-wait":
      return "Waiting on a dependency";
    case "slice-eligible":
      return "Eligible";
    case "capacity-wait":
      return cap(capacityWords(span));
    case "agent-queue":
      return "Queued";
    case "person-wait":
      return "Waiting for a person";
    case "gate-wait":
      return a.label ?? "Waiting at a gate";
    case "wave":
    case "cell":
      return a.label ?? "";
    case "tool":
      return a.label ?? "";
  }
}

/** The short duration drawn at a span's right end. */
export function shortDuration(span: TimelineSpan, from: number, to: number, open: boolean): string {
  // Open at the end of a history that is no longer live: no length is claimed.
  if (!open && span.end === null && span.attrs.historyEndsAt !== undefined) return "no end recorded";
  // A visit whose exit was stamped after its execution ended: entry to exit is not time spent working.
  if (span.attrs.interruptedAt !== undefined) return elapsedWords("interrupted", true, !open, durationText(open ? to - from : (span.duration.ms ?? span.duration.maxMs ?? to - from)));
  if (open) return durationText(to - from);
  const d = span.duration;
  if (endedWithoutExit(span)) return `≤ ${durationText(d.maxMs ?? d.ms ?? to - from)}`;
  if (d.basis === "bounded" && d.minMs !== null && d.maxMs !== null) {
    const b = durationText(d.maxMs);
    // A lower bound of nothing is not information: "≤ 4 min 7 s", not "0 ms – 4 min 7 s" (round 6).
    if (d.minMs <= 0) return `≤ ${b}`;
    const a = durationText(d.minMs);
    return a === b ? a : `${a} – ${b}`;
  }
  const ms = d.ms ?? to - from;
  return d.basis === "inferred" ? `≈ ${durationText(ms)}` : durationText(ms);
}

// ---------------------------------------------------------------- glyphs

type Ctx = CanvasRenderingContext2D;

function diamond(ctx: Ctx, x: number, y: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x, y - r);
  ctx.lineTo(x + r, y);
  ctx.lineTo(x, y + r);
  ctx.lineTo(x - r, y);
  ctx.closePath();
}

function triangleDown(ctx: Ctx, x: number, y: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x - r, y - r * 0.75);
  ctx.lineTo(x + r, y - r * 0.75);
  ctx.lineTo(x, y + r * 0.85);
  ctx.closePath();
}

/** The model tier's head: Fable diamond, Opus square, Sonnet circle, Haiku triangle (the grammar's shapes). */
export function tierHead(ctx: Ctx, model: string | undefined, x: number, y: number) {
  const m = (model ?? "").toLowerCase();
  ctx.beginPath();
  if (m.includes("fable")) {
    ctx.moveTo(x, y - 4.4);
    ctx.lineTo(x + 3.6, y);
    ctx.lineTo(x, y + 4.4);
    ctx.lineTo(x - 3.6, y);
    ctx.closePath();
  } else if (m.includes("opus")) ctx.rect(x - 3.2, y - 3.2, 6.4, 6.4);
  else if (m.includes("haiku")) {
    ctx.moveTo(x, y - 3.8);
    ctx.lineTo(x + 3.6, y + 2.8);
    ctx.lineTo(x - 3.6, y + 2.8);
    ctx.closePath();
  } else if (m.includes("sonnet")) ctx.arc(x, y, 3.4, 0, Math.PI * 2);
  else {
    // A model not recorded: a dashed ring, never a tier it may not be.
    ctx.arc(x, y, 3.4, 0, Math.PI * 2);
  }
}

/** The authority glyph (the same shapes as AuthorityBadge): filled, ring with dot, open triangle, dashed ring. */
export function authorityGlyph(ctx: Ctx, authority: SpanAuthority, x: number, y: number, ink: string, ground: string) {
  ctx.save();
  ctx.lineWidth = 1;
  ctx.strokeStyle = ink;
  ctx.fillStyle = ink;
  switch (authority) {
    case "authoritative":
      ctx.beginPath();
      ctx.arc(x, y, 2.6, 0, Math.PI * 2);
      ctx.fill();
      break;
    case "observed":
      ctx.beginPath();
      ctx.arc(x, y, 2.6, 0, Math.PI * 2);
      ctx.fillStyle = ground;
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x, y, 1.1, 0, Math.PI * 2);
      ctx.fillStyle = ink;
      ctx.fill();
      break;
    case "reconstructed":
      ctx.beginPath();
      ctx.moveTo(x - 2.8, y + 2.4);
      ctx.lineTo(x, y - 2.8);
      ctx.lineTo(x + 2.8, y + 2.4);
      ctx.closePath();
      ctx.stroke();
      break;
    case "simulated":
      ctx.setLineDash([1.4, 1.3]);
      ctx.beginPath();
      ctx.arc(x, y, 2.6, 0, Math.PI * 2);
      ctx.stroke();
      break;
  }
  ctx.restore();
}

/** The grammar's ring-query: "not known". An open hairline ring with a question mark. */
export function ringQuery(ctx: Ctx, x: number, y: number, r: number, ink: string, ground: string) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = ground;
  ctx.fill();
  ctx.strokeStyle = ink;
  ctx.lineWidth = 0.9;
  ctx.stroke();
  ctx.beginPath();
  ctx.lineCap = "round";
  ctx.lineWidth = 1;
  ctx.arc(x, y - r * 0.22, r * 0.36, Math.PI * 1.05, Math.PI * 2.35);
  ctx.lineTo(x, y + r * 0.22);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x, y + r * 0.55, 0.65, 0, Math.PI * 2);
  ctx.fillStyle = ink;
  ctx.fill();
  ctx.restore();
}

/** The halt cut: a gap through the body and two slashes in the halt ink, at x. */
function haltCut(ctx: Ctx, x: number, cy: number, th: number, p: Palette) {
  const h = Math.max(10, th + 6);
  ctx.save();
  ctx.fillStyle = p.ground;
  ctx.beginPath();
  ctx.moveTo(x - 2.5, cy + h / 2);
  ctx.lineTo(x + 0.5, cy - h / 2);
  ctx.lineTo(x + 3.5, cy - h / 2);
  ctx.lineTo(x + 0.5, cy + h / 2);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = p.halt;
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(x - 2.8, cy + h / 2);
  ctx.lineTo(x + 0.2, cy - h / 2);
  ctx.moveTo(x + 0.8, cy + h / 2);
  ctx.lineTo(x + 3.8, cy - h / 2);
  ctx.stroke();
  ctx.restore();
}

function hatch(ctx: Ctx, x0: number, y0: number, x1: number, y1: number, ink: string) {
  if (x1 - x0 < 0.5) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x0, y0, x1 - x0, y1 - y0);
  ctx.clip();
  ctx.strokeStyle = ink;
  ctx.lineWidth = 0.9;
  ctx.globalAlpha *= 0.75;
  ctx.beginPath();
  const h = y1 - y0;
  for (let x = x0 - h; x < x1 + h; x += 3.5) {
    ctx.moveTo(x, y1);
    ctx.lineTo(x + h, y0);
  }
  ctx.stroke();
  ctx.restore();
}

/** A bound bracket: `[` (dir 1) or `]` (dir -1) of height h about cy. */
function boundBracket(ctx: Ctx, x: number, cy: number, h: number, dir: 1 | -1, ink: string) {
  ctx.strokeStyle = ink;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(x + 3 * dir, cy - h / 2);
  ctx.lineTo(x, cy - h / 2);
  ctx.lineTo(x, cy + h / 2);
  ctx.lineTo(x + 3 * dir, cy + h / 2);
  ctx.stroke();
}

/** An open arrowhead cap pointing outward (dir 1: right, -1: left), as the Blueprint's inferred DimLine. */
function openArrow(ctx: Ctx, x: number, cy: number, dir: 1 | -1, ink: string) {
  ctx.strokeStyle = ink;
  ctx.lineWidth = 1.1;
  ctx.beginPath();
  ctx.moveTo(x - 4.5 * dir, cy - 3.2);
  ctx.lineTo(x, cy);
  ctx.lineTo(x - 4.5 * dir, cy + 3.2);
  ctx.stroke();
}

// ---------------------------------------------------------------- span painting

interface Paint {
  readonly ctx: Ctx;
  readonly p: Palette;
  readonly scale: Scale;
  readonly liveAt: number;
  readonly xLive: number;
  /** The opacity everything of the current span is drawn at (a newly arrived span fades in). */
  base: number;
  /**
   * Text over a row's top band, painted once the row's marks are drawn and on a knock-out of the
   * ground, so no mark, cap or tick strikes through a label or a duration (round 6, defect 13).
   */
  readonly later?: (() => void)[];
}

export type Box = readonly [number, number, number, number];

type SegKind = "solid" | "inferred" | "hatch" | "fade";

/** One stretch of a body. Fill and edges per family; the caps are drawn after. */
function segment(c: Paint, fam: Family, xa: number, xb: number, cy: number, th: number, ink: string, soft: string, kind: SegKind, alpha = 1) {
  const { ctx } = c;
  if (xb - xa <= 0.01) return;
  const top = cy - th / 2;
  ctx.globalAlpha = alpha * c.base;
  switch (fam) {
    case "bar":
    case "task":
    case "rail":
    case "wait":
    case "person": {
      const filled = fam !== "rail";
      if (kind === "hatch") {
        hatch(ctx, xa, top, xb, top + th, ink);
      } else if (filled && kind !== "inferred") {
        ctx.fillStyle = soft;
        ctx.fillRect(xa, top, xb - xa, th);
      }
      if (fam === "wait" || fam === "person") {
        // A dashed centre line: waiting, not working.
        ctx.strokeStyle = ink;
        ctx.lineWidth = 1.2;
        ctx.setLineDash([4, 3]);
        ctx.lineDashOffset = -xa;
        ctx.beginPath();
        ctx.moveTo(xa, cy);
        ctx.lineTo(xb, cy);
        ctx.stroke();
        ctx.setLineDash([]);
        if (kind === "inferred") {
          ctx.setLineDash([3, 2]);
          ctx.lineWidth = 1;
          ctx.strokeRect(xa, top + 0.5, xb - xa, th - 1);
          ctx.setLineDash([]);
        }
        break;
      }
      if (kind === "inferred") {
        ctx.strokeStyle = ink;
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 2]);
        ctx.beginPath();
        ctx.moveTo(xa, top + 0.5);
        ctx.lineTo(xb, top + 0.5);
        ctx.moveTo(xa, top + th - 0.5);
        ctx.lineTo(xb, top + th - 0.5);
        ctx.stroke();
        ctx.setLineDash([]);
      } else {
        // Solid edges as rectangles: far cheaper than stroked paths, and pixel-exact.
        ctx.fillStyle = ink;
        ctx.fillRect(xa, top, xb - xa, 1);
        ctx.fillRect(xa, top + th - 1, xb - xa, 1);
      }
      break;
    }
    case "agent":
    case "claim":
    case "workflow":
    case "lifetime": {
      if (kind === "hatch") {
        hatch(ctx, xa, cy - 3, xb, cy + 3, ink);
        break;
      }
      const lw = fam === "agent" ? 3 : fam === "workflow" ? 2 : 1;
      const color = fam === "lifetime" ? c.p.route : ink;
      if (fam === "agent") ctx.globalAlpha = alpha * 0.6 * c.base;
      if (kind === "inferred") {
        ctx.strokeStyle = color;
        ctx.lineWidth = lw;
        ctx.setLineDash([3, 2]);
        ctx.beginPath();
        ctx.moveTo(xa, cy);
        ctx.lineTo(xb, cy);
        ctx.stroke();
        ctx.setLineDash([]);
      } else {
        ctx.fillStyle = color;
        ctx.fillRect(xa, cy - lw / 2, xb - xa, lw);
      }
      break;
    }
    default:
      break;
  }
  ctx.globalAlpha = c.base;
}

/** A recorded end's cap, in the family's own form. `dir` -1 is the left end, 1 the right. */
function recordedCap(c: Paint, fam: Family, x: number, cy: number, th: number, ink: string, dir: 1 | -1) {
  const { ctx } = c;
  ctx.fillStyle = ink;
  switch (fam) {
    case "bar":
    case "task":
      // Square caps, 2 px, standing 2 px proud of the body.
      ctx.fillRect(dir < 0 ? x : x - 2, cy - th / 2 - 2, 2, th + 4);
      break;
    case "rail":
      ctx.fillRect(dir < 0 ? x : x - 1.5, cy - 6, 1.5, 12);
      break;
    case "claim":
    case "lifetime":
      ctx.fillStyle = fam === "lifetime" ? c.p.route : ink;
      ctx.fillRect(dir < 0 ? x : x - 1, cy - 3.5, 1, 7);
      break;
    case "workflow":
      ctx.strokeStyle = ink;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(x - 3 * dir, cy - 5);
      ctx.lineTo(x, cy - 5);
      ctx.lineTo(x, cy + 5);
      ctx.lineTo(x - 3 * dir, cy + 5);
      ctx.stroke();
      break;
    case "agent":
      if (dir > 0) ctx.fillRect(x - 1, cy - 3, 1, 6);
      break;
    case "wait":
      if (dir < 0) ctx.fillRect(x, cy - 6, 1.5, 12); // the stop bar
      else ctx.fillRect(x - 1, cy - 3, 1, 6);
      break;
    case "person":
      if (dir > 0) ctx.fillRect(x - 1, cy - 3, 1, 6);
      break;
    default:
      break;
  }
}

/** Stepped fade at an open right end: work in progress, no cap, no outcome. */
const FADE_STEPS = [0.82, 0.62, 0.44, 0.28, 0.16, 0.08];

interface Painted {
  readonly box: Box;
}

function paintSpan(c: Paint, item: PlacedSpan, g: RowGeom, next: PlacedSpan | undefined, labels: boolean, marks: readonly PlacedMark[]): Painted {
  const { ctx, p } = c;
  const { span, times } = item;
  const fam = familyOfSpan(span);
  const th = THICKNESS[fam];
  const tone: Tone = toneOf(span, times, c.liveAt);
  const { ink, soft } = toneInk(p, tone);
  const cy = g.cy;

  // Unknown: a mark at the known end and a fixed stub, never a length.
  if (times.startUnknown || times.endUnknown) {
    const x = Math.round(item.x0) + 0.5;
    const dir = times.startUnknown ? -1 : 1;
    ctx.save();
    ctx.strokeStyle = p.fInkSoft;
    ctx.lineWidth = 1;
    ctx.lineCap = "round";
    ctx.setLineDash([1, 2.4]);
    ctx.beginPath();
    ctx.moveTo(x + 5 * dir, cy);
    ctx.lineTo(x + (5 + LOD.stubPx) * dir, cy);
    ctx.stroke();
    ctx.restore();
    ringQuery(ctx, x, cy, 4.2, p.fInkSoft, p.ground);
    const x0 = dir < 0 ? x - 5 - LOD.stubPx : x - 5;
    return { box: [x0, cy - 5, x0 + LOD.stubPx + 10, cy + 5] };
  }

  const X0 = Math.round(item.x0);
  const X1 = Math.max(X0 + 2, Math.round(item.x1));
  const s = span.start;
  const e = span.end;
  const xOf = (t: number) => Math.round(xAt(c.scale, Math.min(t, c.liveAt)));
  const open = times.open;

  // Uncertain stretches.
  const startBound = s && s.at === null && s.notBefore !== null && s.notAfter !== null && s.notAfter > s.notBefore ? [xOf(s.notBefore), xOf(s.notAfter)] as const : null;
  const endBound = !open && e && e.notBefore !== null && e.notAfter !== null && e.notAfter > e.notBefore ? [xOf(e.notBefore), xOf(e.notAfter)] as const : null;
  const inferStart = !startBound && s?.basis === "inferred";
  // Ended without an exit record: the bar runs to the bound in the inferred grammar, then the halt cut.
  const noExit = !open && endedWithoutExit(span);
  // Open when a history that is no longer live ended: no cap, the ring-query at the history's end.
  const noEnd = times.noEnd === true;
  const inferEnd = !open && (noExit || (!endBound && e?.basis === "inferred"));
  const w = X1 - X0;
  const inferLen = Math.min(18, Math.max(4, w / 3));
  const fadeLen = open ? Math.min(24, Math.max(0, w / 2)) : 0;

  let a = startBound ? startBound[1] : inferStart ? X0 + inferLen : X0;
  let b = endBound && !noExit ? endBound[0] : inferEnd ? X1 - inferLen : open ? X1 - fadeLen : X1;
  if (b < a) b = a;
  // The agent's head stands at its start; its line begins after it.
  const head = fam === "agent";
  if (head) a = Math.max(a, X0 + 5);

  if (fam === "bracket") {
    return paintBracket(c, item, g, ink, labels);
  }

  // Person waits: the down-triangle at the start, above the band.
  if (startBound) segment(c, fam, startBound[0], startBound[1], cy, th, ink, soft, "hatch");
  if (inferStart) segment(c, fam, X0, a, cy, th, ink, soft, "inferred");
  segment(c, fam, a, b, cy, th, ink, soft, "solid");
  if (inferEnd) segment(c, fam, b, X1, cy, th, ink, soft, "inferred");
  if (endBound && !noExit) segment(c, fam, endBound[0], endBound[1], cy, th, ink, soft, "hatch");
  if (open && fadeLen > 0) {
    const step = fadeLen / FADE_STEPS.length;
    FADE_STEPS.forEach((alpha, i) => segment(c, fam, b + i * step, b + (i + 1) * step, cy, th, ink, soft, "solid", alpha));
  }

  // Caps: the left end.
  const capH = th + 6;
  if (startBound) {
    boundBracket(ctx, startBound[0], cy, capH, 1, ink);
    boundBracket(ctx, startBound[1], cy, capH, -1, ink);
  } else if (inferStart) openArrow(ctx, X0, cy, -1, ink);
  else if (!head) recordedCap(c, fam, X0, cy, th, ink, -1);
  // The right end: never a cap while open.
  const seat = span.kind === "seat";
  if (!open && !noEnd && !(seat && !noExit)) {
    if (endBound && !noExit) {
      boundBracket(ctx, endBound[0], cy, capH, 1, ink);
      boundBracket(ctx, endBound[1], cy, capH, -1, ink);
    } else if (inferEnd) openArrow(ctx, X1, cy, 1, ink);
    else recordedCap(c, fam, X1, cy, th, ink, 1);
  }

  if (fam === "person") {
    triangleDown(ctx, X0 + 0.5, cy - th / 2 - 4, 4);
    ctx.fillStyle = p.human;
    ctx.fill();
    // Approved: an up-tick at the approval, the wait's other end.
    if (!open && personApproved(span, c.liveAt)) {
      ctx.fillStyle = p.human;
      ctx.fillRect(X1 - 1, cy - th / 2 - 5, 1.5, th + 5);
      ctx.beginPath();
      ctx.moveTo(X1 - 3.8, cy - th / 2 - 3);
      ctx.lineTo(X1 + 0.25, cy - th / 2 - 8);
      ctx.lineTo(X1 + 4.3, cy - th / 2 - 3);
      ctx.closePath();
      ctx.fill();
    }
  }
  // A review seat: its verdict diamond at the verdict, coloured by the vote only once it is known.
  if (seat && !open && !noExit && e && e.at !== null && e.at <= c.liveAt) {
    const known = outcomeKnownAt(span, c.liveAt);
    const vote = known ? (span.attrs.vote ?? span.outcome ?? "") : "";
    const { ink: vi, soft: vs } = /reject|refus|block/i.test(vote) ? { ink: p.fail, soft: p.failSoft } : /approv/i.test(vote) ? { ink: p.pass, soft: p.passSoft } : { ink: p.fInkSoft, soft: p.ground };
    diamond(ctx, X1, cy, 4.6);
    ctx.fillStyle = vs;
    ctx.fill();
    ctx.strokeStyle = vi;
    ctx.lineWidth = 1.3;
    ctx.stroke();
  }

  let textFrom = X0 + (fam === "wait" || fam === "person" ? 5 : 3);
  if (head) {
    tierHead(ctx, span.attrs.model, X0 + 0.5, cy);
    ctx.fillStyle = p.ground;
    ctx.fill();
    ctx.strokeStyle = tone === "live" ? p.live : p.fInk;
    ctx.lineWidth = 1.2;
    ctx.stroke();
    textFrom = X0 + 7;
    // A count-only agent: its tool-call count after the head, never invented ticks.
    if (span.attrs.toolsCountOnly && span.attrs.toolCalls !== undefined && w >= 18) {
      const font = `500 9.5px ${p.mono}`;
      ctx.font = font;
      const text = String(span.attrs.toolCalls);
      const tw = measure(ctx, font, text);
      ctx.fillStyle = p.ground;
      ctx.fillRect(textFrom - 1, cy - 5, tw + 4, 10);
      ctx.fillStyle = p.inkMuted;
      ctx.fillText(text, textFrom + 1, cy + 3.4);
      textFrom += tw + 5;
    }
  }

  // Interrupted: the halt cut at the recorded stop and a dotted bridge to where work was taken up.
  const reason = e?.reason;
  const cutX = noExit ? X1 + 5 : X1;
  if (noEnd || (!open && reason === "unknown")) {
    // No outcome is known (recovery found the state unknown, or cleanup closed it): the ring-query at the
    // bound, never the halt cut of a recorded stop.
    ringQuery(ctx, cutX, cy, 4.2, p.fInkSoft, p.ground);
  } else if (!open && (noExit || reason === "interrupted" || reason === "superseded")) {
    haltCut(ctx, cutX, cy, th, p);
    if (next && next.x0 > cutX + 4) {
      ctx.save();
      ctx.strokeStyle = p.halt;
      ctx.lineWidth = 1;
      ctx.lineCap = "round";
      ctx.setLineDash([1, 2.4]);
      ctx.beginPath();
      ctx.moveTo(cutX + 5, cy + 0.5);
      ctx.lineTo(Math.min(next.x0 - 2, c.xLive), cy + 0.5);
      ctx.stroke();
      ctx.restore();
    }
  } else if (span.attrs.interruptedAt !== undefined && span.attrs.interruptedAt <= c.liveAt) {
    const xi = xOf(span.attrs.interruptedAt);
    if (xi > X0 + 3 && xi < X1 - 3) haltCut(ctx, xi, cy, th, p);
  }

  // A lifetime (wave, cell) is named by its row's label: the line alone.
  // Past the end cap or verdict, up to the next span in the row: where a thin row's label goes when the
  // bar is too short for it (round 6: the first review seat's "Architecture" was dropped).
  const beyond = { from: X1 + (seat ? 9 : 6), to: Math.min(next ? next.x0 - 6 : Number.POSITIVE_INFINITY, c.xLive - 2, c.scale.width - 4) };
  if (labels && item.lod !== "geometry" && fam !== "lifetime") paintLabel(c, item, g, X0, X1 - (seat ? 6 : 0), textFrom, tone, fam, marks, beyond);

  const half = Math.max(th / 2, 3) + 2;
  return { box: [X0 - 1, cy - half, (noExit ? cutX + 4 : seat ? X1 + 5 : X1 + 1), cy + half] };
}

/** A round: a dimension bracket over the row, its name set in a gap in the line. */
function paintBracket(c: Paint, item: PlacedSpan, g: RowGeom, ink: string, labels: boolean): Painted {
  const { ctx, p } = c;
  const X0 = Math.round(item.x0) + 0.5;
  const X1 = Math.max(X0 + 2, Math.round(item.x1) - 0.5);
  const y = Math.round(g.y + g.h / 2) + 0.5;
  const open = item.times.open;
  ctx.strokeStyle = ink === p.fInkSoft ? p.plateEdge : ink;
  ctx.lineWidth = 1;
  if (item.span.start?.basis === "inferred" || item.span.end?.basis === "inferred") ctx.setLineDash([3, 2]);
  ctx.beginPath();
  ctx.moveTo(X0, y + 4);
  ctx.lineTo(X0, y);
  ctx.lineTo(X1, y);
  if (!open) ctx.lineTo(X1, y + 4);
  ctx.stroke();
  ctx.setLineDash([]);
  if (labels && item.lod !== "geometry") {
    const font = `500 10px ${p.mono}`;
    ctx.font = font;
    const text = fit(ctx, font, `${item.span.end?.basis === "inferred" ? "≈ " : ""}${shortLabel(item.span)}`, X1 - X0 - 16);
    if (text) {
      const tw = measure(ctx, font, text);
      const left = Math.max(X0 + 8, Math.min(X1 - tw - 8, Math.max(0, X0) + 8));
      ctx.fillStyle = p.ground;
      ctx.fillRect(left - 4, y - 6, tw + 8, 12);
      ctx.fillStyle = p.inkMuted;
      ctx.fillText(text, left, y + 3.5);
    }
  }
  return { box: [X0 - 1, y - 3, X1 + 1, y + 5] };
}

function paintLabel(c: Paint, item: PlacedSpan, g: RowGeom, X0: number, X1: number, textFrom: number, tone: Tone, fam: Family, marks: readonly PlacedMark[], beyond?: { readonly from: number; readonly to: number }) {
  const { ctx, p } = c;
  const span = item.span;
  const label = shortLabel(span);
  const approx = span.start?.basis === "inferred" || span.end?.basis === "inferred";
  const text = label ? `${approx ? "≈ " : ""}${label}` : "";
  const sans = `600 10.5px ${p.sans}`;
  const mono = `400 10px ${p.mono}`;
  // A span partly off the left edge keeps its label in view.
  const visible0 = Math.max(X0, 0);
  if (g.labelTop) {
    const y = g.labelY;
    let x = Math.max(textFrom - 3, visible0 + 1);
    // Clear of whatever begins where this ends (the next span's own label and glyph).
    const right = Math.min(X1 - 8, c.xLive - 2, c.scale.width - 2);
    authorityGlyph(ctx, span.authority, x + 2.6, y - 3.4, p.fInkSoft, p.ground);
    x += 8;
    let room = right - x;
    let dur: string | null = null;
    if (item.lod === "duration") {
      dur = shortDuration(span, item.times.from, item.times.to, item.times.open);
      const dw = measure(ctx, mono, dur);
      ctx.font = sans;
      const lw = text ? measure(ctx, sans, text) : 0;
      if (lw + dw + 12 <= room) room -= dw + 10;
      else dur = null;
    }
    ctx.font = sans;
    const shown = text ? fit(ctx, sans, text, room) : null;
    const alpha = ctx.globalAlpha;
    const paint = () => {
      ctx.globalAlpha = alpha;
      if (shown) {
        const lw = measure(ctx, sans, shown);
        ctx.fillStyle = p.ground;
        ctx.fillRect(x - 1.5, y - 8, lw + 3, 9.5);
        ctx.font = sans;
        ctx.fillStyle = tone === "fail" ? p.fail : p.inkMuted;
        ctx.fillText(shown, x, y);
      }
      if (dur) {
        const dw = measure(ctx, mono, dur);
        ctx.fillStyle = p.ground;
        ctx.fillRect(right - dw - 1.5, y - 8, dw + 3, 9.5);
        ctx.font = mono;
        ctx.fillStyle = p.inkSubtle;
        ctx.textAlign = "right";
        ctx.fillText(dur, right, y);
        ctx.textAlign = "left";
      }
      ctx.globalAlpha = 1;
    };
    if (c.later) c.later.push(paint);
    else paint();
    return;
  }
  // Thin rows: the label inline after the start, on a knock-out of the ground.
  if (!text) return;
  const y = g.cy + 3.5;
  const font = `500 10px ${p.sans}`;
  ctx.font = font;
  // Clear of the end cap and of whatever begins where this ends (an agent's head after its queue).
  const room = inlineRoom(Math.max(textFrom + 2, visible0 + 4), Math.min(X1 - 6, c.xLive, c.scale.width - 4), marks);
  const shown = room ? fit(ctx, font, text, room.right - room.x - 3) : null;
  // Too short a bar for the whole label: after its end, when the row is free there, if it is not cut
  // there (else a shortened label stays inside). Not an agent: its lane packs the next agent close.
  const outside = beyond && shown !== text && span.kind !== "agent" && span.kind !== "agent-queue" ? inlineRoom(Math.max(beyond.from, visible0 + 4), beyond.to, marks) : null;
  const after = outside ? fit(ctx, font, text, outside.right - outside.x - 3) : null;
  if (outside && after && (!shown || after === text)) {
    const tw = measure(ctx, font, after);
    ctx.fillStyle = p.ground;
    ctx.fillRect(outside.x - 3, g.cy - 5.5, tw + 6, 11);
    ctx.fillStyle = tone === "fail" ? p.fail : p.inkMuted;
    ctx.fillText(after, outside.x, y);
    return;
  }
  if (!room || !shown) return;
  const { x, right } = room;
  const tw = measure(ctx, font, shown);
  ctx.fillStyle = p.ground;
  ctx.fillRect(x - 3, g.cy - 5.5, tw + 6, 11);
  ctx.fillStyle = tone === "fail" ? p.fail : p.inkMuted;
  ctx.fillText(shown, x, y);
  if (item.lod === "duration" && fam !== "agent") {
    const dur = shortDuration(span, item.times.from, item.times.to, item.times.open);
    const mono = `400 9.5px ${p.mono}`;
    ctx.font = mono;
    const dw = measure(ctx, mono, dur);
    if (x + tw + dw + 16 < right) {
      ctx.fillStyle = p.ground;
      ctx.fillRect(right - dw - 3, g.cy - 5.5, dw + 6, 11);
      ctx.fillStyle = p.inkSubtle;
      ctx.textAlign = "right";
      ctx.fillText(dur, right, y);
      ctx.textAlign = "left";
    }
  }
}

/**
 * Where an inline label may go in a thin row, clear of the row's marks (a person's triangle, a gate's
 * diamond): a mark near the start pushes the label after it, a mark further on ends the room before
 * it. Null when no room is left. Pure.
 */
export function inlineRoom(x: number, right: number, marks: readonly { readonly x: number }[], half = MARK_HALF): { x: number; right: number } | null {
  let a = x;
  let b = right;
  for (const m of [...marks].sort((u, v) => u.x - v.x)) {
    if (m.x + half < a - 3 || m.x - half > b) continue;
    // A mark within the first stretch of the room moves the label past it; otherwise the room ends there.
    if (m.x - half <= a + 12) a = Math.max(a, m.x + half + 4);
    else b = Math.min(b, m.x - half - 4);
  }
  return b - a >= 18 ? { x: a, right: b } : null;
}

/** Half the width a mark takes on a row, with its stroke. */
export const MARK_HALF = 6;

/** A tool call: a 1 x 6 tick; its length as a faint body when there is room to show it. */
function paintTick(c: Paint, item: PlacedSpan, cy: number): Box {
  const { ctx, p } = c;
  const tone = toneOf(item.span, item.times, c.liveAt);
  const ink = tone === "fail" ? p.fail : tone === "live" ? p.live : p.fInk;
  const x = Math.round(item.x0);
  const w = item.x1 - item.x0;
  if (w >= 6) {
    ctx.globalAlpha = 0.28 * c.base;
    ctx.fillStyle = ink;
    ctx.fillRect(x, cy - 2, w, 4);
    ctx.globalAlpha = c.base;
  }
  ctx.fillStyle = ink;
  ctx.fillRect(x, cy - 3, 1, 6);
  // Room for its name: set small on a knock-out, after the tick.
  const name = item.span.attrs.label;
  if (name && w >= LOD.labelPx) {
    const font = `500 9px ${p.mono}`;
    ctx.font = font;
    const shown = fit(ctx, font, name, Math.min(w, c.scale.width - x) - 6);
    if (shown) {
      const tw = measure(ctx, font, shown);
      ctx.fillStyle = p.ground;
      ctx.fillRect(x + 2, cy - 4.5, tw + 4, 9);
      ctx.fillStyle = p.inkMuted;
      ctx.fillText(shown, x + 4, cy + 3);
    }
  }
  return [x - 2, cy - 4, x + Math.max(3, w) + 1, cy + 4];
}

function verdictInk(p: Palette, verdict: string | null): { ink: string; soft: string } {
  const v = (verdict ?? "").toLowerCase();
  if (/refus|reject|fail|block/.test(v)) return { ink: p.fail, soft: p.failSoft };
  if (/escalat|required/.test(v)) return { ink: p.human, soft: p.humanSoft };
  if (/pass|approv|overrid/.test(v)) return { ink: p.pass, soft: p.passSoft };
  return { ink: p.fInkSoft, soft: p.ground };
}

/** A mark on a row: gates and verdicts as diamonds, people as down-triangles, failures as a stroke. */
function paintMark(c: Paint, m: TimelineMark, x: number, g: RowGeom): Box {
  const { ctx, p } = c;
  const cy = g.cy;
  switch (m.kind) {
    case "gate":
    case "review": {
      const { ink, soft } = verdictInk(p, m.verdict);
      diamond(ctx, x, cy, 4.6);
      ctx.fillStyle = soft;
      ctx.fill();
      ctx.strokeStyle = ink;
      ctx.lineWidth = 1.3;
      ctx.stroke();
      if ((m.verdict ?? "").toLowerCase().includes("overrid")) {
        // Let through on an override: a bar across the diamond, never a plain pass.
        ctx.beginPath();
        ctx.moveTo(x - 3, cy + 3);
        ctx.lineTo(x + 3, cy - 3);
        ctx.stroke();
      }
      return [x - 6, cy - 6, x + 6, cy + 6];
    }
    case "human": {
      triangleDown(ctx, x, cy, 4.6);
      const approved = (m.verdict ?? "").toLowerCase().includes("approv");
      if (approved) {
        ctx.fillStyle = p.human;
        ctx.fill();
      } else {
        ctx.fillStyle = p.humanSoft;
        ctx.fill();
        ctx.strokeStyle = p.human;
        ctx.lineWidth = 1.3;
        ctx.stroke();
      }
      return [x - 6, cy - 6, x + 6, cy + 6];
    }
    case "failure":
      ctx.fillStyle = p.fail;
      ctx.fillRect(Math.round(x) - 1, g.y + 3, 2, g.h - 6);
      return [x - 3, g.y + 2, x + 3, g.y + g.h - 2];
    case "interruption":
      haltCut(ctx, x, cy, 6, p);
      return [x - 4, cy - 7, x + 5, cy + 7];
    case "recovery":
      // The supervisor looked again at an execution. Only a recovery that found the outcome unknown says
      // anything was lost (the ring-query); the others (ended while unwatched, still running, a claim never
      // started, a takeover) interrupted nothing, so never the halt cut of a recorded stop.
      if (m.verdict === "outcome-unknown") {
        ringQuery(ctx, x, cy, 4.2, p.fInkSoft, p.ground);
        return [x - 5, cy - 5, x + 5, cy + 5];
      }
      ctx.strokeStyle = p.fInkSoft;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(x, cy, 3.4, Math.PI * 0.2, Math.PI * 1.8);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x, cy, 1.2, 0, Math.PI * 2);
      ctx.fillStyle = p.fInkSoft;
      ctx.fill();
      return [x - 5, cy - 5, x + 5, cy + 5];
    case "gap":
      ringQuery(ctx, x, cy, 4.2, p.fInkSoft, p.ground);
      return [x - 5, cy - 5, x + 5, cy + 5];
    case "retry":
    case "attempt": {
      // A revise visit (retry) in the ink; a further execution attempt (T13) in the quieter ink.
      ctx.strokeStyle = m.kind === "attempt" ? p.fInkSoft : p.fInk;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(x, cy, 3.6, -Math.PI * 0.35, Math.PI * 1.45);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x + 3.9, cy - 4.4);
      ctx.lineTo(x + 3.1, cy - 1.4);
      ctx.lineTo(x + 0.6, cy - 2.6);
      ctx.stroke();
      return [x - 5, cy - 5, x + 5, cy + 5];
    }
    case "merge": {
      ctx.beginPath();
      ctx.arc(x, cy, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = p.ground;
      ctx.fill();
      ctx.strokeStyle = p.pass;
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x, cy, 2.1, 0, Math.PI * 2);
      ctx.fillStyle = p.pass;
      ctx.fill();
      return [x - 6, cy - 6, x + 6, cy + 6];
    }
    case "wave":
      ctx.fillStyle = p.ground;
      ctx.strokeStyle = p.fInk;
      ctx.lineWidth = 1;
      ctx.fillRect(x - 4, cy - 5.5, 8, 11);
      ctx.strokeRect(x - 3.5, cy - 5, 7, 10);
      ctx.fillStyle = p.fInk;
      ctx.fillRect(x - 2, cy - 2, 4, 1);
      ctx.fillRect(x - 2, cy + 1, 4, 1);
      return [x - 5, cy - 6, x + 5, cy + 6];
  }
}

// ---------------------------------------------------------------- the frame

export interface DrawInput {
  readonly ctx: CanvasRenderingContext2D;
  readonly width: number;
  readonly height: number;
  readonly scrollTop: number;
  /** The rows intersecting the viewport (layout.slice). */
  readonly rows: readonly FlatRow[];
  readonly window: TimeWindow;
  readonly liveAt: number;
  readonly palette: Palette;
  /** Marks by track id (lane 0 of that track). */
  readonly marks: ReadonlyMap<string, readonly TimelineMark[]>;
  readonly selection: string | null;
  readonly highlighted: ReadonlySet<string>;
  /** Major tick times, for the sheet's vertical grid; UTC midnights, drawn heavier. */
  readonly grid: readonly number[];
  readonly dateLines: readonly number[];
  /** Spans that arrived moments ago, by id, with the opacity they are drawn at while they fade in. */
  readonly fresh?: ReadonlyMap<string, number>;
}

/** A row whose spans all lie outside the window: which side the nearest is on, and where to pan to see it. */
export interface EdgeChevron {
  readonly side: -1 | 1;
  readonly x: number;
  readonly cy: number;
  readonly spanId: string;
  readonly from: number;
  readonly to: number;
}

export interface DrawOutput {
  /** Per visible row, keyed `${trackId}#${lane}`: what was drawn, for hit-testing. */
  readonly plans: Map<string, RowPlan>;
  readonly ribbons: Map<string, RowPlan>;
  readonly summaries: Map<string, SubtreeColumns>;
  /** Empty rows' edge chevrons, keyed like `plans`. */
  readonly chevrons: Map<string, EdgeChevron>;
  /** Spans drawn one by one, spans looked at after culling, spans merged into runs and pips. */
  readonly drawn: number;
  readonly considered: number;
}

export const rowKey = (trackId: string, lane: number) => `${trackId}#${lane}`;

const summaryCache = new WeakMap<object, { key: string; cols: SubtreeColumns }>();

export function drawTracks(input: DrawInput): DrawOutput {
  const { ctx, width: W, height: H, scrollTop, palette: p, liveAt } = input;
  const scale = scaleOf(input.window, W);
  const xLive = Math.min(W + 40, Math.max(-40, xAt(scale, liveAt)));
  const later: (() => void)[] = [];
  const c: Paint = { ctx, p, scale, liveAt, xLive, base: 1, later };
  const chevrons = new Map<string, EdgeChevron>();
  const fresh = input.fresh;
  const plans = new Map<string, RowPlan>();
  const ribbons = new Map<string, RowPlan>();
  const summaries = new Map<string, SubtreeColumns>();
  let drawn = 0;
  let considered = 0;

  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  ctx.lineCap = "butt";
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
  ctx.fillStyle = p.ground;
  ctx.fillRect(0, 0, W, H);

  // Row grounds: group rows on a plate tint, quieter with depth; a hairline under every row.
  for (const row of input.rows) {
    const y = row.y - scrollTop;
    if (row.hasChildren && row.lane === 0) {
      ctx.globalAlpha = Math.max(0.35, 1 - row.node.depth * 0.25);
      ctx.fillStyle = p.plateLit;
      ctx.fillRect(0, y, W, row.height);
      ctx.globalAlpha = 1;
      ctx.fillStyle = p.gridMajor;
      ctx.fillRect(0, y, W, 1);
    }
    ctx.fillStyle = p.grid;
    ctx.fillRect(0, y + row.height - 1, W, 1);
  }

  // The sheet's grid: one hairline per major tick; date changes heavier.
  ctx.fillStyle = p.grid;
  for (const t of input.grid) {
    const x = Math.round(xAt(scale, t));
    if (x >= 0 && x <= W) ctx.fillRect(x, 0, 1, H);
  }
  ctx.fillStyle = p.gridMajor;
  for (const t of input.dateLines) {
    const x = Math.round(xAt(scale, t));
    if (x >= 0 && x <= W) ctx.fillRect(x, 0, 1, H);
  }

  // Nothing after the live edge.
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, Math.max(0, Math.min(W, xLive + 1)), H);
  ctx.clip();

  const selectedBoxes: Box[] = [];
  const selectedIds = new Set<string>();
  const highlightBoxes: Box[] = [];
  const ribbonBoxes: { box: Box; span: TimelineSpan }[] = [];
  const isSelected = (s: TimelineSpan) => input.selection !== null && (s.entity === input.selection || s.id === input.selection);
  const isHighlighted = (s: TimelineSpan) => input.highlighted.has(s.entity);

  for (const row of input.rows) {
    const y = row.y - scrollTop;
    const g = rowGeom(row, y);
    const node = row.node;
    const lane = node.lanes[row.lane];
    const marks = row.lane === 0 ? (input.marks.get(node.id) ?? []) : [];
    const collapsed = row.hasChildren && !row.expanded && row.lane === 0;

    // A collapsed group: a quiet density strip of its whole subtree, failures in the fail ink.
    if (collapsed) {
      const key = `${scale.from}|${scale.to}|${W}|${liveAt}`;
      let entry = summaryCache.get(node);
      if (!entry || entry.key !== key) {
        entry = { key, cols: subtreeColumns(node, scale, liveAt) };
        summaryCache.set(node, entry);
      }
      const cols = entry.cols;
      summaries.set(node.id, cols);
      const sy = g.cy + 3;
      for (let i = 0; i < cols.counts.length; i++) {
        const n = cols.counts[i]!;
        if (!n) continue;
        ctx.globalAlpha = runAlpha(n) * 0.8;
        ctx.fillStyle = cols.failed[i] ? p.fail : p.fInkSoft;
        ctx.fillRect(i * cols.bin, sy, cols.bin, 3);
      }
      ctx.globalAlpha = 1;
      // What happened beneath, as counts in the attention ink at the first failure in view: never a
      // failure mark on a group that did not itself fail.
      const said = countsWords(shownCounts(node));
      const tone = countsTone(shownCounts(node));
      if (said.length && tone && g.labelTop) {
        const x = cols.firstFail !== null ? Math.round(xAt(scale, cols.firstFail)) : 4;
        const font = `500 10px ${p.sans}`;
        ctx.font = font;
        const text = fit(ctx, font, said.join(", "), Math.min(W, xLive) - Math.max(4, x) - 6);
        if (text && x <= Math.min(W, xLive)) {
          const tx = Math.max(4, x);
          const tw = measure(ctx, font, text);
          ctx.fillStyle = p.ground;
          ctx.fillRect(tx - 3, g.labelY - 9, tw + 6, 12);
          ctx.fillStyle = tone === "fail" ? p.fail : tone === "halt" ? p.halt : p.inkMuted;
          ctx.fillText(text, tx, g.labelY);
        }
      }
    }

    const plan = lane ? planRow(lane.spans, marks, scale, liveAt) : marks.length ? planRow([], marks, scale, liveAt) : EMPTY_PLAN;
    plans.set(rowKey(node.id, row.lane), plan);
    considered += plan.considered;

    // Density runs first, under everything.
    for (const r of plan.runs) {
      ctx.globalAlpha = runAlpha(r.count);
      ctx.fillStyle = p.fInkSoft;
      ctx.fillRect(r.x0, g.cy - 3, Math.max(1, r.x1 - r.x0), 6);
    }
    ctx.globalAlpha = 1;

    const bodyCy = collapsed ? g.cy - 3 : g.cy;
    const gg: RowGeom = bodyCy === g.cy ? g : { ...g, cy: bodyCy };
    plan.items.forEach((item, i) => {
      const fade = fresh?.get(item.span.id);
      if (fade !== undefined) ctx.globalAlpha = c.base = fade;
      const painted = paintSpan(c, item, gg, plan.items[i + 1], true, plan.marks);
      if (fade !== undefined) ctx.globalAlpha = c.base = 1;
      drawn++;
      if (isSelected(item.span)) {
        selectedBoxes.push(painted.box);
        selectedIds.add(item.span.id);
      } else if (isHighlighted(item.span)) highlightBoxes.push(painted.box);
    });
    for (const item of plan.instants) {
      const fade = fresh?.get(item.span.id);
      if (fade !== undefined) ctx.globalAlpha = c.base = fade;
      const box = paintTick(c, item, g.cy);
      if (fade !== undefined) ctx.globalAlpha = c.base = 1;
      drawn++;
      if (isSelected(item.span)) {
        selectedBoxes.push(box);
        selectedIds.add(item.span.id);
      } else if (isHighlighted(item.span)) highlightBoxes.push(box);
    }
    for (const m of plan.marks) {
      const box = paintMark(c, m.mark, m.x, g);
      drawn++;
      if (m.mark.entity && (m.mark.entity === input.selection || m.mark.id === input.selection)) selectedBoxes.push(box);
    }
    // Count pips: instants too dense to draw one by one.
    if (plan.pips.length) {
      const font = `500 9px ${p.mono}`;
      ctx.font = font;
      plan.pips.forEach((pip, i) => {
        const x = Math.round((pip.x0 + pip.x1) / 2);
        ctx.fillStyle = p.fInk;
        ctx.fillRect(x - 1, g.cy - 3, 2, 6);
        const after = plan.pips[i + 1];
        const room = after ? (after.x0 + after.x1) / 2 - x - 8 : Infinity;
        if (pip.count > 1 && measure(ctx, font, String(pip.count)) <= room) {
          ctx.fillStyle = p.inkSubtle;
          ctx.fillText(String(pip.count), x + 4, g.cy + 3);
        }
      });
    }

    // The row's top-band labels and durations, over its marks (Paint.later).
    for (const paint of later) paint();
    later.length = 0;

    // A row with spans, none of them in view: a quiet chevron at the side the nearest lies on.
    if (lane && lane.spans.length && !plan.items.length && !plan.instants.length && !plan.runs.length && !plan.pips.length) {
      const ch = edgeChevron(lane.spans, scale, liveAt);
      if (ch) chevrons.set(rowKey(node.id, row.lane), { ...ch, x: ch.side < 0 ? 7 : Math.min(W, xLive) - 7, cy: g.cy });
    }

    // Ribbons: thin linked strips from the other hierarchy, under the row's own spans.
    if (g.ribbonY !== null) {
      const rplan = planRow(node.ribbons, [], scale, liveAt);
      ribbons.set(node.id, rplan);
      const ry = g.ribbonY;
      for (const r of rplan.runs) {
        ctx.globalAlpha = runAlpha(r.count) * 0.8;
        ctx.fillStyle = p.fInkSoft;
        ctx.fillRect(r.x0, ry, Math.max(1, r.x1 - r.x0), 3);
      }
      ctx.globalAlpha = 1;
      // Linked, not nested: a thin 2 px strip below the row's own body, hatched at both ends, so it never
      // reads as the row's own span. Where a visit outlives this execution (it went on under a later one),
      // the part after the execution's end is dotted.
      const ownEnd = node.kind === "execution" ? executionEnd(node, liveAt) : null;
      for (const item of rplan.items) {
        const tone = toneOf(item.span, item.times, liveAt);
        const ink = tone === "neutral" ? p.fInkSoft : toneInk(p, tone).ink;
        const x0 = Math.round(item.x0);
        const x1 = Math.max(x0 + 2, Math.round(item.x1));
        const xEnd = ownEnd !== null ? Math.round(xAt(scale, ownEnd)) : null;
        const cut = xEnd !== null && xEnd > x0 && xEnd < x1 - 2 ? xEnd : x1;
        ctx.fillStyle = ink;
        ctx.globalAlpha = 0.6;
        if (item.times.open && cut === x1) {
          const fade = Math.min(18, (x1 - x0) / 2);
          ctx.fillRect(x0, ry + 1, x1 - x0 - fade, 2);
          const step = fade / FADE_STEPS.length;
          FADE_STEPS.forEach((a, i) => {
            ctx.globalAlpha = a * 0.6;
            ctx.fillRect(x1 - fade + i * step, ry + 1, step, 2);
          });
        } else ctx.fillRect(x0, ry + 1, cut - x0, 2);
        if (cut < x1) {
          ctx.globalAlpha = 0.6;
          for (let x = cut + 1; x < x1; x += 3) ctx.fillRect(x, ry + 1, 1, 2);
        }
        ctx.globalAlpha = 0.9;
        // Hatched ends: two short slashes at each end of the strip.
        ctx.strokeStyle = ink;
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (const x of x1 - x0 >= 8 ? [x0 + 1, x0 + 4, x1 - 4, x1 - 1] : [x0 + 1]) {
          ctx.moveTo(x - 1.5, ry + 4);
          ctx.lineTo(x + 1.5, ry - 1);
        }
        ctx.stroke();
        ctx.globalAlpha = 1;
        ribbonBoxes.push({ box: [x0, ry, x1, ry + 3], span: item.span });
        drawn++;
      }
      considered += rplan.considered;
    }
  }

  // Cross-track highlight: the store's related set, a select underline.
  ctx.fillStyle = p.select;
  ctx.globalAlpha = 0.75;
  for (const [x0, , x1, y1] of highlightBoxes) ctx.fillRect(x0, y1 + 1, Math.max(2, x1 - x0), 1);
  ctx.globalAlpha = 1;

  // Ribbon counterparts of the selection: outlined, and joined to it by a 1 px connector.
  const counterparts = ribbonBoxes.filter((r) => selectedIds.has(r.span.id) || isSelected(r.span));
  ctx.strokeStyle = p.select;
  ctx.lineWidth = 1;
  for (const { box } of counterparts) {
    ctx.strokeRect(box[0] - 1.5, box[1] - 1.5, box[2] - box[0] + 3, box[3] - box[1] + 3);
    const from = selectedBoxes[0];
    if (!from) continue;
    const x = Math.round(Math.max(from[0], box[0])) + 0.5;
    const ya = from[1] > box[3] ? from[1] : from[3];
    const yb = from[1] > box[3] ? box[3] + 2 : box[1] - 2;
    ctx.beginPath();
    ctx.moveTo(x, ya + (ya < yb ? 2 : -2));
    ctx.lineTo(x, yb);
    ctx.stroke();
    ctx.fillStyle = p.select;
    ctx.fillRect(x - 1.5, yb - 1.5, 3, 3);
  }

  // Selection: a 2 px outline in the selection ink, and the corner brackets as everywhere in the Living Factory.
  ctx.strokeStyle = p.select;
  ctx.lineWidth = 2;
  for (const b of selectedBoxes) ctx.strokeRect(Math.round(b[0]) - 1, Math.round(b[1]) - 1, Math.round(b[2] - b[0]) + 2, Math.round(b[3] - b[1]) + 2);
  for (const b of selectedBoxes) brackets(ctx, Math.round(b[0]) - 4.5, Math.round(b[1]) - 3.5, Math.round(b[2]) + 4.5, Math.round(b[3]) + 3.5, p.select);

  ctx.restore();

  // Chevrons sit on the edges, outside the live-edge clip (the right one stands just inside it).
  ctx.strokeStyle = p.fInkSoft;
  ctx.lineWidth = 1.3;
  ctx.globalAlpha = 0.8;
  for (const ch of chevrons.values()) {
    ctx.beginPath();
    ctx.moveTo(ch.x - 2 * ch.side, ch.cy - 4);
    ctx.lineTo(ch.x + 2 * ch.side, ch.cy);
    ctx.lineTo(ch.x - 2 * ch.side, ch.cy + 4);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  return { plans, ribbons, summaries, chevrons, drawn, considered };
}

/** The end of an execution row's own execution span as held at liveAt, or null while it is open. */
export function executionEnd(node: FlatRow["node"], liveAt: number): number | null {
  for (const lane of node.lanes) {
    for (const span of lane.spans) {
      if (span.kind !== "execution" || !span.end) continue;
      const t = span.end.at ?? span.end.notAfter;
      return t !== null && t <= liveAt ? t : null;
    }
  }
  return null;
}

/** Whether a ribbon visit outlives its execution (it continued under a later one). Pure. */
export function outlivesExecution(node: FlatRow["node"], ribbon: TimelineSpan, liveAt: number): boolean {
  const end = executionEnd(node, liveAt);
  if (end === null) return false;
  const t = spanTimes(ribbon, liveAt);
  return t !== null && t.to > end + 1000;
}

export function brackets(ctx: Ctx, x0: number, y0: number, x1: number, y1: number, color: string) {
  const arm = Math.min(7, Math.max(3, (x1 - x0) / 3));
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(x0, y0 + arm);
  ctx.lineTo(x0, y0);
  ctx.lineTo(x0 + arm, y0);
  ctx.moveTo(x1 - arm, y0);
  ctx.lineTo(x1, y0);
  ctx.lineTo(x1, y0 + arm);
  ctx.moveTo(x1, y1 - arm);
  ctx.lineTo(x1, y1);
  ctx.lineTo(x1 - arm, y1);
  ctx.moveTo(x0 + arm, y1);
  ctx.lineTo(x0, y1);
  ctx.lineTo(x0, y1 - arm);
  ctx.stroke();
}

/** The box the hover outline draws around a hit, in canvas px. */
export function hitBox(row: FlatRow, y: number, from: number, to: number, kind: SpanKind | null, window: TimeWindow, width: number): Box {
  const scale = scaleOf(window, width);
  const g = rowGeom(row, y);
  const th = kind ? THICKNESS[familyOf(kind)] : 6;
  const half = Math.max(th / 2, 3) + 3;
  const cy = row.hasChildren && !row.expanded && row.lane === 0 ? g.cy - 3 : g.cy;
  const x0 = xAt(scale, from);
  const x1 = Math.max(x0 + 2, xAt(scale, to));
  return [x0 - 2, cy - half, x1 + 2, cy + half];
}


/**
 * For a lane none of whose spans is in the window: the nearest span and the side it lies on. Pure.
 * Null when the lane holds nothing known by `liveAt`, or something is in view.
 */
export function edgeChevron(spans: readonly TimelineSpan[], scale: Scale, liveAt: number): Omit<EdgeChevron, "x" | "cy"> | null {
  const index = laneIndex(spans);
  const n = index.spans.length;
  // The first span starting after the window (binary search on starts); everything before it starts in or before the window.
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (index.starts[mid]! <= scale.to) lo = mid + 1;
    else hi = mid;
  }
  const split = lo;
  if (split > 0 && index.maxTo[split - 1]! >= scale.from) return null; // something reaches into the window
  let before: { span: TimelineSpan; from: number; to: number } | null = null;
  // The span that ends latest before the window: the prefix maximum's owner, found by a short scan back.
  for (let i = split - 1, k = 0; i >= 0 && k < 256; i--, k++) {
    const t = spanTimes(index.spans[i]!, liveAt);
    if (t && (!before || t.to > before.to)) before = { span: index.spans[i]!, from: t.from, to: t.to };
    if (before && before.to >= index.maxTo[split - 1]!) break;
  }
  let after: { span: TimelineSpan; from: number; to: number } | null = null;
  if (split < n) {
    const t = spanTimes(index.spans[split]!, liveAt);
    if (t) after = { span: index.spans[split]!, from: t.from, to: t.to };
  }
  const pick = before && after ? (scale.from - before.to <= after.from - scale.to ? before : after) : (before ?? after);
  if (!pick) return null;
  return { side: pick === before ? -1 : 1, spanId: pick.span.id, from: pick.from, to: pick.to };
}
