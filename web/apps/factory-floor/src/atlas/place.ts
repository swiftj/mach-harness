/**
 * One deterministic placement pass for the Atlas's upright labels (callouts, the selection's label,
 * agents' labels): findings D7. A pure function of the labels offered, in the order offered, and the
 * visible stage, so the same playhead and camera always give the same placement. Nothing is
 * remembered between frames: a label keeps its slot for as long as the inputs that decided it (the
 * set of labels, their anchors, and the stage, which the view quantises) are unchanged, and labels
 * whose boxes would otherwise breathe (an agent's elapsed time) reserve their widest text, so time
 * passing alone never moves a label.
 *
 * Every box is in projected units (the overlay's own coordinates).
 */

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** The stage as seen by the camera, inset by the sheet's margin, and the camera toolbar in its corner. */
export interface Stage extends Box {
  controls: Box | null;
}

export interface Slot {
  /** The label's text, padded. */
  box: Box;
  /** A leader from the anchor to the label, if any: it must not cross another label either. */
  leader?: { x0: number; y0: number; x1: number; y1: number };
}

export interface Upright {
  key: string;
  /** Where the label points; a label whose anchor is off the stage need not fit on it. */
  anchor: { x: number; y: number };
  /** Allowed positions, in order of preference. At least one. */
  slots: Slot[];
  /** What it should leave clear when it can (machines, gates, agents, flags); other labels are never optional. */
  soft: Box[];
}

export const hits = (a: Box, b: Box) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

export const inside = (b: Box, v: Stage) => b.x0 >= v.x0 && b.x1 <= v.x1 && b.y0 >= v.y0 && b.y1 <= v.y1 && !(v.controls && hits(b, v.controls));

const contains = (v: Box, p: { x: number; y: number }) => v.x0 <= p.x && p.x <= v.x1 && v.y0 <= p.y && p.y <= v.y1;

function area(a: Box, b: Box): number {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  return w > 0 && h > 0 ? w * h : 0;
}

/** Whether a leader (a straight segment) crosses a box; its first and last eighth are ignored (anchor and shoulder). */
function crosses(l: NonNullable<Slot["leader"]>, b: Box): boolean {
  for (let i = 1; i < 8; i++) {
    const f = i / 8;
    if (contains(b, { x: l.x0 + (l.x1 - l.x0) * f, y: l.y0 + (l.y1 - l.y0) * f })) return true;
  }
  return false;
}

/**
 * Place each label in turn: take its first slot that covers no label already placed and stays on the
 * stage, preferring one that also leaves its soft obstacles clear. Rank, best first:
 *   0  clear of labels, on the stage, clear of soft obstacles;
 *   1  clear of labels, on the stage, covering the fewest soft obstacles;
 *   2  clear of labels (only when no slot fits the stage);
 *   3  the slot covering the least label area (no slot is clear at all).
 * Rank 2 also prefers the fewest soft obstacles. Ties go to the earlier slot. Returns the chosen slot index per label, in the order given.
 */
export function placeUpright(items: Upright[], stage: Stage | null): number[] {
  const placed: Box[] = [];
  const out: number[] = [];
  for (const item of items) {
    const onStage = !stage || contains(stage, item.anchor);
    let best = 0;
    let bestRank = Infinity;
    let bestCost = Infinity;
    item.slots.forEach((s, i) => {
      const overlap = placed.reduce((sum, p) => sum + area(p, s.box) + (s.leader && crosses(s.leader, p) ? 1 : 0), 0);
      const within = !stage || !onStage || inside(s.box, stage);
      const soft = item.soft.reduce((n, o) => n + (hits(o, s.box) || (s.leader !== undefined && crosses(s.leader, o)) ? 1 : 0), 0);
      const rank = overlap > 0 ? 3 : !within ? 2 : soft > 0 ? 1 : 0;
      const cost = rank === 3 ? overlap + (within ? 0 : 1e9) : rank === 0 ? 0 : soft;
      if (rank < bestRank || (rank === bestRank && cost < bestCost)) {
        best = i;
        bestRank = rank;
        bestCost = cost;
      }
    });
    out.push(best);
    const chosen = item.slots[best]!;
    placed.push(chosen.box);
  }
  return out;
}
