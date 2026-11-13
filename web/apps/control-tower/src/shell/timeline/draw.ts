/**
 * Canvas drawing for the timeline tracks: one canvas for all rows, so 690 tool calls and 93 agents
 * cost a few draw calls, not DOM nodes. Colours come from the design tokens (CSS variables read at
 * draw time), so both themes work and nothing is hard-coded.
 */
import type { AnyRef, EntityRef } from "../../sim";
import { GATE_STATE_WORDS, STATION_WORDS, outcomeState } from "../vocab";
import type { AgentItem, Track, TimelineModel } from "./model";

export const ROW = { factory: 26, main: 32, agent: 13, pad: 6 } as const;

export interface Palette {
  line: string;
  lineStrong: string;
  ink: string;
  inkMuted: string;
  inkSubtle: string;
  fInk: string;
  fInkSoft: string;
  route: string;
  plateEdge: string;
  surface: string;
  gridMajor: string;
  live: string;
  liveSoft: string;
  pass: string;
  passSoft: string;
  fail: string;
  failSoft: string;
  wait: string;
  waitSoft: string;
  human: string;
  humanSoft: string;
  select: string;
  sans: string;
  mono: string;
}

export function readPalette(el: Element): Palette {
  const cs = getComputedStyle(el);
  const v = (name: string) => cs.getPropertyValue(name).trim();
  const f = (name: string) => v(`--mach-factory-${name}`);
  return {
    line: v("--mach-line"),
    lineStrong: v("--mach-line-strong"),
    ink: v("--mach-ink"),
    inkMuted: v("--mach-ink-muted"),
    inkSubtle: v("--mach-ink-subtle"),
    fInk: f("ink"),
    fInkSoft: f("ink-soft"),
    route: f("route"),
    plateEdge: f("plate-edge"),
    surface: v("--mach-surface"),
    gridMajor: f("grid-major"),
    live: f("live"),
    liveSoft: f("live-soft"),
    pass: f("pass"),
    passSoft: f("pass-soft"),
    fail: f("fail"),
    failSoft: f("fail-soft"),
    wait: f("wait"),
    waitSoft: f("wait-soft"),
    human: f("human"),
    humanSoft: f("human-soft"),
    select: f("select"),
    sans: v("--mach-font-sans") || "sans-serif",
    mono: v("--mach-font-mono") || "monospace",
  };
}

export interface TrackLayout {
  track: Track;
  y: number;
  height: number;
  expanded: boolean;
  /** Drawn as one thin strip of the summary row. */
  summary?: boolean;
}

/** Height of the summary row: every slice's track as a thin strip, one above the other. */
export const SUMMARY_ROW = 38;

export function layoutTracks(model: TimelineModel, expanded: ReadonlySet<string>, summary = false): { rows: TrackLayout[]; height: number } {
  if (summary) {
    const slices = model.tracks.filter((t) => t.kind === "slice");
    const strip = Math.max(3, Math.min(6, Math.floor((SUMMARY_ROW - 8) / Math.max(1, slices.length))));
    let y = Math.floor((SUMMARY_ROW - strip * slices.length) / 2);
    const rows = slices.map((track) => {
      const row = { track, y, height: strip, expanded: false, summary: true };
      y += strip;
      return row;
    });
    return { rows, height: SUMMARY_ROW };
  }
  let y = 0;
  const rows = model.tracks.map((track) => {
    const open = expanded.has(track.id) && track.agentRows > 0;
    const height = track.kind === "factory" ? ROW.factory : ROW.main + (open ? track.agentRows * ROW.agent + ROW.pad : 0);
    const row = { track, y, height, expanded: open };
    y += height;
    return row;
  });
  return { rows, height: y };
}

export interface View {
  v0: number;
  v1: number;
  width: number;
}
const xOf = (view: View, t: number) => ((t - view.v0) / (view.v1 - view.v0)) * view.width;
const tOf = (view: View, x: number) => view.v0 + (x / view.width) * (view.v1 - view.v0);
export { xOf, tOf };

