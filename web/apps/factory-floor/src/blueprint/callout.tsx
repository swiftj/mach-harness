/**
 * A callout on the drawing that stays readable where the camera has put it (findings N3): the note is
 * drawn on its preferred side, and when that would put it under the pinned gutter, under the pinned
 * column head, under a drawer or under the corner that holds the overview and the zoom toolbar, it
 * flips to the other side, comes down to just below the column head, or flips below its mark,
 * whichever is first to fit in the clear part of the stage (ClearContext). A note whose mark has
 * gone behind the pinned gutter is not drawn until the mark comes back out. Placement is interface
 * state read from the camera, like the pinned gutter; what the note says is still a function of the
 * playhead.
 */
import { useContext, useLayoutEffect, useRef, useState } from "react";
import { Callout } from "@mach/ui";
import { ClearContext, type ClearArea } from "./context";

export interface PlacedCalloutProps {
  /** The mark the note is about, in the parent's coordinates. */
  cx: number;
  cy: number;
  /** Where the leader starts on the mark, and where its elbow is, on the preferred side. */
  ox: number;
  oy: number;
  dx: number;
  dy: number;
  text: string;
  detail?: string;
  tone?: "ink" | "select" | "fail" | "human";
}

type Vertical = "as-drawn" | "lowered" | "mirrored";

interface Placement {
  readonly flip: boolean;
  readonly vertical: Vertical;
  /** The elbow's dy when lowered. */
  readonly dy: number;
  /** The mark is behind the pinned gutter: its note would be cut whichever side it took, so it waits. */
  readonly behind: boolean;
}

const PREFERRED: Placement = { flip: false, vertical: "as-drawn", dy: 0, behind: false };
const same = (a: Placement, b: Placement): boolean => a.flip === b.flip && a.vertical === b.vertical && a.dy === b.dy && a.behind === b.behind;

/** Bold 10.5 px note and 9.5 px detail, as the grammar's Callout sets them. */
const LINE = { above: 6, note: 6, detail: 19 } as const;
/** The highest a lowered note's elbow may sit: level with the mark, beside it. */
const LOWEST_ELBOW = -14;

/** The note's extent around the leader's start, in local units, for one placement. */
function extent(dir: 1 | -1, dy: number, textW: number, dxAbs: number, detail: boolean): { x0: number; x1: number; y0: number; y1: number } {
  const reach = dxAbs + 18 + textW;
  const y0 = Math.min(-2, dy - LINE.above);
  const y1 = Math.max(2, dy + (detail ? LINE.detail : LINE.note));
  return dir > 0 ? { x0: -2, x1: reach, y0, y1 } : { x0: -reach, x1: 2, y0, y1 };
}

/** Area of a screen rectangle that lies outside the clear part of the stage (0: fully readable). */
function hidden(r: { x0: number; x1: number; y0: number; y1: number }, clear: ClearArea): number {
  const w = r.x1 - r.x0;
  const h = r.y1 - r.y0;
  const ix = Math.max(0, Math.min(r.x1, clear.right) - Math.max(r.x0, clear.left));
  const iy = Math.max(0, Math.min(r.y1, clear.bottom) - Math.max(r.y0, clear.top));
  let out = w * h - ix * iy;
  if (clear.corner) {
    const cx = Math.max(0, Math.min(r.x1, clear.right) - Math.max(r.x0, clear.corner.left));
    const cy = Math.max(0, Math.min(r.y1, clear.bottom) - Math.max(r.y0, clear.corner.top));
    out += cx * cy;
  }
  return out;
}

export function PlacedCallout({ cx, cy, ox, oy, dx, dy, text, detail, tone }: PlacedCalloutProps) {
  const clear = useContext(ClearContext);
  const ref = useRef<SVGGElement>(null);
  const [place, setPlace] = useState<Placement>(PREFERRED);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !clear) return;
    // The note's width does not depend on its side. Measured as drawn (getBBox), at each decision: the
    // interface font may load after the note first appears, and getComputedTextLength under-reports it.
    const width = (): number => {
      let w = 0;
      for (const t of el.querySelectorAll("text")) w = Math.max(w, t.getBBox().width);
      return w;
    };
    const dxAbs = Math.abs(dx);
    const pref: 1 | -1 = dx >= 0 ? 1 : -1;
    let raf = 0;
    const decide = (): void => {
      raf = 0;
      const area = clear.get();
      const m = el.getScreenCTM();
      const textW = width();
      if (!area || !m || !textW) return;
      const toScreen = (ax: number, ay: number, e: ReturnType<typeof extent>) => ({ x0: m.e + (ax + e.x0) * m.a, x1: m.e + (ax + e.x1) * m.a, y0: m.f + (ay + e.y0) * m.d, y1: m.f + (ay + e.y1) * m.d });
      const markX = m.e + cx * m.a;
      const markY = m.f + cy * m.d;
      // Behind the pinned gutter the mark cannot be seen and any side of its note would be cut.
      if (markX < area.left) {
        setPlace((p) => (p.behind ? p : { ...p, behind: true }));
        return;
      }
      // A mark that is off the stage keeps its note as it is: nothing to read, nothing to move.
      if (markX > area.right + 40 || markY < area.top - 40 || markY > area.bottom + 40) {
        setPlace((p) => (p.behind ? { ...p, behind: false } : p));
        return;
      }
      const candidates: Placement[] = [];
      for (const flip of [false, true]) candidates.push({ flip, vertical: "as-drawn", dy, behind: false });
      if (dy < LOWEST_ELBOW) {
        // Just below the column head: the elbow's top at the clear top, never lower than level with the mark.
        const ay = cy + oy;
        const need = (area.top + 4 - (m.f + ay * m.d)) / m.d + LINE.above;
        if (need > dy && need <= LOWEST_ELBOW) for (const flip of [false, true]) candidates.push({ flip, vertical: "lowered", dy: Math.round(need), behind: false });
      }
      for (const flip of [false, true]) candidates.push({ flip, vertical: "mirrored", dy: -dy, behind: false });
      let best: Placement = candidates[0]!;
      let bestHidden = Infinity;
      for (const c of candidates) {
        const dir = (c.flip ? -pref : pref) as 1 | -1;
        const ax = cx + (c.flip ? -ox : ox);
        const ay = cy + (c.vertical === "mirrored" ? -oy : oy);
        const h = hidden(toScreen(ax, ay, extent(dir, c.dy, textW, dxAbs, Boolean(detail))), area);
        if (h < bestHidden - 1) {
          best = c;
          bestHidden = h;
        }
        if (h <= 0) break;
      }
      const next: Placement = best.flip === false && best.vertical === "as-drawn" ? PREFERRED : best;
      setPlace((p) => (same(p, next) ? p : next));
    };
    const schedule = (): void => {
      if (!raf) raf = requestAnimationFrame(decide);
    };
    decide();
    const off = clear.subscribe(schedule);
    return () => {
      off();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [clear, cx, cy, ox, oy, dx, dy, text, detail]);

  const ax = cx + (place.flip ? -ox : ox);
  const ay = cy + (place.vertical === "mirrored" ? -oy : oy);
  const edy = place.vertical === "as-drawn" ? dy : place.dy;
  return (
    <g ref={ref} style={{ visibility: place.behind ? "hidden" : undefined }}>
      <Callout x={ax} y={ay} dx={place.flip ? -dx : dx} dy={edy} text={text} detail={detail} tone={tone} />
    </g>
  );
}
