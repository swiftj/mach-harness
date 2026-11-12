import { factoryTokens } from "../tokens/tokens";

/**
 * The factory's axonometric projection: a 2:1 dimetric drawing (26.565 degrees), the convention of a
 * plant drawing. Plan x runs down-right (the direction work flows), plan y runs down-left (across the
 * floor, cell after cell), z runs up. A plan unit along x or y keeps its length on screen; elevation
 * is drawn at `zScale`.
 *
 *   screen.x = (x - y) * cos
 *   screen.y = (x + y) * sin - z * zScale
 *
 * Flat things (ground, grid, routes, floor lettering) are drawn in plan coordinates inside a group
 * carrying `planeTransform(z)`. Upright things (posts, faces, heads, labels) are drawn in screen
 * space at `project(point)`. Both meet exactly, because they are the same matrix.
 */
const P = factoryTokens.projection;

export interface Vec2 {
  x: number;
  y: number;
}

export interface Vec3 {
  x: number;
  y: number;
  z?: number;
}

/** A box on the plan: footprint x, y, w (along x), d (along y); base z; height h. */
export interface PlanBox {
  x: number;
  y: number;
  w: number;
  d: number;
  z?: number;
  h?: number;
}

export function project(p: Vec3): Vec2 {
  return { x: (p.x - p.y) * P.cos, y: (p.x + p.y) * P.sin - (p.z ?? 0) * P.zScale };
}

/** The plan point at elevation `z` that projects to screen point `s` (for hit testing and zoom-to-cursor). */
export function unproject(s: Vec2, z = 0): Required<Vec3> {
  const a = s.x / P.cos; // x - y
  const b = (s.y + z * P.zScale) / P.sin; // x + y
  return { x: (a + b) / 2, y: (b - a) / 2, z };
}

/** The SVG/CSS matrix that draws plan coordinates on the plane at elevation `z`. */
export function planeMatrix(z = 0): [number, number, number, number, number, number] {
  return [P.cos, P.sin, -P.cos, P.sin, 0, -z * P.zScale];
}

/** `transform` attribute for a group of plan-coordinate drawing at elevation `z`. */
export function planeTransform(z = 0): string {
  return `matrix(${planeMatrix(z).join(" ")})`;
}

/**
 * Strokes inside a plane group are drawn 0.8x as thick on screen (the matrix's determinant over the
 * axis length). Multiply plan stroke widths by this to get the screen width you meant.
 */
export const planeStroke = 1 / (2 * P.cos * P.sin);

/**
 * `transform` for an upright card standing on plan line y = `at.y`, facing the viewer, with its local
 * origin at its top-left corner: u runs along plan x, v runs down. Used for artifact cards and plaques.
 */
export function uprightTransform(at: Vec3, height: number): string {
  const top = project({ x: at.x, y: at.y, z: (at.z ?? 0) + height });
  return `matrix(${P.cos} ${P.sin} 0 ${P.zScale} ${round(top.x)} ${round(top.y)})`;
}

/** As `uprightTransform`, for a card standing on plan line x = `at.x`, its face along plan y. */
export function uprightTransformY(at: Vec3, height: number): string {
  const top = project({ x: at.x, y: at.y, z: (at.z ?? 0) + height });
  return `matrix(${-P.cos} ${P.sin} 0 ${P.zScale} ${round(top.x)} ${round(top.y)})`;
}

export function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** SVG `points` from screen points. */
export function toPoints(list: readonly Vec2[]): string {
  return list.map((p) => `${round(p.x)},${round(p.y)}`).join(" ");
}

/** SVG `points` for plan points projected at their own elevation. */
export function projectPoints(list: readonly Vec3[]): string {
  return toPoints(list.map(project));
}

/** Path data for a projected polyline. */
export function projectPath(list: readonly Vec3[], closed = false): string {
  const d = list.map((p, i) => {
    const s = project(p);
    return `${i === 0 ? "M" : "L"}${round(s.x)} ${round(s.y)}`;
  });
  return d.join(" ") + (closed ? "Z" : "");
}

/** The three visible faces of a box, in screen points. Light comes from the upper left (plan -x, +y). */
export function prismFaces(box: PlanBox): { top: Vec2[]; lit: Vec2[]; shade: Vec2[]; footprint: Vec2[] } {
  const z0 = box.z ?? 0;
  const z1 = z0 + (box.h ?? 0);
  const { x, y, w, d } = box;
  return {
    top: [
      project({ x, y, z: z1 }),
      project({ x: x + w, y, z: z1 }),
      project({ x: x + w, y: y + d, z: z1 }),
      project({ x, y: y + d, z: z1 }),
    ],
    // The face toward plan +y (screen lower left) catches the light.
    lit: [
      project({ x, y: y + d, z: z1 }),
      project({ x: x + w, y: y + d, z: z1 }),
      project({ x: x + w, y: y + d, z: z0 }),
      project({ x, y: y + d, z: z0 }),
    ],
    // The face toward plan +x (screen lower right) is in shade.
    shade: [
      project({ x: x + w, y, z: z1 }),
      project({ x: x + w, y: y + d, z: z1 }),
      project({ x: x + w, y: y + d, z: z0 }),
      project({ x: x + w, y, z: z0 }),
    ],
    footprint: [project({ x, y, z: z0 }), project({ x: x + w, y, z: z0 }), project({ x: x + w, y: y + d, z: z0 }), project({ x, y: y + d, z: z0 })],
  };
}

/**
 * The contact shadow of a box: its footprint swept away from the light, by a length proportional to
 * its height. A flat polygon on the plane below the box, in plan coordinates.
 */
export function shadowPolygon(box: PlanBox): Vec3[] {
  const h = box.h ?? 0;
  const ox = h * 0.5;
  const oy = -h * 0.18;
  const z = box.z ?? 0;
  const { x, y, w, d } = box;
  return [
    { x, y, z },
    { x: x + ox, y: y + oy, z },
    { x: x + w + ox, y: y + oy, z },
    { x: x + w + ox, y: y + d + oy, z },
    { x: x + w, y: y + d, z },
    { x, y: y + d, z },
  ];
}

/** Depth for the painter's sort: larger is nearer the viewer. Draw in ascending order. */
export function depthOf(p: Vec3): number {
  return p.x + p.y + (p.z ?? 0) * 0.01;
}

/** Screen bounds of a set of plan boxes, for camera framing. */
export function screenBounds(boxes: readonly PlanBox[], pad = 0): { x: number; y: number; width: number; height: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const b of boxes) {
    const f = prismFaces(b);
    for (const p of [...f.top, ...f.footprint]) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: minX - pad, y: minY - pad, width: maxX - minX + pad * 2, height: maxY - minY + pad * 2 };
}
