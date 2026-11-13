/**
 * Where a cell flow's callouts stand (a refused verdict, a rejection, the human gate's note, an
 * outvoted blocker), decided by the Atlas's placement pass (`placeUpright`, atlas/place.ts) in the
 * flow's own coordinates: every station's and gate's mark and its printed label are placed first as
 * fixed boxes, then each callout takes its first candidate position whose note covers no mark, no
 * label and no callout placed before it. Before this a callout could print over a neighbouring gate's
 * label in a live flow, where labels carry longer sub-lines (counts, reason codes, UTC times).
 *
 * A pure function of the flow and the callouts' text, so the same playhead always gives the same
 * placement. Widths are estimated from the text (the sheet's fixed type sizes), not measured: the pass
 * runs before anything is drawn. The camera-side adjustment (PlacedCallout: the pinned gutter, the
 * column head, the corner) still applies on top of the position chosen here.
 */
import { placeUpright, type Box, type Upright } from "../atlas/place";
import type { Flow, FlowNode } from "./flow";

export interface Spot {
  readonly ox: number;
  readonly oy: number;
  readonly dx: number;
  readonly dy: number;
}

export interface CalloutWish {
  /** Stable key: `g:<gate id>` or `o:<round>:<seat index>`. */
  readonly key: string;
  /** The mark it is about, in flow coordinates. */
  readonly cx: number;
  readonly cy: number;
  /** The preferred position (as the caller drew it before the pass). */
  readonly pref: Spot;
  readonly text: string;
  readonly detail?: string;
}

/** Bold 10.5 px sans and 9.5 px sans, per character (the sheet's type: Source Sans 3). */
const NOTE_CH = 5.9;
const DETAIL_CH = 5.0;
const LABEL_CH = 5.8;
const SUB_CH = 5.2;

function noteBox(w: CalloutWish, s: Spot): { box: Box } {
  const ax = w.cx + s.ox;
  const ay = w.cy + s.oy;
  const ex = ax + s.dx;
  const ey = ay + s.dy;
  const dir = s.dx >= 0 ? 1 : -1;
  const textW = Math.max(w.text.length * NOTE_CH, (w.detail?.length ?? 0) * DETAIL_CH);
  const reach = 18 + textW;
  const box = dir > 0 ? { x0: ex, x1: ex + reach, y0: ey - 9, y1: ey + (w.detail ? 19 : 5) } : { x0: ex - reach, x1: ex, y0: ey - 9, y1: ey + (w.detail ? 19 : 5) };
  // No leader in the slot: it starts on the callout's own mark, which is one of the fixed boxes.
  return { box };
}

/** The candidate positions, in order of preference: as drawn, the other side, higher, then below. */
function candidates(p: Spot): Spot[] {
  const flip = (s: Spot): Spot => ({ ...s, ox: -s.ox, dx: -s.dx });
  const up = { ...p, dy: p.dy - 26 };
  const below = { ox: p.ox, oy: -p.oy, dx: p.dx, dy: Math.abs(p.dy) + 34 };
  return [p, flip(p), up, flip(up), below, flip(below)];
}

/** The fixed boxes of a flow: each node's mark, and the label printed under it. */
export function flowBoxes(flow: Flow, labels: (n: FlowNode) => { text: string; sub?: string } | null): Box[] {
  const out: Box[] = [];
  for (const n of flow.nodes) {
    out.push({ x0: n.x - n.r - 2, x1: n.x + n.r + 2, y0: n.y - n.r - 2, y1: n.y + n.r + 2 });
    const l = labels(n);
    if (!l) continue;
    const w = Math.max(l.text.length * LABEL_CH, (l.sub?.length ?? 0) * SUB_CH) / 2 + 2;
    const top = n.kind === "gate" ? n.y + 22 : n.y + 16;
    out.push({ x0: n.x - w, x1: n.x + w, y0: top, y1: top + (l.sub ? 28 : 15) });
  }
  return out;
}

/**
 * The position of each callout: fixed boxes first (never covered when a clear candidate exists),
 * then the callouts in the order given, each clear of those placed before it.
 */
export function placeCallouts(fixed: readonly Box[], wishes: readonly CalloutWish[]): ReadonlyMap<string, Spot> {
  const items: Upright[] = fixed.map((b, i) => ({ key: `fixed${i}`, anchor: { x: b.x0, y: b.y0 }, slots: [{ box: b }], soft: [] }));
  const options: Spot[][] = [];
  for (const w of wishes) {
    const spots = candidates(w.pref);
    options.push(spots);
    items.push({ key: w.key, anchor: { x: w.cx, y: w.cy }, slots: spots.map((s) => noteBox(w, s)), soft: [] });
  }
  const chosen = placeUpright(items, null);
  const out = new Map<string, Spot>();
  wishes.forEach((w, i) => {
    const at = chosen[fixed.length + i] ?? 0;
    out.set(w.key, options[i]![at] ?? w.pref);
  });
  return out;
}