function stateColors(p: Palette, outcome: Parameters<typeof outcomeState>[0]): { ink: string; soft: string } {
  switch (outcomeState(outcome)) {
    case "failed":
      return { ink: p.fail, soft: p.failSoft };
    case "human":
      return { ink: p.human, soft: p.humanSoft };
    case "active":
      return { ink: p.live, soft: p.liveSoft };
    case "idle":
      return { ink: p.fInkSoft, soft: p.surface };
    default:
      return { ink: p.pass, soft: p.passSoft };
  }
}

function gateColors(p: Palette, state: string): { ink: string; soft: string } {
  switch (state) {
    case "passed":
      return { ink: p.pass, soft: p.passSoft };
    case "overridden":
      // Let through on an override: the pass ink, and a bar across the diamond (drawn below), never a plain pass.
      return { ink: p.pass, soft: p.surface };
    case "failed":
      return { ink: p.fail, soft: p.failSoft };
    case "waiting":
      return { ink: p.human, soft: p.humanSoft };
    case "open":
      return { ink: p.live, soft: p.liveSoft };
    default:
      return { ink: p.fInkSoft, soft: p.surface };
  }
}

function diamond(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x, y - r);
  ctx.lineTo(x + r, y);
  ctx.lineTo(x, y + r);
  ctx.lineTo(x - r, y);
  ctx.closePath();
}

function triangleDown(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x - r, y - r * 0.8);
  ctx.lineTo(x + r, y - r * 0.8);
  ctx.lineTo(x, y + r * 0.9);
  ctx.closePath();
}

function head(ctx: CanvasRenderingContext2D, model: AgentItem["agent"]["model"], x: number, y: number) {
  ctx.beginPath();
  if (model === "fable") {
    ctx.moveTo(x, y - 4.2);
    ctx.lineTo(x + 3.4, y);
    ctx.lineTo(x, y + 4.2);
    ctx.lineTo(x - 3.4, y);
    ctx.closePath();
  } else if (model === "opus") ctx.rect(x - 3, y - 3, 6, 6);
  else if (model === "sonnet") ctx.arc(x, y, 3.2, 0, Math.PI * 2);
  else {
    ctx.moveTo(x, y - 3.6);
    ctx.lineTo(x + 3.4, y + 2.6);
    ctx.lineTo(x - 3.4, y + 2.6);
    ctx.closePath();
  }
}

