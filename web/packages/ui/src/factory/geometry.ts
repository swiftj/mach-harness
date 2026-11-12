import { round, type Vec2, type Vec3 } from "./projection";

/**
 * Polyline geometry for routes. Pure functions over plan (or screen) points. Routes are orthogonal
 * polylines; a packet's position on a route is `pointAlong(points, progress)`.
 */

function dist(a: Vec3, b: Vec3): number {
  return Math.hypot(b.x - a.x, b.y - a.y, (b.z ?? 0) - (a.z ?? 0));
}

export function polylineLength(points: readonly Vec3[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += dist(points[i - 1]!, points[i]!);
  return total;
}

/** The point at fraction `t` (0..1) of the polyline's length, and its heading in radians on the plan. */
export function pointAlong(points: readonly Vec3[], t: number): { point: Required<Vec3>; angle: number } {
  const first = points[0] ?? { x: 0, y: 0, z: 0 };
  if (points.length < 2) return { point: { x: first.x, y: first.y, z: first.z ?? 0 }, angle: 0 };
  const target = Math.min(1, Math.max(0, t)) * polylineLength(points);
  let run = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const len = dist(a, b);
    if (run + len >= target || i === points.length - 1) {
      const f = len === 0 ? 0 : Math.min(1, (target - run) / len);
      return {
        point: { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, z: (a.z ?? 0) + ((b.z ?? 0) - (a.z ?? 0)) * f },
        angle: Math.atan2(b.y - a.y, b.x - a.x),
      };
    }
    run += len;
  }
  const last = points[points.length - 1]!;
  return { point: { x: last.x, y: last.y, z: last.z ?? 0 }, angle: 0 };
}

/** The part of the polyline between fractions `from` and `to` of its length. */
export function slicePolyline(points: readonly Vec3[], from: number, to: number): Vec3[] {
  if (points.length < 2 || to <= from) return [];
  const total = polylineLength(points);
  const a = Math.max(0, from) * total;
  const b = Math.min(1, to) * total;
  const out: Vec3[] = [pointAlong(points, from).point];
  let run = 0;
  for (let i = 1; i < points.length; i++) {
    run += dist(points[i - 1]!, points[i]!);
    if (run > a && run < b) out.push(points[i]!);
  }
  out.push(pointAlong(points, to).point);
  return out;
}

/** A parallel polyline at distance `d` to the left of travel (on the plan), with mitred corners. */
export function offsetPolyline(points: readonly Vec3[], d: number): Vec3[] {
  if (points.length < 2) return [...points];
  const normals: Vec2[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    normals.push({ x: -(b.y - a.y) / len, y: (b.x - a.x) / len });
  }
  return points.map((p, i) => {
    const n0 = normals[Math.max(0, i - 1)]!;
    const n1 = normals[Math.min(normals.length - 1, i)]!;
    const mx = n0.x + n1.x;
    const my = n0.y + n1.y;
    const ml = Math.hypot(mx, my) || 1;
    const ux = mx / ml;
    const uy = my / ml;
    const cos = ux * n1.x + uy * n1.y || 1;
    const k = d / cos;
    return { x: p.x + ux * k, y: p.y + uy * k, z: p.z ?? 0 };
  });
}

/** Path data for a 2D polyline with its corners rounded to radius `r`. Uses x and y only. */
export function roundedPath(points: readonly Vec2[], r = 6): string {
  if (points.length === 0) return "";
  const p0 = points[0]!;
  let d = `M${round(p0.x)} ${round(p0.y)}`;
  for (let i = 1; i < points.length - 1; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const c = points[i + 1]!;
    const l1 = Math.hypot(b.x - a.x, b.y - a.y);
    const l2 = Math.hypot(c.x - b.x, c.y - b.y);
    const k = Math.min(r, l1 / 2, l2 / 2);
    if (k <= 0.01) {
      d += ` L${round(b.x)} ${round(b.y)}`;
      continue;
    }
    const s = { x: b.x - ((b.x - a.x) / l1) * k, y: b.y - ((b.y - a.y) / l1) * k };
    const e = { x: b.x + ((c.x - b.x) / l2) * k, y: b.y + ((c.y - b.y) / l2) * k };
    d += ` L${round(s.x)} ${round(s.y)} Q${round(b.x)} ${round(b.y)} ${round(e.x)} ${round(e.y)}`;
  }
  const last = points[points.length - 1]!;
  if (points.length > 1) d += ` L${round(last.x)} ${round(last.y)}`;
  return d;
}

/** Evenly spaced stations along a polyline (for direction chevrons and sleepers): every `step` units from `start`. */
export function marksAlong(points: readonly Vec3[], step: number, start = step / 2): Array<{ point: Required<Vec3>; angle: number }> {
  const total = polylineLength(points);
  if (total === 0 || step <= 0) return [];
  const out: Array<{ point: Required<Vec3>; angle: number }> = [];
  for (let s = start; s <= total - 2; s += step) out.push(pointAlong(points, s / total));
  return out;
}

/** Sample a 3D quadratic arc lifted `lift` units above the straight line from `a` to `b`. */
export function liftedArc(a: Vec3, b: Vec3, lift: number, samples = 24): Required<Vec3>[] {
  const out: Required<Vec3>[] = [];
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const za = a.z ?? 0;
    const zb = b.z ?? 0;
    out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: za + (zb - za) * t + lift * 4 * t * (1 - t) });
  }
  return out;
}
