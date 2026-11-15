/**
 * Spatial keyboard navigation for the Atlas (spec f.11): an arrow key moves focus to the nearest
 * entity in that direction on screen, ties broken by reading order. Pure: it takes the entities'
 * screen centres in reading order and returns an index.
 *
 * The rule: candidates lie in the 90° cone around the arrow's direction (|across| ≤ along), and the
 * nearest by distance wins. Every entity is therefore reachable: an entity is the nearest of all
 * to its own nearest neighbour, and it lies in one of that neighbour's four cones (they cover the
 * plane), so that neighbour's arrow leads to it. If the cone is empty, the nearest in the half-plane
 * (along > 0, weighted against going sideways) is taken, so an arrow still moves when something lies
 * that way. Entities drawn at the same point are stepped through in reading order: Right and Down go
 * to the next one, Left and Up to the previous one.
 */
export type Direction = "left" | "right" | "up" | "down";

const UNIT: Record<Direction, [number, number]> = { right: [1, 0], left: [-1, 0], down: [0, 1], up: [0, -1] };
/** Centres closer than this (px) count as the same point. */
const SAME = 0.5;
/** Scores within this (px) are a tie, decided by reading order. */
const TIE = 0.5;

export function nearestInDirection(points: ReadonlyArray<{ x: number; y: number }>, from: number, dir: Direction): number | null {
  const origin = points[from];
  if (!origin) return null;
  const [ux, uy] = UNIT[dir];
  const forward = dir === "right" || dir === "down";
  let same: number | null = null;
  let cone: { i: number; score: number } | null = null;
  let half: { i: number; score: number } | null = null;
  const better = (cur: { i: number; score: number } | null, i: number, score: number) => !cur || score < cur.score - TIE || (Math.abs(score - cur.score) <= TIE && i < cur.i);
  for (let i = 0; i < points.length; i++) {
    if (i === from) continue;
    const p = points[i]!;
    const dx = p.x - origin.x;
    const dy = p.y - origin.y;
    const dist = Math.hypot(dx, dy);
    if (dist < SAME) {
      // Same point: the next (or previous) in reading order.
      if (forward ? i > from && (same === null || i < same) : i < from && (same === null || i > same)) same = i;
      continue;
    }
    const along = dx * ux + dy * uy;
    if (along <= 0) continue;
    const across = Math.abs(dx * uy - dy * ux);
    if (across <= along) {
      if (better(cone, i, dist)) cone = { i, score: dist };
    } else {
      const score = along + 2 * across;
      if (better(half, i, score)) half = { i, score };
    }
  }
  if (same !== null) return same;
  return cone?.i ?? half?.i ?? null;
}