function brackets(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, color: string) {
  const arm = Math.min(8, Math.max(3, (x1 - x0) / 3));
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.75;
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

export interface DrawInput {
  ctx: CanvasRenderingContext2D;
  model: TimelineModel;
  rows: TrackLayout[];
  view: View;
  height: number;
  palette: Palette;
  selection: EntityRef | null;
  hovered: EntityRef | null;
  highlighted: ReadonlySet<EntityRef>;
  focusedTrack: string | null;
  /** Chapter start times: faint guides through every track. */
  chapters: readonly number[];
  /** The live edge: a visit that has not ended by then is drawn as work in progress, with no outcome. */
  liveAt: number;
  /** Where open spans are drawn to: the run's end (simulation, hidden by the mask) or the live edge (real history). */
  openEnd?: number;
}

/** Draw every track. The live edge is a DOM mask laid over this, so the canvas is redrawn only when its inputs change. */
export function drawTracks(input: DrawInput): void {
  const { ctx, rows, view, palette: p, height, selection, hovered, highlighted, focusedTrack } = input;
  const W = view.width;
  ctx.clearRect(0, 0, W, height);
  const end = input.openEnd ?? input.model.end;
  const span = (t: number | null) => xOf(view, t ?? end);

  // Chapter guides.
  ctx.strokeStyle = p.gridMajor;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const t of input.chapters) {
    const x = Math.round(xOf(view, t)) + 0.5;
    if (x < 0 || x > W) continue;
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
  }
  ctx.stroke();

  const boxes: { selected: Box | null; hovered: Box | null } = { selected: null, hovered: null };
  const union = (a: Box | null, b: Box): Box => (a ? [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])] : b);
  const note = (r: AnyRef | null, box: Box) => {
    if (!r) return;
    if (r === (selection as string | null)) boxes.selected = union(boxes.selected, box);
    if (r === (hovered as string | null)) boxes.hovered = union(boxes.hovered, box);
  };

  for (const row of rows) {
    const { track, y } = row;
    // Row separators and the related-set band.
    if (highlighted.has(track.ref) || (track.sliceId && highlighted.has(`slice:${track.sliceId}` as EntityRef))) {
      ctx.save();
      ctx.globalAlpha = 0.07;
      ctx.fillStyle = p.select;
      ctx.fillRect(0, y, W, row.height);
      ctx.restore();
    }
    if (focusedTrack === track.id) {
      ctx.strokeStyle = p.lineStrong;
      ctx.setLineDash([2, 3]);
      ctx.strokeRect(0.5, y + 0.5, W - 1, row.height - 1);
      ctx.setLineDash([]);
    }
    if (row.summary) {
      drawStrip(ctx, track, y, row.height, view, p, note, input.liveAt, end);
      continue;
    }
    ctx.fillStyle = p.line;
    ctx.fillRect(0, y + row.height - 1, W, 1);

    if (track.kind === "factory") {
      drawFactory(ctx, track, y, view, p, note);
      continue;
    }

    const cy = y + 18;
    // The belt line from the cell's first station to its last.
    if (track.stations.length) {
      const first = track.stations[0];
      const last = track.stations[track.stations.length - 1];
      if (first && last) {
        ctx.fillStyle = p.route;
        ctx.fillRect(xOf(view, first.start), cy - 0.5, span(last.end) - xOf(view, first.start), 1);
      }
    }

    // Waiting periods.
    for (const w of track.waits) {
      const x0 = xOf(view, w.start);
      const x1 = span(w.end);
      if (x1 < 0 || x0 > W) continue;
      if (w.kind === "dependency") {
        ctx.fillStyle = p.waitSoft;
        ctx.fillRect(x0, cy - 3, x1 - x0, 6);
        ctx.strokeStyle = p.wait;
        ctx.lineWidth = 1.25;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(x0, cy + 0.5);
        ctx.lineTo(x1, cy + 0.5);
        ctx.stroke();
        ctx.setLineDash([]);
        // A padlock-like stop at the start.
        ctx.fillStyle = p.wait;
        ctx.fillRect(x0, cy - 5, 1.5, 10);
        if (x1 - x0 > 150) {
          ctx.font = `10px ${p.sans}`;
          ctx.fillStyle = p.wait;
          ctx.fillText("Waiting on a dependency", Math.max(x0, 0) + 6, y + 11);
        }
      } else {
        ctx.strokeStyle = p.fInkSoft;
        ctx.lineWidth = 1;
        ctx.setLineDash([1, 2.5]);
        ctx.beginPath();
        ctx.moveTo(x0, cy + 0.5);
        ctx.lineTo(x1, cy + 0.5);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      note(w.ref, [x0, cy - 5, x1, cy + 5]);
    }

    // Station visits: a bar in the state's tint with its ink at both ends.
    ctx.font = `600 10px ${p.sans}`;
    for (const s of track.stations) {
      const x0 = xOf(view, s.start);
      const x1 = Math.max(x0 + 2, span(s.end));
      if (x1 < 0 || x0 > W) continue;
      const ended = s.end !== null && s.end <= input.liveAt;
      const c = stateColors(p, ended ? s.outcome : null);
      ctx.fillStyle = c.soft;
      ctx.fillRect(x0, cy - 4, x1 - x0, 8);
      ctx.strokeStyle = c.ink;
      ctx.lineWidth = 1;
      ctx.strokeRect(x0 + 0.5, cy - 3.5, x1 - x0 - 1, 7);
      ctx.fillStyle = c.ink;
      ctx.fillRect(x0, cy - 5.5, 2, 11);
      if (ended) ctx.fillRect(x1 - 2, cy - 5.5, 2, 11);
      const word = STATION_WORDS[s.station];
      const label = s.round > 1 ? `${word} ×${s.round}` : word;
      const w = ctx.measureText(label).width;
      if (x1 - x0 > w + 6) {
        ctx.fillStyle = p.inkMuted;
        ctx.fillText(word, Math.max(x0, 0) + 1, y + 10);
        if (s.round > 1) {
          ctx.fillStyle = p.fail;
          ctx.fillText(` ×${s.round}`, Math.max(x0, 0) + 1 + ctx.measureText(word).width, y + 10);
        }
      }
      note(s.ref, [x0, cy - 6, x1, cy + 6]);
    }

    // Artifacts: hairline ticks along the bottom edge.
    ctx.fillStyle = p.fInkSoft;
    for (const a of track.artifacts) {
      const x = xOf(view, a.t);
      if (x < 0 || x > W) continue;
      ctx.fillRect(Math.round(x), y + 26, 1, 3);
      note(a.ref, [x - 2, y + 25, x + 2, y + 30]);
    }

    // Gates: diamonds on the line, in the decision's ink.
    for (const g of track.gates) {
      const x = xOf(view, g.t);
      if (x < -6 || x > W + 6) continue;
      const c = gateColors(p, g.state);
      diamond(ctx, x, cy, 4.2);
      ctx.fillStyle = g.state === "skipped" ? p.surface : c.soft;
      ctx.fill();
      ctx.strokeStyle = c.ink;
      ctx.lineWidth = 1.3;
      ctx.stroke();
      if (g.state === "overridden") {
        ctx.beginPath();
        ctx.moveTo(x - 3, cy + 3);
        ctx.lineTo(x + 3, cy - 3);
        ctx.stroke();
      }
      note(g.ref, [x - 5, cy - 5, x + 5, cy + 5]);
    }

    // Failures through the track, people's acts, merges.
    for (const m of track.marks) {
      const x = xOf(view, m.t);
      if (x < -6 || x > W + 6) continue;
      if (m.kind === "fail") {
        ctx.fillStyle = p.fail;
        ctx.fillRect(Math.round(x) - 1, y + 3, 2, ROW.main - 6);
        note(m.ref, [x - 3, y + 3, x + 3, y + ROW.main - 3]);
      } else if (m.kind === "person") {
        triangleDown(ctx, x, y + 26.5, 4);
        ctx.fillStyle = p.human;
        ctx.fill();
        note(m.ref, [x - 5, y + 22, x + 5, y + 31]);
      } else if (m.kind === "merge") {
        ctx.beginPath();
        ctx.arc(x, cy, 4.5, 0, Math.PI * 2);
        ctx.fillStyle = p.surface;
        ctx.fill();
        ctx.strokeStyle = p.pass;
        ctx.lineWidth = 1.2;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(x, cy, 2.2, 0, Math.PI * 2);
        ctx.fillStyle = p.pass;
        ctx.fill();
        note(m.ref, [x - 6, cy - 6, x + 6, cy + 6]);
      }
    }

    for (const ex of track.executions) note(ex.ref, [xOf(view, ex.start), y + 3, span(ex.end), y + ROW.main - 3]);
    note(track.ref, [Math.max(-4, xOf(view, track.stations[0]?.start ?? track.waits[0]?.start ?? 0)), y + 2, Math.min(W + 4, span(track.stations[track.stations.length - 1]?.end ?? track.waits[track.waits.length - 1]?.end ?? null)), y + ROW.main - 2]);

    if (row.expanded) drawAgents(ctx, track, y + ROW.main, view, p, note, end, input.liveAt);
  }

  if (boxes.hovered && hovered !== selection) {
    const [x0, y0, x1, y1] = boxes.hovered;
    ctx.strokeStyle = p.ink;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.6;
    ctx.strokeRect(Math.round(x0) - 1.5, Math.round(y0) - 1.5, Math.round(x1 - x0) + 3, Math.round(y1 - y0) + 3);
    ctx.globalAlpha = 1;
  }
  if (boxes.selected) {
    const [x0, y0, x1, y1] = boxes.selected;
    brackets(ctx, Math.round(x0) - 3.5, Math.round(y0) - 2.5, Math.round(x1) + 3.5, Math.round(y1) + 2.5, p.select);
  }
}

type Box = [number, number, number, number];
type Note = (r: AnyRef | null, box: Box) => void;

/**
 * One slice's track as a strip of the summary row: its station visits in their state's tint (an
 * outcome only once the live edge has passed its end), its waits as a dashed line, its failures as a
 * stroke across the strip.
 */
function drawStrip(ctx: CanvasRenderingContext2D, track: Track, y: number, h: number, view: View, p: Palette, note: Note, liveAt: number, end: number) {
  const W = view.width;
  const span = (t: number | null) => xOf(view, t ?? end);
  const inner = Math.max(1, h - 2);
  for (const w of track.waits) {
    const x0 = xOf(view, w.start);
    const x1 = span(w.end);
    if (x1 < 0 || x0 > W) continue;
    ctx.strokeStyle = w.kind === "dependency" ? p.wait : p.fInkSoft;
    ctx.lineWidth = 1;
    ctx.setLineDash(w.kind === "dependency" ? [3, 2] : [1, 2]);
    ctx.beginPath();
    ctx.moveTo(x0, y + h / 2);
    ctx.lineTo(x1, y + h / 2);
    ctx.stroke();
    ctx.setLineDash([]);
    note(w.ref, [x0, y, x1, y + h]);
  }
  for (const s of track.stations) {
    const x0 = xOf(view, s.start);
    const x1 = Math.max(x0 + 1.5, span(s.end));
    if (x1 < 0 || x0 > W) continue;
    const ended = s.end !== null && s.end <= liveAt;
    const c = stateColors(p, ended ? s.outcome : null);
    ctx.fillStyle = c.soft;
    ctx.fillRect(x0, y + 1, x1 - x0, inner);
    ctx.fillStyle = c.ink;
    ctx.fillRect(x0, y + 1, 1.5, inner);
    if (ended) ctx.fillRect(x1 - 1.5, y + 1, 1.5, inner);
    note(s.ref, [x0, y, x1, y + h]);
  }
  for (const m of track.marks) {
    if (m.kind !== "fail") continue;
    const x = xOf(view, m.t);
    if (x < -2 || x > W + 2) continue;
    ctx.fillStyle = p.fail;
    ctx.fillRect(Math.round(x) - 1, y, 2, h);
  }
  note(track.ref, [Math.max(-4, xOf(view, track.stations[0]?.start ?? track.waits[0]?.start ?? 0)), y, Math.min(W + 4, span(track.stations[track.stations.length - 1]?.end ?? track.waits[track.waits.length - 1]?.end ?? null)), y + h]);
}

function drawFactory(ctx: CanvasRenderingContext2D, track: Track, y: number, view: View, p: Palette, note: Note) {
  const cy = y + 13;
  for (const m of track.marks) {
    const x = xOf(view, m.t);
    if (x < -6 || x > view.width + 6) continue;
    switch (m.kind) {
      case "person":
        triangleDown(ctx, x, cy, 5);
        ctx.fillStyle = p.human;
        ctx.fill();
        break;
      case "attention":
        triangleDown(ctx, x, cy, 5);
        ctx.strokeStyle = p.human;
        ctx.lineWidth = 1.3;
        ctx.stroke();
        break;
      case "wave":
        ctx.fillStyle = p.surface;
        ctx.strokeStyle = p.fInk;
        ctx.lineWidth = 1;
        ctx.fillRect(x - 4, cy - 6, 8, 11);
        ctx.strokeRect(x - 3.5, cy - 5.5, 7, 10);
        ctx.fillStyle = p.fInk;
        ctx.fillRect(x - 2, cy - 2, 4, 1);
        ctx.fillRect(x - 2, cy + 1, 4, 1);
        break;
      case "decision":
        diamond(ctx, x, cy, 3);
        ctx.strokeStyle = p.fInkSoft;
        ctx.lineWidth = 1;
        ctx.stroke();
        break;
      case "integrated":
        ctx.beginPath();
        ctx.arc(x, cy, 4.5, 0, Math.PI * 2);
        ctx.strokeStyle = p.pass;
        ctx.lineWidth = 1.2;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(x, cy, 2.2, 0, Math.PI * 2);
        ctx.fillStyle = p.pass;
        ctx.fill();
        break;
      default:
        break;
    }
    note(m.ref, [x - 6, cy - 6, x + 6, cy + 6]);
  }
}

function drawAgents(ctx: CanvasRenderingContext2D, track: Track, top: number, view: View, p: Palette, note: Note, end: number, liveAt: number) {
  const W = view.width;
  const msPerPx = (view.v1 - view.v0) / W;
  for (const a of track.agents) {
    const ry = top + a.row * ROW.agent;
    const cy = ry + ROW.agent / 2;
    const x0 = xOf(view, a.start);
    const x1 = Math.max(x0 + 1, xOf(view, a.end ?? end));
    if (x1 < 0 || x0 > W) continue;
    ctx.fillStyle = p.fInkSoft;
    ctx.globalAlpha = 0.55;
    ctx.fillRect(x0, cy - 1, x1 - x0, 2);
    ctx.globalAlpha = 1;
    // Tool calls: one tick per call (a span when there is room to show its length).
    for (const t of a.tools) {
      const tx0 = xOf(view, t.start);
      if (tx0 < -2 || tx0 > W + 2) continue;
      const tx1 = xOf(view, t.end ?? end);
      // A failure is known only from the call's end: before the live edge passes it, the call is plain work.
      ctx.fillStyle = t.failedAt !== null && t.failedAt <= liveAt ? p.fail : p.fInk;
      if (tx1 - tx0 >= 4) {
        ctx.globalAlpha = 0.35;
        ctx.fillRect(tx0, cy - 2.5, tx1 - tx0, 5);
        ctx.globalAlpha = 1;
      }
      ctx.fillRect(Math.round(tx0), cy - 4.5, msPerPx < 400 ? 1.5 : 1, 9);
      note(t.ref, [tx0 - 1, cy - 5, Math.max(tx1, tx0 + 1) + 1, cy + 5]);
    }
    // A Dynamic Workflow agent's calls are not observable: its count and last tool, as words on its span.
    if (a.agent.observation === "count-only" && a.agent.toolCallCount !== null && x1 - x0 > 70) {
      ctx.font = `10px ${p.sans}`;
      ctx.fillStyle = p.inkMuted;
      ctx.fillText(`${a.agent.toolCallCount} calls${a.agent.lastTool ? `, last ${a.agent.lastTool}` : ""}`, Math.max(x0, 0) + 7, cy - 2);
    }
    head(ctx, a.agent.model, x0, cy);
    ctx.fillStyle = p.surface;
    ctx.fill();
    ctx.strokeStyle = p.fInk;
    ctx.lineWidth = 1.1;
    ctx.stroke();
    note(a.ref, [x0 - 4, cy - 5, x1, cy + 5]);
  }
}

/** ", times placed, not measured" when the observer placed a visit's start or end rather than a record measuring it. */
function placed(s: { startQuality: string; endQuality: string }): string {
  if (s.startQuality === "inferred" || s.endQuality === "inferred") return ". Times placed by the observer, not measured";
  return s.startQuality === "measured" ? ". Times measured" : "";
}

export interface Hit {
  ref: AnyRef | null;
  trackId: string;
  title: string;
  detail: string;
  start: number;
  end: number | null;
}

/** What is under the pointer: the most specific thing at (x, y), else the track. */
export function hitTest(rows: TrackLayout[], view: View, x: number, y: number, end: number, liveAt = end): Hit | null {
  // Nothing after the live edge is known: a span still open there reads as open, with no outcome.
  const known = (e: number | null) => (e !== null && e <= liveAt ? e : null);
  // In the summary row the strips are thin: the pad above and below belongs to the nearest one.
  const row =
    rows.find((r) => y >= r.y && y < r.y + r.height) ??
    (rows[0]?.summary ? rows.reduce((best, r) => (Math.abs(r.y + r.height / 2 - y) < Math.abs(best.y + best.height / 2 - y) ? r : best)) : undefined);
  if (!row) return null;
  const { track } = row;
  const t = tOf(view, x);
  const slack = (view.v1 - view.v0) / view.width; // ms per px
  const near = (at: number, px: number) => Math.abs(at - t) <= px * slack;
  const local = y - row.y;

  if (row.summary) {
    for (const s of track.stations) {
      if (t >= s.start - slack && t <= (s.end ?? end) + slack) {
        const ended = known(s.end);
        return { ref: s.ref, trackId: track.id, title: `${track.ticketId ?? track.sliceId}: ${STATION_WORDS[s.station]}, round ${s.round}`, detail: `${ended !== null && s.outcome ? `Ended: ${s.outcome}` : "At work"}${placed(s)}`, start: s.start, end: ended };
      }
    }
    for (const w of track.waits) {
      if (t >= w.start && t <= (w.end ?? end)) return { ref: w.ref, trackId: track.id, title: w.kind === "dependency" ? "Waiting on a dependency" : "Eligible, not yet dispatched", detail: track.sliceId ?? "", start: w.start, end: known(w.end) };
    }
    return { ref: track.ref, trackId: track.id, title: track.ticketId ?? track.title, detail: track.title, start: t, end: t };
  }

  if (track.kind === "factory") {
    const m = [...track.marks].sort((a, b) => Math.abs(a.t - t) - Math.abs(b.t - t))[0];
    if (m && near(m.t, 6)) return { ref: m.ref, trackId: track.id, title: m.text, detail: "", start: m.t, end: m.t };
    return { ref: track.ref, trackId: track.id, title: "Factory", detail: "People's acts, the scheduler's decisions and integrations", start: t, end: t };
  }

  if (row.expanded && local >= ROW.main) {
    const r = Math.floor((local - ROW.main) / ROW.agent);
    const agents = track.agents.filter((a) => a.row === r);
    for (const a of agents) {
      if (t < a.start - 4 * slack || t > (a.end ?? end) + slack) continue;
      const tool = a.tools.find((c) => t >= c.start - 2 * slack && t <= (c.end ?? end) + 2 * slack);
      if (tool) return { ref: tool.ref, trackId: track.id, title: `${tool.tool} ${tool.target}`, detail: `${a.agent.label}`, start: tool.start, end: known(tool.end) };
      if (a.agent.observation === "count-only") {
        const n = a.agent.toolCallCount;
        return { ref: a.ref, trackId: track.id, title: a.agent.label, detail: `${n === null ? "Tool calls not reported yet" : `${n} tool call${n === 1 ? "" : "s"} (a count; each call is not observable)`}${a.agent.lastTool ? `, last ${a.agent.lastTool}` : ""}`, start: a.start, end: known(a.end) };
      }
      const calls = a.tools.filter((c) => c.start <= liveAt).length;
      return { ref: a.ref, trackId: track.id, title: a.agent.label, detail: `${calls} tool call${calls === 1 ? "" : "s"}, ${a.agent.model}`, start: a.start, end: known(a.end) };
    }
    return null;
  }

  for (const g of track.gates) if (near(g.t, 5)) return { ref: g.ref, trackId: track.id, title: g.ref.slice(5), detail: `Gate ${GATE_STATE_WORDS[g.state].toLowerCase()}`, start: g.t, end: g.t };
  for (const m of track.marks) if (near(m.t, 4)) return { ref: m.ref, trackId: track.id, title: m.text, detail: "", start: m.t, end: m.t };
  if (local > 24) {
    const a = track.artifacts.find((x) => near(x.t, 2));
    if (a) return { ref: a.ref, trackId: track.id, title: a.label, detail: "Artifact written", start: a.t, end: a.t };
  }
  for (const s of track.stations) {
    if (t >= s.start - slack && t <= (s.end ?? end) + slack) {
      const ended = known(s.end);
      return { ref: s.ref, trackId: track.id, title: `${STATION_WORDS[s.station]}, round ${s.round}`, detail: `${ended !== null && s.outcome ? `Ended: ${s.outcome}` : "At work"}${placed(s)}`, start: s.start, end: ended };
    }
  }
  for (const w of track.waits) {
    if (t >= w.start && t <= (w.end ?? end)) return { ref: w.ref, trackId: track.id, title: w.kind === "dependency" ? "Waiting on a dependency" : "Eligible, not yet dispatched", detail: track.sliceId ?? "", start: w.start, end: known(w.end) };
  }
  return { ref: track.ref, trackId: track.id, title: track.ticketId ?? track.title, detail: track.title, start: t, end: t };
}
